import {
  assessRouteResult,
  type ArbPathLike,
  type AssessmentOptimizationOptions,
  type AssessmentLike,
  type CandidateEntry,
  type ExecutableCandidate,
  type RouteResultLike,
} from "../arb/assessment.ts";
import { createOpportunityEngine } from "../arb/opportunity_engine.ts";
import {
  MAX_PATHS_TO_OPTIMIZE,
  POLYGON_RPC,
  WORKER_COUNT,
  ENABLE_PREDICTIVE_CACHE,
  PREDICTIVE_CACHE_MAX_PATHS,
  PREDICTIVE_CACHE_PRECOMPUTE_N,
  PREDICTIVE_CACHE_STALENESS_MS,
} from "../config/index.ts";
import { evaluateCandidatePipeline } from "../routing/candidate_pipeline.ts";
import { partitionFreshCandidates } from "../routing/filter_fresh_candidates.ts";
import { routeKeyFromEdges } from "../routing/finder.ts";
import { evaluatePathsParallel, optimizeInputAmount, simulateRoute } from "../routing/simulator.ts";
import { buildArbTx } from "../execution/build_tx.ts";
import { hasTrackedPendingTx, getPendingPools, sendTx, sendTxBundle, type NonceManagerLike } from "../execution/send_tx.ts";
import { scalePriorityFeeByProfitMargin } from "../execution/gas.ts";
import type { RuntimeStateCache } from "../app/runner.ts";
import type { PoolRecord } from "../state/warmup.ts";
import { deriveOnChainMinProfit, type ExecutionQuarantine } from "./helpers.ts";
import { PredictiveCacheAdapter, createPredictiveCacheAdapter, type PredictiveCacheAdapterDeps } from "../routing/predictive_cache_adapter.ts";
import { RouteCache } from "../routing/route_cache.ts";
import { logger } from "../utils/logger.ts";

type FeeSnapshot = {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  effectiveGasPriceWei?: bigint;
  updatedAt?: number;
} | null;

type LoggerFn = (msg: string, level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace", meta?: unknown) => void;

type RunnerOpportunityEngineDeps = {
  liveMode: boolean;
  privateKey: string | null;
  executorAddress: string | null;
  rpcUrl?: string;
  getNonceManager: () => NonceManagerLike | null | undefined;
  maxExecutionBatch: number;
  executionRouteQuarantineMs: number;
  minProfitWei: bigint;
  flashLoanFeeBps?: bigint;
  log: LoggerFn;
  fmtPath: (path: ArbPathLike) => string;
  getRouteFreshness: (path: ArbPathLike) => { ok: boolean; reason?: string; ageMs?: number; skewMs?: number };
  getCurrentFeeSnapshot: () => Promise<FeeSnapshot>;
  getFreshTokenToMaticRate: (tokenAddress: string) => bigint;
  onPreparedCandidateError: (candidate: CandidateEntry, reason: string, quarantine: ExecutionQuarantine) => void;
  cachedCycles: () => ArbPathLike[];
  topologyDirty: () => boolean;
  refreshCycles: () => Promise<ArbPathLike[] | void>;
  passCount: () => number;
  maxPathsToOptimize?: number;
  stateCache: RuntimeStateCache;
  getProbeAmountsForToken: (tokenAddress: string) => bigint[];
  routeCacheUpdate: (candidates: CandidateEntry[]) => void;
  routeCacheRemove: (path: ArbPathLike, reason: string) => number | void;
  fmtProfit: (netWei: bigint, tokenAddr: string) => string;
  onPathsEvaluated: (count: number) => void;
  onCandidateMetrics: (metrics: {
    candidateCount: number;
    topCandidates: number;
    optimizedCandidates: number;
    profitableRoutes: number;
  }) => void;
  onArbsFound: (count: number) => void;
  workerCount?: number;
  getAffectedRoutes: (changedPools: Set<string>) => Array<{ path: ArbPathLike; result: RouteResultLike }> | Promise<Array<{ path: ArbPathLike; result: RouteResultLike }>>;
  testAmountWei: bigint;
  getPoolRecord?: (poolAddress: string) => PoolRecord | null | undefined;
  fetchAndCacheStates?: (pools: PoolRecord[], options?: Record<string, unknown>) => Promise<unknown>;
  routeCache?: RouteCache;
};

function uniqueRoutePools(path: ArbPathLike) {
  const unique = new Map<string, string>();
  for (const edge of path.edges ?? []) {
    const pool = String(edge.poolAddress ?? "").toLowerCase();
    if (pool) unique.set(pool, String(edge.poolAddress));
  }
  return [...unique.values()];
}

async function refreshCandidateBeforeExecution(
  deps: RunnerOpportunityEngineDeps,
  candidate: ExecutableCandidate,
  context: { gasPriceWei: bigint; tokenToMaticRate: bigint },
) {
  if (!deps.getPoolRecord || !deps.fetchAndCacheStates) return candidate;

  const pools: PoolRecord[] = [];
  for (const poolAddress of uniqueRoutePools(candidate.path)) {
    const record = deps.getPoolRecord(poolAddress);
    if (!record) {
      return { candidate: null, reason: "pre-execution route refresh missing pool record" };
    }
    pools.push(record);
  }

  await deps.fetchAndCacheStates(pools, {
    blockTag: "pending",
    logContext: {
      label: "Pre-execution route refresh",
      eventPrefix: "pre_execution_route_refresh",
    },
  });

  const freshness = deps.getRouteFreshness(candidate.path);
  if (!freshness.ok) {
    return { candidate: null, reason: freshness.reason ?? "pre-execution route refresh produced stale state" };
  }

  const refreshedResult = simulateRoute(candidate.path, candidate.result.amountIn, deps.stateCache);
  const refreshedAssessment = assessRouteResult(
    candidate.path,
    refreshedResult,
    context.gasPriceWei,
    context.tokenToMaticRate,
    { minProfitWei: deps.minProfitWei, flashLoanFeeBps: deps.flashLoanFeeBps },
  );

  if (!refreshedResult.profitable || !refreshedAssessment.shouldExecute) {
    return {
      candidate: null,
      reason: refreshedAssessment.rejectReason
        ? `pre-execution route no longer executable after pending-state refresh: ${refreshedAssessment.rejectReason}`
        : "pre-execution route no longer profitable after pending-state refresh",
    };
  }

  return {
    ...candidate,
    result: refreshedResult,
    assessment: refreshedAssessment,
  };
}

export function buildRunnerOpportunityEngineConfig(deps: RunnerOpportunityEngineDeps): Parameters<typeof createOpportunityEngine>[0] {
  return {
    execution: {
      liveMode: deps.liveMode,
      privateKey: deps.privateKey,
      executorAddress: deps.executorAddress,
      rpcUrl: deps.rpcUrl ?? POLYGON_RPC,
      getNonceManager: deps.getNonceManager,
      maxExecutionBatch: deps.maxExecutionBatch,
      executionRouteQuarantineMs: deps.executionRouteQuarantineMs,
      minProfitWei: deps.minProfitWei,
      flashLoanFeeBps: deps.flashLoanFeeBps,
      log: deps.log,
      fmtPath: deps.fmtPath,
      getRouteFreshness: deps.getRouteFreshness,
      getCurrentFeeSnapshot: deps.getCurrentFeeSnapshot,
      getFreshTokenToMaticRate: deps.getFreshTokenToMaticRate,
      deriveOnChainMinProfit: (assessment, tokenToMaticRate) =>
        deriveOnChainMinProfit(assessment as AssessmentLike | null | undefined, tokenToMaticRate, deps.minProfitWei),
      buildArbTx,
      sendTx,
      sendTxBundle,
      getPendingPools,
      scalePriorityFeeByProfitMargin,
      refreshCandidateBeforeExecution: (candidate, context) =>
        refreshCandidateBeforeExecution(deps, candidate, context),
      onPreparedCandidateError: deps.onPreparedCandidateError,
    },
    search: {
      cachedCycles: deps.cachedCycles,
      topologyDirty: deps.topologyDirty,
      refreshCycles: deps.refreshCycles,
      passCount: deps.passCount,
      maxPathsToOptimize: deps.maxPathsToOptimize ?? MAX_PATHS_TO_OPTIMIZE,
      minProfitWei: deps.minProfitWei,
      flashLoanFeeBps: deps.flashLoanFeeBps,
      stateCache: deps.stateCache,
      log: deps.log,
      getCurrentFeeSnapshot: deps.getCurrentFeeSnapshot,
      getFreshTokenToMaticRate: deps.getFreshTokenToMaticRate,
      getRouteFreshness: deps.getRouteFreshness,
      getProbeAmountsForToken: deps.getProbeAmountsForToken,
      evaluatePathsParallel,
      optimizeInputAmount: (path: ArbPathLike, cache: RuntimeStateCache, options: AssessmentOptimizationOptions) =>
        optimizeInputAmount(path, cache, options),
      evaluateCandidatePipeline,
      partitionFreshCandidates,
      routeCacheUpdate: deps.routeCacheUpdate,
      routeKeyFromEdges,
      getPoolRecord: deps.getPoolRecord,
      fetchAndCacheStates: deps.fetchAndCacheStates,
      fmtPath: deps.fmtPath,
      fmtProfit: deps.fmtProfit,
      onPathsEvaluated: deps.onPathsEvaluated,
      onCandidateMetrics: deps.onCandidateMetrics,
      onArbsFound: deps.onArbsFound,
      workerCount: deps.workerCount ?? WORKER_COUNT,
    },
    revalidation: {
      getAffectedRoutes: deps.getAffectedRoutes,
      routeKeyFromEdges,
      stateCache: deps.stateCache,
      testAmountWei: deps.testAmountWei,
      minProfitWei: deps.minProfitWei,
      flashLoanFeeBps: deps.flashLoanFeeBps,
      maxExecutionBatch: deps.maxExecutionBatch,
      log: deps.log,
      getCurrentFeeSnapshot: deps.getCurrentFeeSnapshot,
      getFreshTokenToMaticRate: deps.getFreshTokenToMaticRate,
      getRouteFreshness: deps.getRouteFreshness,
      simulateRoute: (path: ArbPathLike, amountIn: bigint, cache: RuntimeStateCache) =>
        simulateRoute(path, amountIn, cache),
      optimizeInputAmount: (path: ArbPathLike, cache: RuntimeStateCache, options: AssessmentOptimizationOptions) =>
        optimizeInputAmount(path, cache, options),
      routeCacheUpdate: (candidates) => deps.routeCacheUpdate(candidates),
      routeCacheRemove: deps.routeCacheRemove,
    },
  };
}

export function createRunnerOpportunityEngine(deps: RunnerOpportunityEngineDeps) {
  return createOpportunityEngine(buildRunnerOpportunityEngineConfig(deps));
}

/**
 * Create opportunity engine with predictive cache integration.
 * The predictive cache provides:
 *   - Shadow state of top-N routes with pre-computed profitability assessments
 *   - Event-driven staleness marking when pool state changes
 *   - Idle-time batch prefetching for fresh assessments
 *
 * When predictive cache is enabled and properly initialized, getAffectedRoutes
 * returns pre-computed results with full assessment data, avoiding re-simulation
 * on fast-revalidation paths.
 */
export function createRunnerOpportunityEngineWithPredictiveCache(deps: RunnerOpportunityEngineDeps) {
  let predictiveCacheAdapter: PredictiveCacheAdapter | null = null;

  if (ENABLE_PREDICTIVE_CACHE && deps.routeCache) {
    try {
      const adapterDeps: PredictiveCacheAdapterDeps = {
        routeCache: deps.routeCache,
        testAmountWei: deps.testAmountWei,
        maxTrackedPaths: PREDICTIVE_CACHE_MAX_PATHS,
        precomputeTopN: PREDICTIVE_CACHE_PRECOMPUTE_N,
        stalenessThresholdMs: PREDICTIVE_CACHE_STALENESS_MS,
        usePredictiveCache: ENABLE_PREDICTIVE_CACHE,
      };

      predictiveCacheAdapter = createPredictiveCacheAdapter(adapterDeps);

      predictiveCacheAdapter.setStateCache(deps.stateCache);

      const wrappedGetAffectedRoutes = (changedPools: Set<string>) => {
        const predictiveRoutes = predictiveCacheAdapter!.getAffectedRoutes(changedPools);
        if (predictiveRoutes.length > 0) {
          return predictiveRoutes;
        }
        // Use the ORIGINAL getAffectedRoutes (captured before replacement)
        return originalGetAffectedRoutes(changedPools);
      };
      const originalGetAffectedRoutes = deps.getAffectedRoutes;
      deps.getAffectedRoutes = wrappedGetAffectedRoutes;

      logger.info("[predictive-cache] Integrated into opportunity engine");
    } catch (error) {
      logger.error({ error }, "[predictive-cache] Failed to initialize, falling back to traditional");
    }
  }

  const engine = createOpportunityEngine(buildRunnerOpportunityEngineConfig(deps));

  return {
    engine,
    predictiveCacheAdapter,

    /**
     * Notify predictive cache of pool state changes so shadow entries are
     * marked stale. Called from watcher batch handler.
     */
    notifyPoolStateChanged(poolAddresses: Set<string>) {
      predictiveCacheAdapter?.notifyPoolStateChanged(poolAddresses);
    },

    /**
     * Pre-compute a batch of stale shadow entries during idle time.
     * Called after arb scan completes.
     */
    async prefetchIdleBatch(batchSize = 5) {
      return predictiveCacheAdapter?.prefetchBatch(batchSize) ?? 0;
    },

    async shutdown() {
      await predictiveCacheAdapter?.shutdown();
    },
  };
}
