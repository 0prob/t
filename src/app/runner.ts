import type { Level, Logger as PinoLogger } from "pino";
import {
  arbsFound,
  candidateOptimizedCount,
  candidateProfitableCount,
  candidateProfitableYield,
  candidateShortlistSize,
  pathsEvaluated,
  profitAccumulator,
  txAttempted,
  txReverted,
  txSuccessful,
} from "../utils/metrics.ts";
import {
  CYCLE_REFRESH_INTERVAL_MS,
  DB_PATH,
  DYNAMIC_PIVOT_TOKEN_LIMIT,
  ENVIO_API_TOKEN,
  EVAL_WORKER_THRESHOLD,
  MAX_CONSECUTIVE_ERRORS,
  MAX_TOTAL_PATHS,
  METRICS_PORT,
  ROUTE_CYCLE_CACHE_FILE,
  ROUTE_CYCLE_CACHE_MAX_AGE_MS,
  ROUTE_STATE_MAX_AGE_MS,
  ROUTE_STATE_MAX_SKEW_MS,
  ROUTING_CYCLE_MODE,
  ROUTING_MAX_HOPS,
  ROUTING_MIN_HOPS,
  SELECTIVE_4HOP_MAX_PATHS_PER_TOKEN,
  SELECTIVE_4HOP_PATH_BUDGET,
  SELECTIVE_4HOP_TOKEN_LIMIT,
  WORKER_COUNT,
} from "../config/index.ts";
import { fetchEIP1559Fees as defaultFetchFees, oracle as defaultGasOracle } from "../execution/gas.ts";
import { NonceManager } from "../execution/nonce_manager.ts";
import { PriceOracle, type PriceOracleRegistry } from "../arb/price_oracle.ts";
import { RegistryService } from "../db/registry.ts";
import { createRegistryRepositories, type RegistryRepositories } from "../db/repositories.ts";
import { RouteCache } from "../routing/route_cache.ts";
import { StateWatcher } from "../state/watcher.ts";
import { clearGasEstimateCache } from "../execution/gas.ts";
import { createArbActivityTracker } from "./helpers";
import { createArbScheduler, createShutdownHandler } from "../app/lifecycle.ts";
import { createBotTelemetry } from "./bot_telemetry.ts";
import { createCurrentFeeSnapshotReader, type FeeSnapshotLike } from "./helpers";
import { createDecimalAwarePoolStateFetchers } from "./helpers";
import { createHeartbeatController } from "./helpers";
import { createInitialBotState } from "./helpers";
import { createOperatorLogger } from "./helpers";
import { createPricingService } from "../app/pricing_service.ts";
import { createRegistryReadAccess } from "./helpers";
import { createRouteFreshnessReader } from "./helpers";
import { createTopologyCache } from "../arb/topology_cache.ts";
import { createWatcherConfigurator } from "./watcher_configurator.ts";
import { enumerateCycles, enumerateCyclesDual } from "../routing/enumerate_cycles.ts";
import { errorMessage } from "../utils/errors.ts";
import { fetchAndNormalizeCurvePool as defaultFetchAndNormalizeCurvePool } from "../state/poll_curve.ts";
import { fetchAndNormalizeDodoPool as defaultFetchAndNormalizeDodoPool } from "../state/poll_dodo.ts";
import { fetchAndNormalizeWoofiPool as defaultFetchAndNormalizeWoofiPool } from "../state/poll_woofi.ts";
import { formatDuration, roiForCandidate } from "./helpers";
import { formatRoutePath } from "./helpers";
import { buildGraph, buildHubGraph, HUB_4_TOKENS, POLYGON_HUB_TOKENS, serializeTopology } from "../routing/graph.ts";
import { isObservedUnroutableWarmupState, isSupportedWarmupProtocol } from "../state/warmup.ts";
import { logger as defaultRootLogger, logger as defaultLogger } from "../utils/logger.ts";
import { normalizeEvmAddress as normalizeEvmAddressFromIdentity } from "../utils/identity.ts";
import { getPoolTokens, normalizeEvmAddress } from "../utils/pool_record.ts";
import { poolLiquidityWmatic } from "../routing/liquidity.ts";
import { printStartupBanner } from "./helpers";
import { recordWatcherHalt as defaultRecordWatcherHalt } from "../utils/metrics.ts";
import { routeIdentityFromEdges } from "../routing/route_identity.ts";
import { setWatcherHealthy, startMetricsServer as defaultStartMetricsServer, stopMetricsServer as defaultStopMetricsServer } from "../utils/metrics.ts";
import { takeTopNBy } from "../utils/bounded_priority.ts";
import { toFiniteNumber as normaliseLogWeight } from "../utils/bigint.ts";
import { validatePoolState as defaultValidatePoolState } from "../state/normalizer.ts";
import { workerPool as defaultWorkerPool } from "../routing/worker_pool.ts";
import type { ArbPathLike } from "../arb/assessment.ts";
import type { BotState } from "../tui/types.ts";
import type { CandidateEntry, ExecutableCandidate } from "../arb/assessment.ts";
import type { CycleEnumerationOptions } from "../routing/enumerate_cycles.ts";
import type { NonceManager as NonceManagerType } from "../execution/nonce_manager.ts";
import type { PassStateUpdate, PassErrorStateUpdate } from "./bot_telemetry.ts";
import type { PriceOracle as PriceOracleType } from "../arb/price_oracle.ts";
import type { RouteCache as RouteCacheType } from "../routing/route_cache.ts";
import type { RouteState, RouteStateCache } from "../routing/simulation_types.ts";
import type { RoutingGraph, SwapEdge } from "../routing/graph.ts";
import type { SerializedEnumeratedPath, SerializedTopology } from "../routing/worker_messages.ts";
import type { StateWatcher as StateWatcherType } from "../state/watcher.ts";
type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;

type PoolRecordBase = {
  pool_address: string;
  protocol: string;
  status?: string;
  tokens?: unknown;
};

type PoolState = Record<string, unknown>;
type StateCache = Map<string, PoolState>;

type PriceOracleLikeTopology = {
  isFresh: (maxAgeMs: number) => boolean;
  update: () => void;
  getFreshRate: (address: string, maxAgeMs: number) => bigint;
} | null;

type PriceOracleLikeMarketData = {
  fromMatic: (tokenAddress: string, maticWei: bigint) => bigint;
  getFreshRate: (tokenAddress: string, maxAgeMs?: number) => bigint;
} | null;

export type PoolsChangedEvent = {
  type: "pools_changed";
  changedPools: Set<string>;
};

export type ReorgDetectedEvent = {
  type: "reorg_detected";
  reorgBlock: number;
  changedPools: Set<string>;
};

export type PoolsDiscoveredEvent = {
  type: "pools_discovered";
  pools: unknown[];
};

export type WatcherHaltEvent = {
  type: "watcher_halt";
  payload: Record<string, unknown>;
};

export type RuntimeEvent =
  | PoolsChangedEvent
  | ReorgDetectedEvent
  | PoolsDiscoveredEvent
  | WatcherHaltEvent;

export type RuntimeState = RouteState;
export type RuntimeStateCache = RouteStateCache;

export function createBackgroundTaskTracker() {
  const tasks = new Set<Promise<void>>();

  function track(task: Promise<void>) {
    tasks.add(task);
    void task
      .catch(() => {})
      .finally(() => {
        tasks.delete(task);
      });
    return task;
  }

  async function waitForIdle() {
    while (tasks.size > 0) {
      await Promise.allSettled([...tasks]);
    }
  }

  return {
    track,
    waitForIdle,
    size: () => tasks.size,
  };
}

type WatcherLikeBootMode = {
  start: (cursor?: unknown) => Promise<unknown>;
  wait: () => Promise<unknown>;
  haltMeta?: { reason?: unknown } | null;
};

type BootModeDeps<Watcher extends WatcherLikeBootMode, BotStateGeneric> = {
  botState: BotStateGeneric;
  setBotStatus: (status: "running") => void;
  setStopTui: (stopTui: (() => void) | null) => void;
  startTui: (botState: BotStateGeneric) => Promise<() => void>;
  startMetricsServer: () => void;
  printBanner: () => void;
  loopMode: boolean;
  discoveryOnly: boolean;
  envioApiToken: string | null | undefined;
  runPass: () => Promise<void>;
  shutdown: () => Promise<void>;
  createWatcher: () => Watcher;
  setWatcher: (watcher: Watcher | null) => void;
  configureWatcher: (watcher: Watcher) => void;
  log: LoggerFn;
  fastArbDebounceMs: number;
  baseArbDebounceMs: number;
  heartbeatIntervalMs: number;
  formatDuration: (durationMs: number) => string;
  setWatcherHealthy: () => void;
  startHeartbeat: () => void;
  scheduleArb: () => void;
  stopHeartbeat: () => void;
  startRealtimeFeeds?: () => void;
  stopRealtimeFeeds?: () => void;
};

export function createBootModeCoordinator<Watcher extends WatcherLikeBootMode, BotStateGeneric>(
  deps: BootModeDeps<Watcher, BotStateGeneric>,
) {
  async function startOperatorSurface(tuiMode: boolean) {
    deps.setBotStatus("running");
    deps.startMetricsServer();

    if (tuiMode) {
      deps.setStopTui(await deps.startTui(deps.botState));
      return;
    }

    deps.printBanner();
  }

  async function runAfterBootstrap() {
    if (!deps.loopMode) {
      if (!deps.discoveryOnly) await deps.runPass();
      await deps.shutdown();
      return;
    }

    if (!deps.envioApiToken) {
      throw new Error("ENVIO_API_TOKEN is required for --loop watcher mode");
    }

    const watcher = deps.createWatcher();
    deps.setWatcher(watcher);
    deps.configureWatcher(watcher);

    deps.log(
      `Starting HyperSync polling watcher (debounce: ${deps.fastArbDebounceMs}-${deps.baseArbDebounceMs}ms adaptive, heartbeat: ${deps.formatDuration(deps.heartbeatIntervalMs)})...`,
      "info",
      {
        event: "watcher_start",
        debounceMs: deps.baseArbDebounceMs,
        fastDebounceMs: deps.fastArbDebounceMs,
        heartbeatMs: deps.heartbeatIntervalMs,
      },
    );

    await watcher.start(undefined);
    deps.setWatcherHealthy();
    deps.startRealtimeFeeds?.();
    deps.startHeartbeat();
    deps.scheduleArb();
    try {
      await watcher.wait();
    } finally {
      deps.stopRealtimeFeeds?.();
    }

    if (watcher.haltMeta) {
      throw new Error(`Watcher halted: ${String(watcher.haltMeta.reason ?? "unknown reason")}`);
    }

    deps.stopHeartbeat();
  }

  return {
    startOperatorSurface,
    runAfterBootstrap,
  };
}

type PoolRecordDiscovery = PoolRecordBase & {
  metadata?: unknown;
  state?: { data?: Record<string, unknown> } | null;
};

type DiscoveryRefreshDeps = {
  isRunning: () => boolean;
  log: LoggerFn;
  getRepositories: () => Pick<RegistryRepositories, "pools"> | null;
  stateCache: StateCache;
  getWatcher: () => {
    addPools: (poolAddresses: string[]) => Promise<unknown>;
    backfillPools?: (poolAddresses: string[]) => Promise<unknown>;
  } | null | undefined;
  isHydratablePool: (pool: PoolRecordDiscovery) => boolean;
  claimDeferredHydration: (pools: PoolRecordDiscovery[]) => PoolRecordDiscovery[];
  releaseDeferredHydration: (pools: PoolRecordDiscovery[]) => void;
  fetchAndCacheStates: (pools: PoolRecordDiscovery[], options: Record<string, unknown>) => Promise<unknown>;
  validatePoolState: (state: PoolState | undefined) => { valid: boolean };
  clearDeferredHydrationRetry: (address: string) => void;
  recordDeferredHydrationFailure: (address: string, reason: string) => void;
  topology: { invalidate: (reason?: string) => void } | null;
  refreshCycles: (force?: boolean) => Promise<unknown>;
  v3NearWordRadius: number;
};

function seedNewPoolsIntoStateCache(pools: PoolRecordDiscovery[], stateCache: StateCache) {
  const newPools: PoolRecordDiscovery[] = [];
  for (const pool of pools) {
    const poolAddress = normalizeEvmAddress(pool.pool_address);
    if (!poolAddress) continue;
    if (stateCache.has(poolAddress)) continue;
    stateCache.set(poolAddress, {
      poolId: poolAddress,
      protocol: pool.protocol,
      tokens: getPoolTokens(pool),
      timestamp: 0,
    });
    newPools.push({ ...pool, pool_address: poolAddress });
  }
  return newPools;
}

export function createDiscoveryRefreshCoordinator(deps: DiscoveryRefreshDeps) {
  async function reconcileDiscoveryResult(result: { totalDiscovered?: number } | null | undefined) {
    if (!deps.isRunning() || !result?.totalDiscovered) return;

    const repositories = deps.getRepositories();
    repositories?.pools.invalidateMetaCache();
    const allPools = repositories?.pools.getActiveMeta() ?? [];
    const newPools = seedNewPoolsIntoStateCache(allPools, deps.stateCache);

    if (newPools.length > 0) {
      await deps.getWatcher()?.addPools(newPools.map((pool) => pool.pool_address.toLowerCase()));
      if (!deps.isRunning()) return;

      const claimedNewPools = deps.claimDeferredHydration(newPools.filter((pool) => deps.isHydratablePool(pool)));
      try {
        if (claimedNewPools.length > 0) {
          try {
            await deps.getWatcher()?.backfillPools?.(claimedNewPools.map((pool) => pool.pool_address.toLowerCase()));
          } catch (err) {
            deps.log(`Targeted HyperSync backfill failed: ${String((err as Error).message ?? err)}`, "warn", {
              event: "targeted_backfill_error",
              err,
            });
          }
          await deps.fetchAndCacheStates(claimedNewPools, {
            v3HydrationMode: "nearby",
            v3NearWordRadius: deps.v3NearWordRadius,
            logContext: {
              label: "Discovery hydration",
              eventPrefix: "discovery_hydration",
            },
          });

          for (const pool of claimedNewPools) {
            const addr = pool.pool_address.toLowerCase();
            if (deps.validatePoolState(deps.stateCache.get(addr)).valid) {
              deps.clearDeferredHydrationRetry(addr);
            } else {
              deps.recordDeferredHydrationFailure(addr, "state_not_routable_after_discovery_hydration");
            }
          }
        }

        if (!deps.isRunning()) return;
      } finally {
        deps.releaseDeferredHydration(claimedNewPools);
      }
    }

    deps.topology?.invalidate("background_discovery");
    await deps.refreshCycles(true);
  }

  return {
    reconcileDiscoveryResult,
  };
}

function normalizePoolAddressLike(value: unknown) {
  return normalizeEvmAddressFromIdentity(value);
}

export function normalizeChangedPools(value: unknown): Set<string> {
  if (value == null) return new Set();

  if (typeof value === "string") {
    const normalized = normalizePoolAddressLike(value);
    return normalized ? new Set([normalized]) : new Set();
  }

  if (value instanceof Set || Array.isArray(value)) {
    return new Set(
      [...value]
        .map(normalizePoolAddressLike)
        .filter((entry): entry is string => entry != null),
    );
  }

  if (typeof (value as { [Symbol.iterator]?: unknown })?.[Symbol.iterator] === "function") {
    return new Set(
      [...value as Iterable<unknown>]
        .map(normalizePoolAddressLike)
        .filter((entry): entry is string => entry != null),
    );
  }

  return new Set();
}

export function normalizeReorgBlock(value: unknown) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return null;
  return numeric;
}

export function normalizeEventPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type CandidateLike = {
  path: ArbPathLike;
  result: { profit: bigint };
  assessment?: { roi?: number; netProfit?: bigint; netProfitAfterGas?: bigint } | null;
};

type PassRunnerDeps = {
  getStateCacheSize: () => number;
  getCachedCycleCount: () => number;
  incrementPassCount: () => number;
  getConsecutiveErrors: () => number;
  incrementConsecutiveErrors: () => number;
  resetConsecutiveErrors: () => void;
  setBotState: (update: {
    passCount: number;
    consecutiveErrors: number;
    stateCacheSize: number;
    cachedPathCount: number;
    lastPassDurationMs: number;
    lastOpportunityCount: number;
    lastPathsEvaluated?: number;
    lastCandidateCount?: number;
    lastShortlistCount?: number;
    lastOptimizedCount?: number;
    lastProfitableCount?: number;
    lastUpdateMs: number;
    opportunities: Array<{ Route: string; Profit: string; ROI: string }>;
    totalTxAttempted?: number;
    totalTxSuccessful?: number;
    totalTxReverted?: number;
    totalProfitWei?: bigint;
    lastProfitWei?: bigint;
  }) => void;
  setBotErrorState?: (update: {
    passCount: number;
    consecutiveErrors: number;
    lastPassDurationMs: number;
    lastUpdateMs: number;
  }) => void;
  log: LoggerFn;
  trackBackgroundTask: (task: Promise<unknown>) => void;
  maybeRunDiscovery: () => Promise<unknown>;
  reconcileDiscoveryResult: (result: unknown) => Promise<unknown>;
  refreshCycles: () => Promise<unknown>;
  maybeHydrateQuietPools: () => Promise<unknown>;
  refreshPriceOracleIfStale: () => void;
  searchOpportunities: () => Promise<CandidateLike[]>;
  executeBatchIfIdle: (candidates: CandidateLike[], reason: string) => Promise<unknown>;
  formatProfit: (profit: bigint, startToken: string) => string;
  roiForCandidate: (candidate: CandidateLike) => number;
  formatDuration: (ms: number) => string;
  sleep: (ms: number) => Promise<unknown>;
  maxConsecutiveErrors: number;
  maxExecutionBatch: number;
  recordTxAttempt?: (success: boolean, profitWei?: bigint) => void;
};

function formatDisplayedOpportunities(
  candidates: CandidateLike[],
  deps: Pick<PassRunnerDeps, "formatProfit" | "roiForCandidate">,
) {
  return candidates.slice(0, 5).map((candidate) => ({
    Route: candidate.path.edges.map((edge) => edge.protocol).join(" -> "),
    Profit: deps.formatProfit(candidate.assessment?.netProfitAfterGas ?? candidate.assessment?.netProfit ?? 0n, candidate.path.startToken),
    ROI: `${(deps.roiForCandidate(candidate) / 10000).toFixed(2)}%`,
  }));
}

export function createPassRunner(deps: PassRunnerDeps) {
  async function runPass() {
    const startedAt = Date.now();
    const passCount = deps.incrementPassCount();
    const cachedCycleCount = deps.getCachedCycleCount();
    deps.log(`Pass #${passCount} — state: ${deps.getStateCacheSize()} pools, paths: ${cachedCycleCount}`, "info", {
      event: "pass_start",
      activity: "Starting pass",
      activityDetail: `State cache ${deps.getStateCacheSize()} pools, ${cachedCycleCount} cached paths`,
      pass: passCount,
      stateSize: deps.getStateCacheSize(),
      cachedPaths: cachedCycleCount,
    });

    try {
      deps.trackBackgroundTask((async () => {
        const result = await deps.maybeRunDiscovery();
        await deps.reconcileDiscoveryResult(result);
      })().catch((err: unknown) => {
        deps.log(`Background discovery error: ${errorMessage(err)}`, "warn", {
          event: "discovery_bg_error",
          err,
        });
      }));

      await deps.refreshCycles();
      await deps.maybeHydrateQuietPools().catch((err: unknown) => {
        deps.log(`Quiet-pool sweep error: ${errorMessage(err)}`, "warn", {
          event: "quiet_pool_sweep_error",
          pass: passCount,
          stateSize: deps.getStateCacheSize(),
          cachedPaths: deps.getCachedCycleCount(),
          reason: errorMessage(err),
          err,
        });
      });

      deps.refreshPriceOracleIfStale();

      const opportunities = await deps.searchOpportunities();
      const passDurationMs = Date.now() - startedAt;
      deps.setBotState({
        passCount,
        consecutiveErrors: deps.getConsecutiveErrors(),
        stateCacheSize: deps.getStateCacheSize(),
        cachedPathCount: deps.getCachedCycleCount(),
        lastPassDurationMs: passDurationMs,
        lastOpportunityCount: opportunities.length,
        lastUpdateMs: Date.now(),
        opportunities: formatDisplayedOpportunities(opportunities, deps),
      });

      deps.log(`Pass #${passCount}: ${opportunities.length} profitable route(s)`, "info", {
        event: "pass_opportunities",
        activity: "Checking opportunities",
        activityDetail: `${opportunities.length} profitable route(s) after scan`,
        pass: passCount,
        opportunities: opportunities.length,
        stateSize: deps.getStateCacheSize(),
        cachedPaths: deps.getCachedCycleCount(),
        lastPass: deps.formatDuration(Date.now() - startedAt),
      });

      if (opportunities.length > 0) {
        deps.log("Executing top opportunity set...", "info", {
          event: "pass_execute_best",
          activity: "Executing opportunities",
          activityDetail: `${Math.min(opportunities.length, deps.maxExecutionBatch)} route(s) selected for execution`,
          pass: passCount,
          opportunities: Math.min(opportunities.length, deps.maxExecutionBatch),
        });
        const executionResult = await deps.executeBatchIfIdle(opportunities.slice(0, deps.maxExecutionBatch), "run_pass");
        if (executionResult && typeof executionResult === "object") {
          const result = executionResult as { submitted?: boolean; confirmed?: boolean; error?: unknown; txHash?: string; txHashes?: string[] };
          if (result.submitted) {
            const txCount = Math.min(opportunities.length, deps.maxExecutionBatch);
            if (deps.recordTxAttempt) {
              for (let i = 0; i < txCount; i++) {
                deps.recordTxAttempt(true);
              }
            }
          } else if (result.error) {
            if (deps.recordTxAttempt) {
              deps.recordTxAttempt(false);
            }
          }
        }
      }

      deps.log(`Pass #${passCount} complete in ${deps.formatDuration(Date.now() - startedAt)}`, "info", {
        event: "pass_complete",
        activity: "Pass complete",
        activityDetail: `${opportunities.length} profitable route(s), ${deps.getCachedCycleCount()} cached paths`,
        pass: passCount,
        durationMs: Date.now() - startedAt,
        opportunities: opportunities.length,
      });
      deps.resetConsecutiveErrors();
    } catch (err: unknown) {
      deps.log(`Pass #${passCount} failed: ${errorMessage(err)}`, "error", {
        event: "pass_failed",
        activity: "Pass failed",
        activityDetail: errorMessage(err),
        pass: passCount,
        consecutiveErrors: deps.getConsecutiveErrors() + 1,
        err,
      });
      const consecutiveErrors = deps.incrementConsecutiveErrors();
      deps.setBotErrorState?.({
        passCount,
        consecutiveErrors,
        lastPassDurationMs: Date.now() - startedAt,
        lastUpdateMs: Date.now(),
      });
      if (consecutiveErrors >= deps.maxConsecutiveErrors) {
        deps.log(`${deps.maxConsecutiveErrors} consecutive errors — backing off 30s`, "warn");
        await deps.sleep(30_000);
        deps.resetConsecutiveErrors();
      }
    }
  }

  return { runPass };
}

type ReorgRecoveryDeps = {
  log: LoggerFn;
  clearRouteCache: () => void;
  clearTopologyCycles: () => void;
  resetTopology: () => void;
  refreshPriceOracle: () => void;
};

export function createReorgRecoveryCoordinator(deps: ReorgRecoveryDeps) {
  function handleReorgDetected(reorgBlock: number, changedPools: Set<string>) {
    deps.log(`[runner] Reorg rollback to block ${reorgBlock}; clearing cached routes and topology`, "warn", {
      event: "watcher_reorg",
      reorgBlock,
      changedPools: changedPools.size,
    });

    deps.clearRouteCache();
    deps.clearTopologyCycles();
    deps.resetTopology();
    deps.refreshPriceOracle();

    if (changedPools.size > 0) {
      deps.log(`[runner] Reorg cache reload touched ${changedPools.size} active pool(s)`, "debug", {
        event: "watcher_reorg_reload",
        changedPools: changedPools.size,
      });
    }
  }

  return {
    handleReorgDetected,
  };
}

type ManagedRuntimeState = {
  watcher: StateWatcherType | null;
  priceOracle: PriceOracleType | null;
  nonceManager: NonceManagerType | null;
};

type RuntimeContextOptions = {
  routeCacheSize?: number;
  initialBotState: BotState;
};

export function createRuntimeContext(options: RuntimeContextOptions) {
  const stateCache: RouteStateCache = new Map();
  const routeCache = new RouteCache(options.routeCacheSize ?? 1_000);
  const botState = options.initialBotState;

  let running = true;
  const managedState: ManagedRuntimeState = {
    watcher: null,
    priceOracle: null,
    nonceManager: null,
  };
  let passCount = 0;
  let consecutiveErrors = 0;

  return {
    stateCache,
    routeCache,
    botState,
    isRunning: () => running,
    setRunning: (next: boolean) => {
      running = next;
    },
    getWatcher: () => managedState.watcher,
    setWatcher: (next: StateWatcherType | null) => {
      managedState.watcher = next;
    },
    getPriceOracle: () => managedState.priceOracle,
    setPriceOracle: (next: PriceOracleType | null) => {
      managedState.priceOracle = next;
    },
    getNonceManager: () => managedState.nonceManager,
    setNonceManager: (next: NonceManagerType | null) => {
      managedState.nonceManager = next;
    },
    getPassCount: () => passCount,
    incrementPassCount: () => {
      passCount += 1;
      return passCount;
    },
    setPassCount: (next: number) => {
      passCount = next;
    },
    getConsecutiveErrors: () => consecutiveErrors,
    setConsecutiveErrors: (next: number) => {
      consecutiveErrors = next;
    },
    resetConsecutiveErrors: () => {
      consecutiveErrors = 0;
    },
    incrementConsecutiveErrors: () => {
      consecutiveErrors += 1;
      return consecutiveErrors;
    },
  };
}

type StartupCoordinatorDeps<Registry, Repositories, PriceOracleGeneric, NonceManagerGeneric> = {
  log: LoggerFn;
  createRegistry: () => Registry;
  createRepositories: (registry: Registry) => Repositories;
  createPriceOracle: (registry: Registry) => PriceOracleGeneric;
  createNonceManager: () => NonceManagerGeneric;
  setPriceOracle: (oracle: PriceOracleGeneric) => void;
  setNonceManager: (nonceManager: NonceManagerGeneric) => void;
  runInitialDiscovery: () => Promise<unknown>;
  seedStateCache: () => void;
  warmupStateCache: () => Promise<unknown>;
  refreshCycles: (force?: boolean) => Promise<unknown>;
  getCachedCycleCount: () => number;
};

export function createStartupCoordinator<Registry, Repositories, PriceOracleGeneric, NonceManagerGeneric>(
  deps: StartupCoordinatorDeps<Registry, Repositories, PriceOracleGeneric, NonceManagerGeneric>,
) {
  function initializeRuntime() {
    const registry = deps.createRegistry();
    const repositories = deps.createRepositories(registry);
    deps.setPriceOracle(deps.createPriceOracle(registry));
    deps.setNonceManager(deps.createNonceManager());
    return { registry, repositories };
  }

  async function bootstrapRouting() {
    await deps.runInitialDiscovery();
    deps.seedStateCache();
    await deps.warmupStateCache();
    await deps.refreshCycles(true);

    if (deps.getCachedCycleCount() === 0) {
      deps.log(
        "Post-warmup: 0 arbitrage paths enumerated. Hub-pair pools may be unavailable or RPC failed. Watcher replay will populate state incrementally.",
        "warn",
        { event: "warmup_no_paths" },
      );
    }
  }

  return {
    initializeRuntime,
    bootstrapRouting,
  };
}

type TopologyServiceLike = {
  refreshCycles: (options: {
    force?: boolean;
    minLiquidityWmatic: bigint;
    selective4HopPathBudget: number;
    selective4HopMaxPathsPerToken: number;
    getRateWei: ((addr: string) => bigint) | null;
    clearExecutionRouteQuarantine?: (reason: string) => void;
  }) => Promise<ArbPathLike[]>;
};

type TopologyRefreshDeps = {
  getPriceOracle: () => PriceOracleLikeTopology;
  getTopologyService: () => TopologyServiceLike | null;
  clearExecutionRouteQuarantine: (reason: string) => void;
  maxPriceAgeMs: number;
  minLiquidityWmatic: bigint;
  selective4HopPathBudget: number;
  selective4HopMaxPathsPerToken: number;
};

export function createTopologyRefreshCoordinator(deps: TopologyRefreshDeps) {
  function refreshPriceOracleIfStale() {
    const oracle = deps.getPriceOracle();
    if (oracle && !oracle.isFresh(deps.maxPriceAgeMs)) {
      oracle.update();
    }
    return oracle;
  }

  function getRateWei() {
    const oracle = refreshPriceOracleIfStale();
    return oracle
      ? ((addr: string) => oracle.getFreshRate(addr, deps.maxPriceAgeMs))
      : null;
  }

  async function refreshCycles(force = false) {
    return deps.getTopologyService()?.refreshCycles({
      force,
      minLiquidityWmatic: deps.minLiquidityWmatic,
      selective4HopPathBudget: deps.selective4HopPathBudget,
      selective4HopMaxPathsPerToken: deps.selective4HopMaxPathsPerToken,
      getRateWei: getRateWei(),
      clearExecutionRouteQuarantine: deps.clearExecutionRouteQuarantine,
    });
  }

  return {
    refreshCycles,
    refreshPriceOracleIfStale,
  };
}

type PoolStateTopology = RouteState;
type StateCacheTopology = Map<string, PoolStateTopology>;
type HydrationBacklogStats = {
  missingStatePools: number;
  invalidStatePools: number;
  observedUnroutablePools: number;
  unsupportedPools: number;
};
type RoutingGraphLike = Pick<RoutingGraph, "adjacency" | "tokens" | "hasToken" | "getEdges" | "getEdgesBetween" | "addPool" | "upsertPool" | "removePool" | "getPoolEdge"> & {
  _edgesByPool: Map<string, SwapEdge[]>;
};
type WorkerEnumerator = {
  enumerate: (
    topology: SerializedTopology,
    startTokens: string[],
    options: Record<string, unknown>,
  ) => Promise<SerializedEnumeratedPath[]>;
};
type RegistryAdapter = {
  getActivePoolsMeta: () => PoolRecordBase[];
  getPoolMeta: (address: string) => PoolRecordBase | undefined;
};

type TopologyServiceDeps = {
  routingCycleMode: "all" | "triangular";
  routingMinHops?: number;
  routingMaxHops: number;
  maxTotalPaths: number;
  polygonHubTokens: Set<string>;
  hub4Tokens: Set<string>;
  selective4HopTokenLimit: number;
  dynamicPivotTokenLimit?: number;
  routeCycleCacheFile?: string | null;
  routeCycleCacheMaxAgeMs?: number;
  workerCount: number;
  workerPool: WorkerEnumerator;
  isWorkerPoolInitialized: () => boolean;
  cycleRefreshIntervalMs: number;
  routeCache: Pick<RouteCacheType, "prune" | "routes">;
  stateCache: StateCacheTopology;
  registry: RegistryAdapter;
  buildGraph: (pools: PoolRecordBase[], stateCache: StateCacheTopology) => RoutingGraphLike;
  buildHubGraph: (pools: PoolRecordBase[], hubTokens: Set<string>, stateCache: StateCacheTopology) => RoutingGraphLike;
  serializeTopology: (graph: RoutingGraphLike) => SerializedTopology;
  enumerateCycles: (graph: RoutingGraphLike, options?: CycleEnumerationOptions) => ArbPathLike[];
  enumerateCyclesDual: (hubGraph: RoutingGraphLike, fullGraph: RoutingGraphLike, options?: CycleEnumerationOptions) => ArbPathLike[];
  validatePoolState: (state: PoolStateTopology | undefined) => { valid: boolean; reason?: string };
  clearGasEstimateCache: () => void;
  log: LoggerFn;
};

export function createTopologyService(deps: TopologyServiceDeps) {
  const topologyCache = createTopologyCache(deps.maxTotalPaths);
  const routingMaxHops = Math.max(2, Math.floor(Number(deps.routingMaxHops) || 4));
  const routingMinHops = Math.min(
    routingMaxHops,
    Math.max(2, Math.floor(Number(deps.routingMinHops ?? 2) || 2)),
  );

  let hubGraph: RoutingGraphLike | null = null;
  let fullGraph: RoutingGraphLike | null = null;
  let cachedCycles: ArbPathLike[] = [];
  let topologyVersion = 0;
  let topologyDirty = true;
  let lastCycleRefreshMs = 0;
  let cycleRefreshPromise: Promise<ArbPathLike[]> | null = null;
  let queuedRefreshPromise: Promise<ArbPathLike[]> | null = null;
  let queuedRefreshForce = false;
  let dirtyPoolAddresses = new Set<string>();
  let dirtyHubStartTokens = new Set<string>();

  function cycleModeOptions(include4Hop: boolean) {
    if (deps.routingCycleMode === "triangular") {
      return {
        include2Hop: false,
        include3Hop: routingMinHops <= 3 && routingMaxHops >= 3,
        include4Hop: false,
        minHops: Math.min(routingMinHops, 3),
        maxHops: Math.min(routingMaxHops, 3),
      };
    }

    return {
      include2Hop: routingMinHops <= 2 && routingMaxHops >= 2,
      include3Hop: routingMinHops <= 3 && routingMaxHops >= 3,
      include4Hop: include4Hop && routingMinHops <= routingMaxHops && routingMaxHops >= 4,
      minHops: routingMinHops,
      maxHops: routingMaxHops,
    };
  }

  function liquidityAwareEnumerationCap(baseCap: number, options: { minLiquidityWmatic: bigint; getRateWei?: ((token: string) => bigint) | null }) {
    const cap = Math.max(1, Math.ceil(baseCap));
    if (options.minLiquidityWmatic <= 0n || !options.getRateWei) return cap;
    return Math.max(cap, Math.min(5_000, Math.max(16, deps.maxTotalPaths * 4)));
  }

  function tokenRateWeiByToken(graph: RoutingGraphLike, getRateWei: ((token: string) => bigint) | null | undefined) {
    if (!getRateWei) return null;
    const rates: Record<string, string> = {};
    for (const token of graph.tokens) {
      try {
        const rate = getRateWei(token);
        if (rate > 0n) rates[token.toLowerCase()] = rate.toString();
      } catch {
      }
    }
    return rates;
  }

  function selectHighLiquidityHubTokens(
    graph: RoutingGraphLike,
    getRateWei: ((token: string) => bigint) | null,
    limit = deps.selective4HopTokenLimit,
  ) {
    const normalizedLimit = Math.max(0, Math.floor(Number(limit)));
    if (normalizedLimit <= 0) return [];

    const ranked = [...deps.polygonHubTokens]
      .filter((token) => graph?.hasToken?.(token))
      .map((token) => {
        const outgoing = graph.getEdges(token);
        const seenPools = new Set<string>();
        let liquidityScore = 0n;

        for (const edge of outgoing) {
          if (seenPools.has(edge.poolAddress)) continue;
          seenPools.add(edge.poolAddress);
          liquidityScore += poolLiquidityWmatic(edge, getRateWei);
        }

        return {
          token,
          liquidityScore,
          degree: seenPools.size,
        };
      })
      .filter((entry) => entry.degree > 0)
      .sort((a, b) => {
        if (a.liquidityScore === b.liquidityScore) return b.degree - a.degree;
        return a.liquidityScore > b.liquidityScore ? -1 : 1;
      });

    return ranked.slice(0, normalizedLimit).map((entry) => entry.token);
  }

  function selectFullGraphPivotTokens(graph: RoutingGraphLike, getRateWei: ((token: string) => bigint) | null) {
    const limit = Math.max(
      1,
      Math.floor(Number(deps.dynamicPivotTokenLimit ?? deps.polygonHubTokens.size)),
    );
    return selectHighLiquidityHubTokens(graph, getRateWei, limit);
  }

  function mergeTokenLists(...groups: string[][]) {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const token of group) {
        if (seen.has(token)) continue;
        seen.add(token);
        merged.push(token);
      }
    }
    return merged;
  }

  function quantizeLiquidityValue(value: unknown) {
    try {
      if (
        typeof value !== "bigint" &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return "x";
      }
      const raw = BigInt(value);
      if (raw <= 0n) return "0";
      const digits = raw.toString();
      return `${digits.length}:${digits.slice(0, 2)}`;
    } catch {
      return "x";
    }
  }

  function stateLiquiditySignature(state: PoolStateTopology | undefined) {
    if (!state) return "missing";
    const parts: string[] = [];
    for (const key of ["reserve0", "reserve1", "liquidity", "baseReserve", "quoteReserve"]) {
      if (state[key] != null) parts.push(`${key}=${quantizeLiquidityValue(state[key])}`);
    }
    if (Array.isArray(state.balances)) {
      parts.push(`balances=${state.balances.map((balance: unknown) => quantizeLiquidityValue(balance)).join(",")}`);
    }
    return parts.length > 0 ? parts.join(";") : "none";
  }

  async function hashStringSHA256(value: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }

  async function poolSignatureDigest(pools: PoolRecordBase[], processId: string) {
    const encoder = new TextEncoder();
    const signatures: string[] = [];
    for (const pool of pools) {
      const addr = normalizeEvmAddress(pool.pool_address);
      if (!addr) continue;
      const tokens = getPoolRoutingTokens(pool).join(",");
      const signature = [
        addr,
        pool.protocol,
        tokens,
        stateLiquiditySignature(deps.stateCache.get(addr)),
      ].join(":");
      signatures.push(signature);
    }

    const combined = `${processId}:${pools.length}:${signatures.sort().join("|")}`;
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(combined));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const digest = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

    return {
      count: signatures.length,
      xor: digest.slice(0, 8),
      sum: digest.slice(8, 16),
      sum2: digest.slice(16, 24),
    };
  }

  async function buildRouteCycleCacheKey(
    pools: PoolRecordBase[],
    options: {
      minLiquidityWmatic: bigint;
      selective4HopPathBudget: number;
      selective4HopMaxPathsPerToken: number;
    },
    fullPivotTokens: string[],
    selective4HopTokens: string[],
  ) {
    const processId = String(process.pid ?? Math.random().toString(36).slice(2, 10));
    return JSON.stringify({
      version: 3,
      routingCycleMode: deps.routingCycleMode,
      routingMinHops,
      routingMaxHops,
      maxTotalPaths: deps.maxTotalPaths,
      minLiquidityWmatic: options.minLiquidityWmatic.toString(),
      selective4HopPathBudget: options.selective4HopPathBudget,
      selective4HopMaxPathsPerToken: options.selective4HopMaxPathsPerToken,
      fullPivotTokens,
      selective4HopTokens,
      pools: await poolSignatureDigest(pools, processId),
    });
  }

  function markPoolsDirty(poolAddresses: Iterable<string>) {
    let requiresFullRefresh = false;
    for (const rawAddr of poolAddresses) {
      const addr = normalizeEvmAddress(rawAddr);
      if (!addr) {
        requiresFullRefresh = true;
        continue;
      }
      dirtyPoolAddresses.add(addr);
      const pool = deps.registry.getPoolMeta(addr);
      if (!pool) {
        requiresFullRefresh = true;
        continue;
      }
      const tokens = getPoolRoutingTokens(pool);
      const touchedHubTokens = tokens.filter((token) => deps.polygonHubTokens.has(token));
      if (touchedHubTokens.length === 0) {
        requiresFullRefresh = true;
        continue;
      }
      for (const token of touchedHubTokens) dirtyHubStartTokens.add(token);
    }
    return !requiresFullRefresh;
  }

  function pathPassesLiquidityFloor(
    path: ArbPathLike,
    minLiquidityWmatic: bigint,
    getRateWei: ((token: string) => bigint) | null,
  ) {
    if (minLiquidityWmatic <= 0n || !getRateWei) return true;
    for (const edge of path.edges) {
      const liquidity = poolLiquidityWmatic(edge, getRateWei);
      if (liquidity > 0n && liquidity < minLiquidityWmatic) return false;
    }
    return true;
  }

  function mergeArbPaths(
    groups: ArbPathLike[][],
    liquidityFilter: {
      minLiquidityWmatic: bigint;
      getRateWei: ((token: string) => bigint) | null;
    },
  ) {
    const merged: ArbPathLike[] = [];
    const seen = new Set<string>();

    for (const group of groups) {
      for (const path of group) {
        if (!pathPassesLiquidityFloor(path, liquidityFilter.minLiquidityWmatic, liquidityFilter.getRateWei)) continue;
        const key = routeIdentityFromEdges(path.startToken, path.edges);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(path);
      }
    }

    return takeTopNBy(
      merged,
      deps.maxTotalPaths,
      (a, b) => normaliseLogWeight(a.logWeight) - normaliseLogWeight(b.logWeight),
    );
  }

  function pruneCyclesByLiquidity(
    paths: ArbPathLike[],
    minLiquidityWmatic: bigint,
    getRateWei: ((token: string) => bigint) | null,
  ) {
    if (minLiquidityWmatic <= 0n || !getRateWei || paths.length === 0) {
      return { paths, dropped: 0 };
    }

    const filtered = paths.filter((path) => {
      for (const edge of path.edges) {
        const liquidity = poolLiquidityWmatic(edge, getRateWei);
        if (liquidity > 0n && liquidity < minLiquidityWmatic) return false;
      }
      return true;
    });

    return { paths: filtered, dropped: paths.length - filtered.length };
  }

  function emptyHydrationBacklog(): HydrationBacklogStats {
    return {
      missingStatePools: 0,
      invalidStatePools: 0,
      observedUnroutablePools: 0,
      unsupportedPools: 0,
    };
  }

  function recordHydrationBacklog(
    backlog: HydrationBacklogStats,
    pool: PoolRecordBase,
    state: PoolStateTopology | undefined,
    verdict: { valid: boolean; reason?: string },
    validAddress: boolean,
  ) {
    if (!isSupportedWarmupProtocol(pool.protocol)) {
      backlog.unsupportedPools++;
      return;
    }
    if (!validAddress) {
      backlog.invalidStatePools++;
      return;
    }
    if (state == null) backlog.missingStatePools++;
    if (isObservedUnroutableWarmupState(state, verdict)) {
      backlog.observedUnroutablePools++;
    } else if (state != null && !verdict.valid) {
      backlog.invalidStatePools++;
    }
  }

  function hydrationBacklogCategory(
    pool: PoolRecordBase,
    state: PoolStateTopology | undefined,
    verdict: { valid: boolean; reason?: string },
    validAddress: boolean,
  ) {
    if (!isSupportedWarmupProtocol(pool.protocol)) return "unsupported";
    if (!validAddress) return "invalid";
    if (state == null) return "missing";
    if (isObservedUnroutableWarmupState(state, verdict)) return "observed_unroutable";
    if (!verdict.valid) return "invalid";
    return "routable";
  }

  function incrementProtocolCount(counts: Map<string, number>, protocol: string) {
    counts.set(protocol, (counts.get(protocol) ?? 0) + 1);
  }

  function rateBps(numerator: number, denominator: number) {
    if (denominator <= 0) return 0;
    return Math.floor((numerator * 10_000) / denominator);
  }

  function routingUniverseSummary(activePools: PoolRecordBase[]) {
    const routable: PoolRecordBase[] = [];
    const topActiveProtocolCounts = new Map<string, number>();
    const topStateProtocolCounts = new Map<string, number>();
    const topUnroutableProtocolCounts = new Map<string, number>();
    const stateGapActiveProtocolCounts = new Map<string, number>();
    const stateGapStateProtocolCounts = new Map<string, number>();
    const stateGapRoutableProtocolCounts = new Map<string, number>();
    const hub4StateGapActiveProtocolCounts = new Map<string, number>();
    const hub4StateGapStateProtocolCounts = new Map<string, number>();
    const hub4StateGapRoutableProtocolCounts = new Map<string, number>();
    const hubAdjacentMissingProtocolCounts = new Map<string, number>();
    const hubAdjacentInvalidProtocolCounts = new Map<string, number>();
    const hubAdjacentObservedUnroutableProtocolCounts = new Map<string, number>();
    const hub4AdjacentMissingProtocolCounts = new Map<string, number>();
    const hub4AdjacentInvalidProtocolCounts = new Map<string, number>();
    const hub4AdjacentObservedUnroutableProtocolCounts = new Map<string, number>();
    const hubAdjacentHydrationBacklog = emptyHydrationBacklog();
    const hub4AdjacentHydrationBacklog = emptyHydrationBacklog();
    let stateRows = 0;
    let hubAdjacentPools = 0;
    let hubAdjacentUnroutablePools = 0;
    let hub4AdjacentPools = 0;
    let hub4AdjacentUnroutablePools = 0;

    for (const pool of activePools) {
      const addr = normalizeEvmAddress(pool.pool_address);
      const state = addr ? deps.stateCache.get(addr) : undefined;
      const protocol = String(pool.protocol ?? "UNKNOWN");
      topActiveProtocolCounts.set(protocol, (topActiveProtocolCounts.get(protocol) ?? 0) + 1);
      if (state != null) {
        stateRows++;
        topStateProtocolCounts.set(protocol, (topStateProtocolCounts.get(protocol) ?? 0) + 1);
      }
      const verdict = state == null
        ? { valid: false, reason: "missing_state" }
        : deps.validatePoolState(state);
      const valid = Boolean(addr && verdict.valid);
      const includeInStateGap = Boolean(addr && isSupportedWarmupProtocol(protocol));
      if (includeInStateGap) {
        incrementProtocolCount(stateGapActiveProtocolCounts, protocol);
        if (state != null) incrementProtocolCount(stateGapStateProtocolCounts, protocol);
        if (valid) incrementProtocolCount(stateGapRoutableProtocolCounts, protocol);
      }
      const tokens = getPoolRoutingTokens(pool);
      const hubAdjacent = tokens.some((token) => deps.polygonHubTokens.has(token));
      const hub4Adjacent = tokens.some((token) => deps.hub4Tokens.has(token));
      if (includeInStateGap && hub4Adjacent) {
        incrementProtocolCount(hub4StateGapActiveProtocolCounts, protocol);
        if (state != null) incrementProtocolCount(hub4StateGapStateProtocolCounts, protocol);
        if (valid) incrementProtocolCount(hub4StateGapRoutableProtocolCounts, protocol);
      }

      if (valid) {
        routable.push(pool);
      } else if (hubAdjacent) {
        topUnroutableProtocolCounts.set(protocol, (topUnroutableProtocolCounts.get(protocol) ?? 0) + 1);
      }

      if (hubAdjacent) {
        hubAdjacentPools++;
        if (!valid) {
          hubAdjacentUnroutablePools++;
          recordHydrationBacklog(hubAdjacentHydrationBacklog, pool, state, verdict, Boolean(addr));
          const category = hydrationBacklogCategory(pool, state, verdict, Boolean(addr));
          if (category === "missing") incrementProtocolCount(hubAdjacentMissingProtocolCounts, protocol);
          if (category === "invalid") incrementProtocolCount(hubAdjacentInvalidProtocolCounts, protocol);
          if (category === "observed_unroutable") {
            incrementProtocolCount(hubAdjacentObservedUnroutableProtocolCounts, protocol);
          }
        }
      }
      if (hub4Adjacent) {
        hub4AdjacentPools++;
        if (!valid) {
          hub4AdjacentUnroutablePools++;
          recordHydrationBacklog(hub4AdjacentHydrationBacklog, pool, state, verdict, Boolean(addr));
          const category = hydrationBacklogCategory(pool, state, verdict, Boolean(addr));
          if (category === "missing") incrementProtocolCount(hub4AdjacentMissingProtocolCounts, protocol);
          if (category === "invalid") incrementProtocolCount(hub4AdjacentInvalidProtocolCounts, protocol);
          if (category === "observed_unroutable") {
            incrementProtocolCount(hub4AdjacentObservedUnroutableProtocolCounts, protocol);
          }
        }
      }
    }

    const topProtocolCountsFn = (counts: Map<string, number>) => [...counts]
      .map(([protocol, pools]) => ({ protocol, pools }))
      .sort((a, b) => b.pools - a.pools || a.protocol.localeCompare(b.protocol))
      .slice(0, 5);
    const topUnroutableProtocols = topProtocolCountsFn(topUnroutableProtocolCounts);
    const hubAdjacentActionableMissingByProtocol = topProtocolCountsFn(hubAdjacentMissingProtocolCounts);
    const hub4ActionableMissingByProtocol = topProtocolCountsFn(hub4AdjacentMissingProtocolCounts);
    const topStateProtocols = topProtocolCountsFn(topStateProtocolCounts);
    const topRoutableProtocolCounts = new Map<string, number>();
    for (const pool of routable) {
      const protocol = String(pool.protocol ?? "UNKNOWN");
      topRoutableProtocolCounts.set(protocol, (topRoutableProtocolCounts.get(protocol) ?? 0) + 1);
    }
    const topRoutableProtocols = topProtocolCountsFn(topRoutableProtocolCounts);
    const coverageGapRows = (
      activeProtocolCounts: Map<string, number>,
      stateProtocolCounts: Map<string, number>,
      routableProtocolCounts: Map<string, number>,
    ) => [...activeProtocolCounts]
      .map(([protocol, activeProtocolPools]) => {
        const protocolStateRows = stateProtocolCounts.get(protocol) ?? 0;
        const protocolRoutablePools = routableProtocolCounts.get(protocol) ?? 0;
        return {
          protocol,
          activePools: activeProtocolPools,
          stateRows: protocolStateRows,
          missingStatePools: Math.max(0, activeProtocolPools - protocolStateRows),
          stateCoverageBps: rateBps(protocolStateRows, activeProtocolPools),
          routablePools: protocolRoutablePools,
          routableCoverageBps: rateBps(protocolRoutablePools, activeProtocolPools),
        };
      });
    const coverageGapsByProtocol = (
      activeProtocolCounts: Map<string, number>,
      stateProtocolCounts: Map<string, number>,
      routableProtocolCounts: Map<string, number>,
    ) => coverageGapRows(activeProtocolCounts, stateProtocolCounts, routableProtocolCounts)
      .filter((entry) => entry.missingStatePools > 0 && isSupportedWarmupProtocol(entry.protocol))
      .sort((a, b) =>
        b.missingStatePools - a.missingStatePools ||
        a.stateCoverageBps - b.stateCoverageBps ||
        b.activePools - a.activePools ||
        a.protocol.localeCompare(b.protocol)
      )
      .slice(0, 5);
    const topStateCoverageGapsByProtocol = coverageGapsByProtocol(
      stateGapActiveProtocolCounts,
      stateGapStateProtocolCounts,
      stateGapRoutableProtocolCounts,
    );
    const hub4StateCoverageGapsByProtocol = coverageGapsByProtocol(
      hub4StateGapActiveProtocolCounts,
      hub4StateGapStateProtocolCounts,
      hub4StateGapRoutableProtocolCounts,
    );
    const topRoutableCoverageGapsByProtocol = coverageGapRows(
      stateGapActiveProtocolCounts,
      stateGapStateProtocolCounts,
      stateGapRoutableProtocolCounts,
    )
      .filter((entry) => entry.routableCoverageBps < 10_000 && isSupportedWarmupProtocol(entry.protocol))
      .sort((a, b) =>
        a.routableCoverageBps - b.routableCoverageBps ||
        b.activePools - a.activePools ||
        a.protocol.localeCompare(b.protocol),
      )
      .slice(0, 5);
    const hub4RoutableCoverageGapsByProtocol = coverageGapRows(
      hub4StateGapActiveProtocolCounts,
      hub4StateGapStateProtocolCounts,
      hub4StateGapRoutableProtocolCounts,
    )
      .filter((entry) => entry.routableCoverageBps < 10_000 && isSupportedWarmupProtocol(entry.protocol))
      .sort((a, b) =>
        a.routableCoverageBps - b.routableCoverageBps ||
        b.activePools - a.activePools ||
        a.protocol.localeCompare(b.protocol),
      )
      .slice(0, 5);

    return {
      routable,
      stateRows,
      stateCoverageBps: rateBps(stateRows, activePools.length),
      topActiveProtocols: topProtocolCountsFn(topActiveProtocolCounts),
      topStateProtocols,
      topStateCoverageGapsByProtocol,
      hub4StateCoverageGapsByProtocol,
      topRoutableCoverageGapsByProtocol,
      hub4RoutableCoverageGapsByProtocol,
      routableCoverageBps: rateBps(routable.length, activePools.length),
      topRoutableProtocols,
      hubAdjacentPools,
      hubAdjacentUnroutablePools,
      hubAdjacentRoutableBps: rateBps(hubAdjacentPools - hubAdjacentUnroutablePools, hubAdjacentPools),
      hubAdjacentHydrationBacklog,
      hubAdjacentMissingByProtocol: hubAdjacentActionableMissingByProtocol,
      hubAdjacentActionableMissingByProtocol,
      hubAdjacentInvalidByProtocol: topProtocolCountsFn(hubAdjacentInvalidProtocolCounts),
      hubAdjacentObservedUnroutableByProtocol: topProtocolCountsFn(hubAdjacentObservedUnroutableProtocolCounts),
      hub4AdjacentPools,
      hub4AdjacentUnroutablePools,
      hub4AdjacentRoutableBps: rateBps(hub4AdjacentPools - hub4AdjacentUnroutablePools, hub4AdjacentPools),
      hub4AdjacentHydrationBacklog,
      hub4AdjacentMissingByProtocol: hub4ActionableMissingByProtocol,
      hub4ActionableMissingByProtocol,
      hub4AdjacentInvalidByProtocol: topProtocolCountsFn(hub4AdjacentInvalidProtocolCounts),
      hub4AdjacentObservedUnroutableByProtocol: topProtocolCountsFn(hub4AdjacentObservedUnroutableProtocolCounts),
      topUnroutableProtocols,
    };
  }

  function poolTouchesHubTokens(pool: PoolRecordBase, hubTokens: Set<string> = deps.hub4Tokens) {
    const tokens = getPoolRoutingTokens(pool);
    if (tokens.length < 2) return false;
    return tokens.some((token) => hubTokens.has(token));
  }

  function getPoolRoutingTokens(pool: PoolRecordBase): string[] {
    const addr = normalizeEvmAddress(pool.pool_address);
    const maybeStateTokens = addr ? deps.stateCache.get(addr)?.tokens : null;
    const stateTokens = Array.isArray(maybeStateTokens) ? maybeStateTokens : null;
    if (stateTokens) {
      const normalized: string[] = [
        ...new Set<string>(
          stateTokens
            .map((token: unknown) => normalizeEvmAddress(token))
            .filter((token: string | null): token is string => token != null),
        ),
      ];
      if (normalized.length >= 2) return normalized;
    }
    return getPoolTokens(pool)
      .map((token) => normalizeEvmAddress(token))
      .filter((token): token is string => token != null);
  }

  function invalidate(reason?: string) {
    topologyDirty = true;
    topologyCache.invalidateSerializedTopologies();
    if (reason) {
      deps.log("[runner] Marked topology dirty", "debug", {
        event: "topology_dirty",
        reason,
      });
    }
  }

  function admitPools(poolAddresses: Set<string>) {
    if (!fullGraph || !hubGraph || !poolAddresses || poolAddresses.size === 0) return 0;

    let admitted = 0;
    let changed = 0;
    const changedPools = new Set<string>();
    for (const rawAddr of poolAddresses) {
      const addr = normalizeEvmAddress(rawAddr);
      if (!addr) continue;

      const pool = deps.registry.getPoolMeta(addr);
      if (!pool || pool.status !== "active") continue;

      const fullResult = fullGraph.upsertPool(pool, deps.stateCache);
      const hubEligible = poolTouchesHubTokens(pool);
      const hubResult = hubEligible
        ? hubGraph.upsertPool(pool, deps.stateCache)
        : hubGraph.removePool(addr) > 0
          ? "removed"
          : "skipped";

      if (fullResult === "added") {
        admitted++;
      }
      if (fullResult === "added" || fullResult === "updated" || fullResult === "removed" ||
          hubResult === "added" || hubResult === "updated" || hubResult === "removed") {
        changed++;
        changedPools.add(addr);
      }
    }

    if (changed > 0) {
      const dirtyOk = markPoolsDirty(changedPools);
      invalidate(admitted > 0 ? "new_pools_admitted" : "pool_topology_updated");
      if (!dirtyOk) topologyDirty = true;
    }
    return admitted;
  }

  function removePools(poolAddresses: Set<string>) {
    if (!fullGraph || !hubGraph || !poolAddresses || poolAddresses.size === 0) return 0;

    let removed = 0;
    for (const addr of poolAddresses) {
      removed += fullGraph.removePool(addr);
      hubGraph.removePool(addr);
    }

    if (removed > 0) {
      const dirtyOk = markPoolsDirty(poolAddresses);
      invalidate("unroutable_pool_removed");
      if (!dirtyOk) topologyDirty = true;
    }
    return removed;
  }

  function resetGraphs() {
    hubGraph = null;
    fullGraph = null;
    cachedCycles = [];
    dirtyPoolAddresses.clear();
    dirtyHubStartTokens.clear();
    invalidate("graphs_reset");
  }

  async function refreshCycles(options: {
    force?: boolean;
    minLiquidityWmatic: bigint;
    selective4HopPathBudget: number;
    selective4HopMaxPathsPerToken: number;
    getRateWei: ((addr: string) => bigint) | null;
    clearExecutionRouteQuarantine?: (reason: string) => void;
  }): Promise<ArbPathLike[]> {
    const force = options.force === true;
    const now = Date.now();
    const intervalElapsed =
      lastCycleRefreshMs <= 0 || now - lastCycleRefreshMs >= deps.cycleRefreshIntervalMs;
    if (!force && !topologyDirty && cachedCycles.length > 0 && !intervalElapsed) return cachedCycles;

    if (cycleRefreshPromise) {
      const shouldQueueRefresh = force || topologyDirty || cachedCycles.length === 0 || intervalElapsed;
      if (!shouldQueueRefresh) return cycleRefreshPromise;

      queuedRefreshForce ||= force || topologyDirty || cachedCycles.length === 0;
      if (!queuedRefreshPromise) {
        queuedRefreshPromise = cycleRefreshPromise
          .catch((err) => {
            deps.log("Cycle refresh failed, using cached cycles", "error", { error: String(err) });
            return cachedCycles;
          })
          .then((): Promise<ArbPathLike[]> => {
            const nextForce = queuedRefreshForce;
            queuedRefreshForce = false;
            return refreshCycles({ ...options, force: nextForce });
          })
          .finally(() => {
            queuedRefreshPromise = null;
          });
      }
      return queuedRefreshPromise;
    }

    cycleRefreshPromise = (async () => {
      deps.log("Refreshing cycle enumeration...", "info", {
        event: "cycle_refresh_start",
        activity: "Refreshing routes",
        activityDetail: force ? "Forced route topology refresh" : "Checking route topology and cache freshness",
        progressLabel: "refresh",
        progressCompleted: 0,
        progressTotal: 5,
        progressUnit: "steps",
        forced: force,
        topologyVersion: topologyVersion + 1,
      });
      const activePools = deps.registry.getActivePoolsMeta() ?? [];
      const universe = routingUniverseSummary(activePools);
      const pools = universe.routable;
      deps.log(`Routing universe: ${pools.length} routable / ${activePools.length} active pools`, "info", {
        event: "routing_universe",
        activity: "Preparing routing universe",
        activityDetail: `${pools.length}/${activePools.length} active pools routable`,
        progressLabel: "refresh",
        progressCompleted: 1,
        progressTotal: 5,
        progressUnit: "steps",
        activePools: activePools.length,
        stateRows: universe.stateRows,
        stateCoverageBps: universe.stateCoverageBps,
        topActiveProtocols: universe.topActiveProtocols,
        topStateProtocols: universe.topStateProtocols,
        topStateCoverageGapsByProtocol: universe.topStateCoverageGapsByProtocol,
        hub4StateCoverageGapsByProtocol: universe.hub4StateCoverageGapsByProtocol,
        topRoutableCoverageGapsByProtocol: universe.topRoutableCoverageGapsByProtocol,
        hub4RoutableCoverageGapsByProtocol: universe.hub4RoutableCoverageGapsByProtocol,
        routablePools: pools.length,
        routableCoverageBps: universe.routableCoverageBps,
        topRoutableProtocols: universe.topRoutableProtocols,
        hubAdjacentPools: universe.hubAdjacentPools,
        hubAdjacentUnroutablePools: universe.hubAdjacentUnroutablePools,
        hubAdjacentRoutableBps: universe.hubAdjacentRoutableBps,
        hubAdjacentHydrationBacklog: universe.hubAdjacentHydrationBacklog,
        hubAdjacentMissingByProtocol: universe.hubAdjacentMissingByProtocol,
        hubAdjacentActionableMissingByProtocol: universe.hubAdjacentActionableMissingByProtocol,
        hubAdjacentInvalidByProtocol: universe.hubAdjacentInvalidByProtocol,
        hubAdjacentObservedUnroutableByProtocol: universe.hubAdjacentObservedUnroutableByProtocol,
        hub4AdjacentPools: universe.hub4AdjacentPools,
        hub4AdjacentUnroutablePools: universe.hub4AdjacentUnroutablePools,
        hub4AdjacentRoutableBps: universe.hub4AdjacentRoutableBps,
        hub4AdjacentHydrationBacklog: universe.hub4AdjacentHydrationBacklog,
        hub4AdjacentMissingByProtocol: universe.hub4AdjacentMissingByProtocol,
        hub4ActionableMissingByProtocol: universe.hub4ActionableMissingByProtocol,
        hub4AdjacentInvalidByProtocol: universe.hub4AdjacentInvalidByProtocol,
        hub4AdjacentObservedUnroutableByProtocol: universe.hub4AdjacentObservedUnroutableByProtocol,
        topUnroutableProtocols: universe.topUnroutableProtocols,
      });

      const rebuildGraphs = force || !fullGraph || !hubGraph || intervalElapsed;
      if (rebuildGraphs) {
        fullGraph = deps.buildGraph(pools, deps.stateCache);
        hubGraph = deps.buildHubGraph(pools, deps.hub4Tokens, deps.stateCache);
        topologyCache.invalidateSerializedTopologies();
        deps.clearGasEstimateCache();
        if (force || topologyDirty) {
          options.clearExecutionRouteQuarantine?.("topology_changed");
        }
      }

      const topologyKeyBase = `topology:${++topologyVersion}`;
      const activeHubGraph = hubGraph!;
      const activeFullGraph = fullGraph!;
      const selective4HopTokens = deps.routingCycleMode === "triangular" || routingMinHops > 4 || routingMaxHops < 4
        ? []
        : selectHighLiquidityHubTokens(activeFullGraph, options.getRateWei);
      const fullPivotTokens = mergeTokenLists(
        selectFullGraphPivotTokens(activeFullGraph, options.getRateWei),
        selective4HopTokens,
      );
      const dirtyStartTokens = [...dirtyHubStartTokens].filter((token) => activeFullGraph.hasToken(token));
      const canUseIncrementalRefresh =
        !rebuildGraphs &&
        topologyDirty &&
        dirtyPoolAddresses.size > 0 &&
        dirtyStartTokens.length > 0 &&
        dirtyStartTokens.length <= Math.max(8, deps.selective4HopTokenLimit * 2);

      const routeCycleCacheKey = await buildRouteCycleCacheKey(pools, options, fullPivotTokens, selective4HopTokens);
      let loadedPersistentCycleCache = false;
      if (!canUseIncrementalRefresh) {
        const cached = topologyCache.readPersistentRouteCycles(
          deps.routeCycleCacheFile,
          routeCycleCacheKey,
          deps.routeCycleCacheMaxAgeMs,
        );
        if (cached.hit) {
          const hydrated = topologyCache.hydratePathCache(cached.paths, activeHubGraph, activeFullGraph, { maxPaths: null });
          if (hydrated.paths.length > 0) {
            const liquidityPrune = pruneCyclesByLiquidity(
              hydrated.paths,
              options.minLiquidityWmatic,
              options.getRateWei,
            );
            const filteredCachedCycles = mergeArbPaths(
              [liquidityPrune.paths],
              {
                minLiquidityWmatic: options.minLiquidityWmatic,
                getRateWei: options.getRateWei,
              },
            );
            if (filteredCachedCycles.length === 0 || liquidityPrune.dropped > 0 || hydrated.rejected > 0) {
              deps.log("[runner] Ignored liquidity-filtered route cycle cache; rebuilding cycles", "warn", {
                event: "route_cycle_cache_unusable",
                activity: "Rebuilding route cycles",
                activityDetail: liquidityPrune.dropped > 0
                  ? "Cached route cycle records were pruned by the active liquidity floor"
                  : "Cached route cycle records no longer satisfy the active liquidity floor",
                progressLabel: "refresh",
                progressCompleted: 2,
                progressTotal: 5,
                progressUnit: "steps",
                cachedPathRecords: hydrated.total,
                droppedCachedPathRecords: hydrated.rejected,
                liquidityPrunedCachedPaths: liquidityPrune.dropped,
                fullPivotTokens: fullPivotTokens.length,
                selective4HopTokens: selective4HopTokens.length,
              });
            } else {
              cachedCycles = filteredCachedCycles;
              loadedPersistentCycleCache = true;
              deps.log("[runner] Loaded precomputed route cycle cache", "info", {
                event: "route_cycle_cache_hit",
                activity: "Loaded route cycle cache",
                activityDetail: `${hydrated.paths.length} cached route cycles hydrated`,
                progressLabel: "refresh",
                progressCompleted: 4,
                progressTotal: 5,
                progressUnit: "steps",
                cachedPaths: cachedCycles.length,
                cachedPathRecords: hydrated.total,
                droppedCachedPathRecords: hydrated.rejected,
                fullPivotTokens: fullPivotTokens.length,
                selective4HopTokens: selective4HopTokens.length,
              });
            }
          } else {
            deps.log("[runner] Ignored unusable route cycle cache; rebuilding cycles", "warn", {
              event: "route_cycle_cache_unusable",
              activity: "Rebuilding route cycles",
              activityDetail: "Cached route cycle records no longer match the active topology",
              progressLabel: "refresh",
              progressCompleted: 2,
              progressTotal: 5,
              progressUnit: "steps",
              cachedPathRecords: hydrated.total,
              droppedCachedPathRecords: hydrated.rejected,
              fullPivotTokens: fullPivotTokens.length,
              selective4HopTokens: selective4HopTokens.length,
            });
          }
        } else if (cached.reason === "expired") {
          deps.log("[runner] Ignored expired route cycle cache; rebuilding cycles", "debug", {
            event: "route_cycle_cache_expired",
            activity: "Rebuilding route cycles",
            activityDetail: "Precomputed route cycle cache expired",
            progressLabel: "refresh",
            progressCompleted: 2,
            progressTotal: 5,
            progressUnit: "steps",
            ageMs: cached.ageMs,
            maxAgeMs: deps.routeCycleCacheMaxAgeMs,
            fullPivotTokens: fullPivotTokens.length,
            selective4HopTokens: selective4HopTokens.length,
          });
        }
      }

      if (loadedPersistentCycleCache) {
        // Cached cycles loaded — skip enumeration.
      } else {
        const enumerationMode = canUseIncrementalRefresh
          ? "incremental"
          : deps.workerCount >= 2 && deps.isWorkerPoolInitialized()
            ? "worker"
            : "inline";
        deps.log("[runner] Enumerating route cycles", "info", {
          event: "route_cycle_enumeration_start",
          activity: "Enumerating route cycles",
          activityDetail: canUseIncrementalRefresh
            ? `${dirtyStartTokens.length} dirty start token(s), ${dirtyPoolAddresses.size} dirty pool(s)`
            : `${fullPivotTokens.length} full pivot token(s), ${selective4HopTokens.length} selective 4-hop token(s)`,
          progressLabel: "refresh",
          progressCompleted: 3,
          progressTotal: 5,
          progressUnit: "steps",
          enumerationMode,
          dirtyPools: dirtyPoolAddresses.size,
          dirtyStartTokens: dirtyStartTokens.length,
          fullPivotTokens: fullPivotTokens.length,
          selective4HopTokens: selective4HopTokens.length,
          routingCycleMode: deps.routingCycleMode,
          routingMinHops,
          routingMaxHops,
          maxTotalPaths: deps.maxTotalPaths,
        });
      }

      if (loadedPersistentCycleCache) {
      } else if (deps.workerCount >= 2 && deps.isWorkerPoolInitialized() && !canUseIncrementalRefresh) {
        const hubTopo = topologyCache.getSerializedTopologyCached("hub", activeHubGraph, deps.serializeTopology);
        const fullTopo = topologyCache.getSerializedTopologyCached("full", activeFullGraph, deps.serializeTopology);
        const hubTokens = [...deps.hub4Tokens].filter((t) => activeHubGraph.hasToken(t));
        const hubTokenRateWeiByToken = tokenRateWeiByToken(activeHubGraph, options.getRateWei);
        const fullTokenRateWeiByToken = tokenRateWeiByToken(activeFullGraph, options.getRateWei);

        const enumerationResults = await Promise.allSettled([
          deps.workerPool.enumerate(hubTopo, hubTokens, {
            ...cycleModeOptions(true),
            maxPathsPerToken: liquidityAwareEnumerationCap(
              deps.maxTotalPaths * 0.5 / Math.max(hubTokens.length, 1),
              options,
            ),
            max4HopPathsPerToken: 2_000,
            minLiquidityWmatic: hubTokenRateWeiByToken ? options.minLiquidityWmatic : 0n,
            tokenRateWeiByToken: hubTokenRateWeiByToken,
            topologyKey: `${topologyKeyBase}:hub`,
          }),
          deps.workerPool.enumerate(fullTopo, fullPivotTokens, {
            ...cycleModeOptions(false),
            maxPathsPerToken: liquidityAwareEnumerationCap(
              deps.maxTotalPaths * 0.35 / Math.max(fullPivotTokens.length, 1),
              options,
            ),
            minLiquidityWmatic: fullTokenRateWeiByToken ? options.minLiquidityWmatic : 0n,
            tokenRateWeiByToken: fullTokenRateWeiByToken,
            topologyKey: `${topologyKeyBase}:full`,
          }),
          selective4HopTokens.length > 0 && routingMinHops <= 4 && routingMaxHops >= 4
            ? deps.workerPool.enumerate(fullTopo, selective4HopTokens, {
                include2Hop: false,
                include3Hop: false,
                include4Hop: true,
                maxHops: 4,
                maxPathsPerToken: liquidityAwareEnumerationCap(
                  Math.min(
                    options.selective4HopMaxPathsPerToken,
                    options.selective4HopPathBudget / Math.max(selective4HopTokens.length, 1),
                  ),
                  options,
                ),
                max4HopPathsPerToken: options.selective4HopMaxPathsPerToken,
                minLiquidityWmatic: fullTokenRateWeiByToken ? options.minLiquidityWmatic : 0n,
                tokenRateWeiByToken: fullTokenRateWeiByToken,
                topologyKey: `${topologyKeyBase}:full`,
              })
            : Promise.resolve([]),
        ]);

        const hubSer = enumerationResults[0].status === "fulfilled" ? enumerationResults[0].value : [];
        const fullSer = enumerationResults[1].status === "fulfilled" ? enumerationResults[1].value : [];
        const selective4HopSer = enumerationResults[2].status === "fulfilled" ? enumerationResults[2].value : [];
        enumerationResults.forEach((r, i) => {
          if (r.status === "rejected") {
            console.warn(`[runner] Enumeration chunk ${i} failed, continuing with partial results:`, r.reason);
          }
        });

        cachedCycles = mergeArbPaths(
          [
            topologyCache.hydratePaths(hubSer, activeHubGraph, activeFullGraph, { maxPaths: null }),
            topologyCache.hydratePaths(fullSer, activeHubGraph, activeFullGraph, { maxPaths: null }),
            topologyCache.hydratePaths(selective4HopSer, activeHubGraph, activeFullGraph, { maxPaths: null }),
          ],
          {
            minLiquidityWmatic: options.minLiquidityWmatic,
            getRateWei: options.getRateWei,
          },
        );
      } else if (canUseIncrementalRefresh) {
        const affectedPoolAddresses = new Set(dirtyPoolAddresses);
        const affectedHubGraphTokens = dirtyStartTokens.filter((token) => deps.hub4Tokens.has(token) && activeHubGraph.hasToken(token));
        const unaffectedCycles = cachedCycles.filter((path) => {
          if (dirtyStartTokens.includes(path.startToken)) return false;
          return !path.edges.some((edge) => affectedPoolAddresses.has(edge.poolAddress.toLowerCase()));
        });
        const partialHubCycles = affectedHubGraphTokens.length > 0
          ? deps.enumerateCycles(activeHubGraph, {
              startTokens: new Set(affectedHubGraphTokens),
              ...cycleModeOptions(true),
              maxPathsPerToken: liquidityAwareEnumerationCap(
                deps.maxTotalPaths * 0.5 / Math.max(affectedHubGraphTokens.length, 1),
                options,
              ),
              max4HopPathsPerToken: 2_000,
              maxTotalPaths: deps.maxTotalPaths,
              minLiquidityWmatic: options.getRateWei ? options.minLiquidityWmatic : 0n,
              getRateWei: options.getRateWei,
            })
          : [];
        const partialFullCycles = deps.enumerateCycles(activeFullGraph, {
          startTokens: new Set(dirtyStartTokens),
          ...cycleModeOptions(false),
          maxPathsPerToken: liquidityAwareEnumerationCap(
            deps.maxTotalPaths * 0.35 / Math.max(dirtyStartTokens.length, 1),
            options,
          ),
          maxTotalPaths: deps.maxTotalPaths,
          minLiquidityWmatic: options.getRateWei ? options.minLiquidityWmatic : 0n,
          getRateWei: options.getRateWei,
        });
        const selectiveDirtyTokens = dirtyStartTokens.filter((token) => selective4HopTokens.includes(token));
        const selective4HopCycles = selectiveDirtyTokens.length > 0 && routingMinHops <= 4 && routingMaxHops >= 4
          ? deps.enumerateCycles(activeFullGraph, {
              startTokens: new Set(selectiveDirtyTokens),
              include2Hop: false,
              include3Hop: false,
              include4Hop: true,
              maxHops: 4,
              maxPathsPerToken: liquidityAwareEnumerationCap(
                Math.min(
                  options.selective4HopMaxPathsPerToken,
                  options.selective4HopPathBudget / Math.max(selectiveDirtyTokens.length, 1),
                ),
                options,
              ),
              max4HopPathsPerToken: options.selective4HopMaxPathsPerToken,
              maxTotalPaths: options.selective4HopPathBudget,
              minLiquidityWmatic: options.getRateWei ? options.minLiquidityWmatic : 0n,
              getRateWei: options.getRateWei,
            })
          : [];
        cachedCycles = mergeArbPaths(
          [unaffectedCycles, partialHubCycles, partialFullCycles, selective4HopCycles],
          {
            minLiquidityWmatic: options.minLiquidityWmatic,
            getRateWei: options.getRateWei,
          },
        );
      } else {
        const baseCycles = deps.enumerateCyclesDual(activeHubGraph, activeFullGraph, {
          ...cycleModeOptions(true),
          hubStartTokens: deps.hub4Tokens,
          fullStartTokens: fullPivotTokens,
          maxPathsPerToken: liquidityAwareEnumerationCap(deps.maxTotalPaths / 7, options),
          max4HopPathsPerToken: 2_000,
          maxTotalPaths: deps.maxTotalPaths,
          minLiquidityWmatic: options.getRateWei ? options.minLiquidityWmatic : 0n,
          getRateWei: options.getRateWei,
        });
        const selective4HopCycles = selective4HopTokens.length > 0 && routingMinHops <= 4 && routingMaxHops >= 4
          ? deps.enumerateCycles(activeFullGraph, {
              startTokens: new Set(selective4HopTokens),
              include2Hop: false,
              include3Hop: false,
              include4Hop: true,
              maxHops: 4,
              maxPathsPerToken: liquidityAwareEnumerationCap(
                Math.min(
                  options.selective4HopMaxPathsPerToken,
                  options.selective4HopPathBudget / Math.max(selective4HopTokens.length, 1),
                ),
                options,
              ),
              max4HopPathsPerToken: options.selective4HopMaxPathsPerToken,
              maxTotalPaths: options.selective4HopPathBudget,
              minLiquidityWmatic: options.getRateWei ? options.minLiquidityWmatic : 0n,
              getRateWei: options.getRateWei,
            })
          : [];
        cachedCycles = mergeArbPaths(
          [baseCycles, selective4HopCycles],
          {
            minLiquidityWmatic: options.minLiquidityWmatic,
            getRateWei: options.getRateWei,
          },
        );
      }

      const liquidityPrune = pruneCyclesByLiquidity(
        cachedCycles,
        options.minLiquidityWmatic,
        options.getRateWei,
      );
      if (liquidityPrune.dropped > 0) {
        cachedCycles = liquidityPrune.paths;
        deps.log("[runner] Pruned low-liquidity route cycles", "info", {
          event: "route_cycle_liquidity_prune",
          activity: "Finalizing route refresh",
          activityDetail: `${liquidityPrune.dropped} path(s) below liquidity floor removed`,
          progressLabel: "refresh",
          progressCompleted: 4,
          progressTotal: 5,
          progressUnit: "steps",
          droppedPaths: liquidityPrune.dropped,
          remainingPaths: cachedCycles.length,
          minLiquidityWmatic: options.minLiquidityWmatic.toString(),
        });
      }

      deps.log("[runner] Finalizing route cycle refresh", "info", {
        event: "route_cycle_finalize",
        activity: "Finalizing route refresh",
        activityDetail: loadedPersistentCycleCache
          ? `${cachedCycles.length} cached path(s) hydrated; pruning stale route cache`
          : `${cachedCycles.length} path(s) enumerated; updating persistent cache and route cache`,
        progressLabel: "refresh",
        progressCompleted: 4,
        progressTotal: 5,
        progressUnit: "steps",
        cachedPaths: cachedCycles.length,
        routeCycleCacheHit: loadedPersistentCycleCache,
        routeCacheSize: deps.routeCache.routes.length,
      });

      if (!loadedPersistentCycleCache) {
        const wroteCache = topologyCache.writePersistentRouteCycles(
          deps.routeCycleCacheFile,
          routeCycleCacheKey,
          cachedCycles,
        );
        if (wroteCache) {
          deps.log("[runner] Stored precomputed route cycle cache", "debug", {
            event: "route_cycle_cache_store",
            activity: "Finalizing route refresh",
            activityDetail: `${cachedCycles.length} precomputed route cycle(s) stored`,
            progressLabel: "refresh",
            progressCompleted: 4,
            progressTotal: 5,
            progressUnit: "steps",
            cachedPaths: cachedCycles.length,
            fullPivotTokens: fullPivotTokens.length,
            selective4HopTokens: selective4HopTokens.length,
          });
        }
      }

      deps.routeCache.prune(deps.stateCache);
      topologyDirty = false;
      dirtyPoolAddresses.clear();
      dirtyHubStartTokens.clear();
      lastCycleRefreshMs = Date.now();
      deps.log(`Cycle refresh: ${cachedCycles.length} paths (${deps.routingCycleMode}, max ${deps.maxTotalPaths}).`, "info", {
        event: "cycle_refresh_complete",
        activity: "Routing refresh complete",
        activityDetail: `${cachedCycles.length} paths ready (${deps.routingCycleMode}, max ${deps.maxTotalPaths})`,
        progressLabel: "refresh",
        progressCompleted: 5,
        progressTotal: 5,
        progressUnit: "steps",
        forced: force,
        topologyVersion,
        cachedPaths: cachedCycles.length,
        maxTotalPaths: deps.maxTotalPaths,
        routingCycleMode: deps.routingCycleMode,
        selective4HopTokens: selective4HopTokens.length,
        fullPivotTokens: fullPivotTokens.length,
        routeCycleCacheHit: loadedPersistentCycleCache,
        routeCacheSize: deps.routeCache.routes.length,
      });
      return cachedCycles;
    })();

    try {
      return await cycleRefreshPromise;
    } finally {
      cycleRefreshPromise = null;
    }
  }

  return {
    getCachedCycles: () => cachedCycles,
    setCachedCycles: (cycles: ArbPathLike[]) => {
      cachedCycles = cycles;
    },
    getTopologyVersion: () => topologyVersion,
    isTopologyDirty: () => topologyDirty,
    invalidate,
    admitPools,
    removePools,
    refreshCycles,
    resetGraphs,
    getGraphs: () => ({ hubGraph, fullGraph }),
  };
}

type WatcherBatchDeps = {
  stateCache: StateCache;
  log: LoggerFn;
  validatePoolState: (state: PoolState | undefined) => { valid: boolean; reason?: string };
  debugInvalidPool?: (address: string, reason?: string) => void;
  removePoolsFromTopology: (poolAddresses: Set<string>) => number;
  removeRoutesByPools: (poolAddresses: Set<string>) => number;
  admitPools: (poolAddresses: Set<string>) => number;
  updatePriceOracle: (changedPools?: Iterable<string>) => void;
  revalidateCachedRoutes: (changedPools: Set<string>) => Promise<unknown>;
};

export function createWatcherBatchCoordinator(deps: WatcherBatchDeps) {
  function partitionChangedPools(changedPools: Set<string>) {
    const valid = new Set<string>();
    const invalid = new Set<string>();

    for (const addr of changedPools) {
      const state = deps.stateCache.get(addr);
      const verdict = deps.validatePoolState(state);
      if (verdict.valid) {
        valid.add(addr);
      } else {
        invalid.add(addr);
        deps.debugInvalidPool?.(addr, verdict.reason);
      }
    }

    return { valid, invalid };
  }

  async function handlePoolsChanged(changedPools: Set<string>) {
    const { valid: validChangedAddrs, invalid: invalidChangedAddrs } = partitionChangedPools(changedPools);

    if (validChangedAddrs.size === 0 && invalidChangedAddrs.size === 0) {
      deps.log("[runner] No usable pool changes in watcher batch", "debug", {
        event: "watcher_batch_skip",
        changedPools: changedPools.size,
      });
      return;
    }

    if (invalidChangedAddrs.size > 0) {
      const removedEdges = deps.removePoolsFromTopology(invalidChangedAddrs);
      const removedRoutes = deps.removeRoutesByPools(invalidChangedAddrs);
      deps.log(
        `[runner] ${invalidChangedAddrs.size} pool(s) became unroutable; ${removedEdges / 2} removed from topology.`,
        "info",
        {
          event: "watcher_batch_remove_unroutable",
          changedPools: changedPools.size,
          invalidPools: invalidChangedAddrs.size,
          removedPools: removedEdges / 2,
          removedRoutes,
        },
      );
    }

    if (validChangedAddrs.size > 0) {
      deps.log(`[watcher] ${validChangedAddrs.size}/${changedPools.size} pool state(s) updated`, "info", {
        event: "watcher_batch_valid",
        changedPools: changedPools.size,
        validPools: validChangedAddrs.size,
      });
      const admitted = deps.admitPools(validChangedAddrs);
      if (admitted > 0) {
        deps.log(`[runner] Admitted ${admitted} newly routable pool(s); refreshing cycles soon.`, "info", {
          event: "watcher_batch_admit",
          changedPools: changedPools.size,
          validPools: validChangedAddrs.size,
          admittedPools: admitted,
        });
      }
      deps.updatePriceOracle(validChangedAddrs);
      await deps.revalidateCachedRoutes(validChangedAddrs);
    }
  }

  return {
    partitionChangedPools,
    handlePoolsChanged,
  };
}

type WatcherHaltDeps = {
  log: LoggerFn;
  setRunning: (running: boolean) => void;
  setBotStatus: (status: "idle" | "running" | "error") => void;
  cancelScheduledArb: () => void;
  stopHeartbeat: () => void;
  recordWatcherHalt: (payload: Record<string, unknown>) => void;
};

export function createWatcherHaltCoordinator(deps: WatcherHaltDeps) {
  function handleHaltDetected(payload: Record<string, unknown>) {
    deps.setRunning(false);
    deps.setBotStatus("error");
    deps.cancelScheduledArb();
    deps.stopHeartbeat();
    deps.recordWatcherHalt(payload);
    deps.log("[runner] Watcher halted; arb loop disabled until restart", "error", {
      event: "watcher_halt",
      ...payload,
    });
  }

  return {
    handleHaltDetected,
  };
}

type MainLoggerFn = (msg: string, level?: Level, meta?: unknown) => void;
type ShutdownReason = "signal" | "fatal" | "complete";
type ShutdownFn = (exitCodeOrSignal?: number | string, reason?: ShutdownReason) => unknown;
type ProcessSignalRegistrar = {
  on: (signal: string, listener: (...args: unknown[]) => void) => unknown;
};

type MainWorkerPoolLike = {
  init: () => void;
};

type RunnerMainDeps<Registry, Repositories> = {
  tuiMode: boolean;
  liveMode: boolean;
  bootModeCoordinator: {
    startOperatorSurface: (tuiMode: boolean) => Promise<unknown>;
    runAfterBootstrap: () => Promise<unknown>;
  };
  startupCoordinator: {
    initializeRuntime: () => { registry: Registry; repositories: Repositories };
    bootstrapRouting: () => Promise<unknown>;
  };
  setRuntime: (initialized: { registry: Registry; repositories: Repositories }) => void;
  processLike: ProcessSignalRegistrar;
  shutdown: ShutdownFn;
  workerCount?: number;
  evalWorkerThreshold?: number;
  workerPool?: MainWorkerPoolLike;
  log: MainLoggerFn;
  rootLogger?: {
    fatal: (payload: unknown, message?: string) => void;
  };
};

function registerShutdownSignals(
  processLike: ProcessSignalRegistrar,
  shutdown: ShutdownFn,
) {
  processLike.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  processLike.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  processLike.on("unhandledRejection", (reason: unknown) => {
    console.error("[runner] Unhandled promise rejection:", reason instanceof Error ? reason.stack : String(reason));
  });
  processLike.on("uncaughtException", (error: unknown) => {
    const e = error as Error | undefined;
    console.error("[runner] Uncaught exception:", e?.stack || e?.message || String(error));
    void shutdown("fatal");
  });
}

function startWorkerPoolIfConfigured({
  workerCount,
  evalWorkerThreshold,
  workerPool,
  log,
}: {
  workerCount: number;
  evalWorkerThreshold: number;
  workerPool: MainWorkerPoolLike;
  log: MainLoggerFn;
}) {
  if (workerCount < 2) return false;
  workerPool.init();
  log(`Worker pool: ${workerCount} threads (threshold: ${evalWorkerThreshold} paths)`);
  return true;
}

export function createRunnerMainController<Registry, Repositories>(deps: RunnerMainDeps<Registry, Repositories>) {
  const workerPool = deps.workerPool ?? defaultWorkerPool;
  const rootLogger = deps.rootLogger ?? defaultRootLogger;
  const workerCount = deps.workerCount ?? WORKER_COUNT;
  const evalWorkerThreshold = deps.evalWorkerThreshold ?? EVAL_WORKER_THRESHOLD;
  async function run() {
    await deps.bootModeCoordinator.startOperatorSurface(deps.tuiMode);

    deps.setRuntime(deps.startupCoordinator.initializeRuntime());

    // Warn if RPC roles share a single endpoint in live mode — hurts race competitiveness
    if (deps.liveMode) {
      try {
        // Dynamic import to avoid hard dependency at module level
        const { GAS_ESTIMATION_RPC_URL, EXECUTION_RPC_URL, POLYGON_RPC_URL } = await import("../config/rpc_env.ts");
        if (GAS_ESTIMATION_RPC_URL === POLYGON_RPC_URL) {
          deps.log("RPC role not separated", "warn", {
            event: "rpc_role_not_separated",
            role: "GAS_ESTIMATION_RPC",
            message: "GAS_ESTIMATION_RPC falls back to POLYGON_RPC — gas estimation shares read connection, risking rate-limit cross-contamination and inaccurate pending-state simulation. Set a dedicated GAS_ESTIMATION_RPC for best results.",
          });
        }
        if (EXECUTION_RPC_URL === POLYGON_RPC_URL) {
          deps.log("RPC role not separated", "warn", {
            event: "rpc_role_not_separated",
            role: "EXECUTION_RPC",
            message: "EXECUTION_RPC falls back to POLYGON_RPC — transaction submission shares read connection, risking rate-limit contention and latency. Set a dedicated EXECUTION_RPC for best results.",
          });
        }
      } catch {
        // Config module may not be importable in all environments; skip warning silently.
      }
    }

    registerShutdownSignals(deps.processLike, deps.shutdown);
    startWorkerPoolIfConfigured({
      workerCount,
      evalWorkerThreshold,
      workerPool,
      log: deps.log,
    });

    await deps.startupCoordinator.bootstrapRouting();
    await deps.bootModeCoordinator.runAfterBootstrap();
  }

  function handleFatal(err: unknown) {
    rootLogger.fatal({ event: "main_fatal", err }, "Fatal error");
    void deps.shutdown(1, "fatal");
  }

  return {
    run,
    handleFatal,
  };
}

type RunnerTopologyRefreshTarget<Cycle> = {
  refreshCycles: (force?: boolean) => Promise<Cycle[] | void>;
};

type RunnerPassTarget<PassResult> = {
  runPass: () => Promise<PassResult>;
};

type RunnerDeferredActionDeps<Cycle, PassResult> = {
  getTopologyAdapters: () => RunnerTopologyRefreshTarget<Cycle> | null | undefined;
  getPassCoordinator: () => RunnerPassTarget<PassResult> | null | undefined;
};

function requireInitialized<T>(target: T | null | undefined, name: string): T {
  if (!target) {
    throw new Error(`${name} is not initialized`);
  }
  return target;
}

export function createRunnerDeferredActions<Cycle = unknown, PassResult = void>({
  getTopologyAdapters,
  getPassCoordinator,
}: RunnerDeferredActionDeps<Cycle, PassResult>) {
  return {
    refreshCycles: async (force = false) =>
      requireInitialized(getTopologyAdapters(), "Runner topology adapters").refreshCycles(force),
    runPass: async () =>
      requireInitialized(getPassCoordinator(), "Runner pass coordinator").runPass(),
  };
}

export const DEFAULT_MIN_LIQUIDITY_WMATIC = 7_143n * 10n ** 18n;

type RunnerTopologyAdaptersDeps = {
  routingCycleMode?: "all" | "triangular";
  routingMinHops?: number;
  routingMaxHops?: number;
  maxTotalPaths?: number;
  polygonHubTokens?: Set<string>;
  hub4Tokens?: Set<string>;
  selective4HopTokenLimit?: number;
  dynamicPivotTokenLimit?: number;
  routeCycleCacheFile?: string | null;
  routeCycleCacheMaxAgeMs?: number;
  workerCount?: number;
  workerPool?: {
    initialized: boolean;
    enumerate: (topology: SerializedTopology, startTokens: string[], options: Record<string, unknown>) => Promise<SerializedEnumeratedPath[]>;
  };
  cycleRefreshIntervalMs?: number;
  routeCache: Pick<RouteCacheType, "prune" | "routes">;
  stateCache: RuntimeStateCache;
  registryReadAccess: {
    getActivePoolMeta: () => PoolRecordBase[];
    getPoolMeta: (address: string) => PoolRecordBase | undefined;
  };
  validatePoolState?: (state: RuntimeState | undefined) => { valid: boolean; reason?: string };
  log: LoggerFn;
  getPriceOracle: () => PriceOracleLikeTopology;
  clearExecutionRouteQuarantine: (reason: string) => void;
  maxPriceAgeMs?: number;
  minLiquidityWmatic?: bigint;
  selective4HopPathBudget?: number;
  selective4HopMaxPathsPerToken?: number;
};

export function createRunnerTopologyAdapters(deps: RunnerTopologyAdaptersDeps) {
  const workerPool = deps.workerPool ?? defaultWorkerPool;
  const validatePoolState = deps.validatePoolState ?? defaultValidatePoolState;
  const topologyService = createTopologyService({
    routingCycleMode: deps.routingCycleMode ?? ROUTING_CYCLE_MODE,
    routingMinHops: deps.routingMinHops ?? ROUTING_MIN_HOPS,
    routingMaxHops: deps.routingMaxHops ?? ROUTING_MAX_HOPS,
    maxTotalPaths: deps.maxTotalPaths ?? MAX_TOTAL_PATHS,
    polygonHubTokens: deps.polygonHubTokens ?? POLYGON_HUB_TOKENS,
    hub4Tokens: deps.hub4Tokens ?? HUB_4_TOKENS,
    selective4HopTokenLimit: deps.selective4HopTokenLimit ?? SELECTIVE_4HOP_TOKEN_LIMIT,
    dynamicPivotTokenLimit: deps.dynamicPivotTokenLimit ?? DYNAMIC_PIVOT_TOKEN_LIMIT,
    routeCycleCacheFile: deps.routeCycleCacheFile ?? ROUTE_CYCLE_CACHE_FILE,
    routeCycleCacheMaxAgeMs: deps.routeCycleCacheMaxAgeMs ?? ROUTE_CYCLE_CACHE_MAX_AGE_MS,
    workerCount: deps.workerCount ?? WORKER_COUNT,
    workerPool,
    isWorkerPoolInitialized: () => workerPool.initialized,
    cycleRefreshIntervalMs: deps.cycleRefreshIntervalMs ?? CYCLE_REFRESH_INTERVAL_MS,
    routeCache: deps.routeCache,
    stateCache: deps.stateCache,
    registry: {
      getActivePoolsMeta: deps.registryReadAccess.getActivePoolMeta,
      getPoolMeta: deps.registryReadAccess.getPoolMeta,
    },
    buildGraph,
    buildHubGraph,
    serializeTopology,
    enumerateCycles,
    enumerateCyclesDual,
    validatePoolState,
    clearGasEstimateCache,
    log: deps.log,
  });

  const topologyRefreshCoordinator = createTopologyRefreshCoordinator({
    getPriceOracle: deps.getPriceOracle,
    getTopologyService: () => topologyService,
    clearExecutionRouteQuarantine: deps.clearExecutionRouteQuarantine,
    maxPriceAgeMs: deps.maxPriceAgeMs ?? 30_000,
    minLiquidityWmatic: deps.minLiquidityWmatic ?? DEFAULT_MIN_LIQUIDITY_WMATIC,
    selective4HopPathBudget: deps.selective4HopPathBudget ?? SELECTIVE_4HOP_PATH_BUDGET,
    selective4HopMaxPathsPerToken: deps.selective4HopMaxPathsPerToken ?? SELECTIVE_4HOP_MAX_PATHS_PER_TOKEN,
  });

  return {
    topologyService,
    topologyRefreshCoordinator,
    refreshCycles: (force = false): Promise<ArbPathLike[] | void> =>
      topologyRefreshCoordinator.refreshCycles(force),
    getCachedCycles: () => topologyService.getCachedCycles(),
    getCachedCycleCount: () => topologyService.getCachedCycles().length,
    isTopologyDirty: () => topologyService.isTopologyDirty(),
    admitPools: (poolAddresses: Set<string>) => topologyService.admitPools(poolAddresses),
    removePools: (poolAddresses: Set<string>) => topologyService.removePools(poolAddresses),
    invalidate: (reason?: string) => topologyService.invalidate(reason),
    clearCycles: () => topologyService.setCachedCycles([]),
    resetGraphs: () => topologyService.resetGraphs(),
  };
}

type RunnerWatcherStateCache = Map<string, Record<string, unknown>>;

type RunnerWatcherAdaptersDeps = {
  stateCache: RunnerWatcherStateCache;
  log: LoggerFn;
  debugInvalidPool?: (address: string, reason?: string) => void;
  validatePoolState?: (state: Record<string, unknown> | undefined) => { valid: boolean; reason?: string };
  removePoolsFromTopology: (poolAddresses: Set<string>) => number;
  removeRoutesByPools: (poolAddresses: Set<string>) => number;
  admitPools: (poolAddresses: Set<string>) => number;
  updatePriceOracle: (changedPools?: Iterable<string>) => void;
  revalidateCachedRoutes: (changedPools: Set<string>) => Promise<unknown>;
  clearRouteCache: () => void;
  clearTopologyCycles: () => void;
  resetTopology: () => void;
  setRunning: (running: boolean) => void;
  setBotStatus: (status: "idle" | "running" | "error") => void;
  cancelScheduledArb: () => void;
  stopHeartbeat: () => void;
  recordWatcherHalt?: (payload: Record<string, unknown>) => void;
  scheduleArb: (changedPools?: number) => void;
};

export function createRunnerWatcherAdapters(deps: RunnerWatcherAdaptersDeps) {
  const validatePoolState = deps.validatePoolState ?? defaultValidatePoolState;
  const runnerLogger = defaultLogger.child({ component: "runner" });
  const debugInvalidPool = deps.debugInvalidPool ?? ((addr: string, reason?: string) => {
    runnerLogger.debug(`[runner] Pool ${addr} is currently unroutable: ${reason ?? "invalid state"}`);
  });
  const watcherBatchCoordinator = createWatcherBatchCoordinator({
    stateCache: deps.stateCache,
    log: deps.log,
    validatePoolState,
    debugInvalidPool,
    removePoolsFromTopology: deps.removePoolsFromTopology,
    removeRoutesByPools: deps.removeRoutesByPools,
    admitPools: deps.admitPools,
    updatePriceOracle: deps.updatePriceOracle,
    revalidateCachedRoutes: deps.revalidateCachedRoutes,
  });
  const reorgRecoveryCoordinator = createReorgRecoveryCoordinator({
    log: deps.log,
    clearRouteCache: deps.clearRouteCache,
    clearTopologyCycles: deps.clearTopologyCycles,
    resetTopology: deps.resetTopology,
    refreshPriceOracle: () => deps.updatePriceOracle(),
  });
  const watcherHaltCoordinator = createWatcherHaltCoordinator({
    log: deps.log,
    setRunning: deps.setRunning,
    setBotStatus: deps.setBotStatus,
    cancelScheduledArb: deps.cancelScheduledArb,
    stopHeartbeat: deps.stopHeartbeat,
    recordWatcherHalt: deps.recordWatcherHalt ?? defaultRecordWatcherHalt,
  });
  const configureWatcher = createWatcherConfigurator({
    log: deps.log,
    handlePoolsChanged: (changedPools) => watcherBatchCoordinator.handlePoolsChanged(changedPools),
    handleReorgDetected: (reorgBlock, changedPools) => {
      reorgRecoveryCoordinator.handleReorgDetected(reorgBlock, changedPools);
    },
    handleHaltDetected: (payload) => {
      watcherHaltCoordinator.handleHaltDetected(payload);
    },
    scheduleArb: deps.scheduleArb,
  });

  return {
    watcherBatchCoordinator,
    reorgRecoveryCoordinator,
    watcherHaltCoordinator,
    configureWatcher,
  };
}

type RunnerPassCoordinatorStateCache = Map<unknown, unknown>;

type BotTelemetryLike = {
  setPassState: (update: PassStateUpdate) => void;
  setPassErrorState: (update: PassErrorStateUpdate) => void;
};

type RunnerPassCoordinatorDeps = {
  stateCache: RunnerPassCoordinatorStateCache;
  getCachedCycleCount: () => number;
  incrementPassCount: () => number;
  getConsecutiveErrors: () => number;
  incrementConsecutiveErrors: () => number;
  resetConsecutiveErrors: () => void;
  botTelemetry: BotTelemetryLike;
  log: LoggerFn;
  trackBackgroundTask: (task: Promise<unknown>) => void;
  maybeRunDiscovery: () => Promise<unknown>;
  reconcileDiscoveryResult: (result: unknown) => Promise<unknown>;
  refreshCycles: () => Promise<unknown>;
  maybeHydrateQuietPools: () => Promise<unknown>;
  refreshPriceOracleIfStale: () => void;
  searchOpportunities: () => Promise<ExecutableCandidate[]>;
  executeBatchIfIdle: (candidates: ExecutableCandidate[], reason: string) => Promise<unknown>;
  formatProfit: (profit: bigint, startToken: string) => string;
  maxConsecutiveErrors?: number;
  maxExecutionBatch?: number;
  sleep?: (ms: number) => Promise<unknown>;
  recordTxAttempt?: (success: boolean, profitWei?: bigint) => void;
};

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRunnerPassCoordinator(deps: RunnerPassCoordinatorDeps) {
  const passRunner = createPassRunner({
    getStateCacheSize: () => deps.stateCache.size,
    getCachedCycleCount: deps.getCachedCycleCount,
    incrementPassCount: deps.incrementPassCount,
    getConsecutiveErrors: deps.getConsecutiveErrors,
    incrementConsecutiveErrors: deps.incrementConsecutiveErrors,
    resetConsecutiveErrors: deps.resetConsecutiveErrors,
    setBotState: deps.botTelemetry.setPassState,
    setBotErrorState: deps.botTelemetry.setPassErrorState,
    log: deps.log,
    trackBackgroundTask: deps.trackBackgroundTask,
    maybeRunDiscovery: deps.maybeRunDiscovery,
    reconcileDiscoveryResult: deps.reconcileDiscoveryResult,
    refreshCycles: deps.refreshCycles,
    maybeHydrateQuietPools: deps.maybeHydrateQuietPools,
    refreshPriceOracleIfStale: deps.refreshPriceOracleIfStale,
    searchOpportunities: deps.searchOpportunities,
    executeBatchIfIdle: (candidates, reason) => deps.executeBatchIfIdle(candidates as ExecutableCandidate[], reason),
    formatProfit: deps.formatProfit,
    roiForCandidate: (candidate) => roiForCandidate(candidate as CandidateEntry),
    formatDuration,
    sleep: deps.sleep ?? defaultSleep,
    maxConsecutiveErrors: deps.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS,
    maxExecutionBatch: deps.maxExecutionBatch ?? 3,
    recordTxAttempt: deps.recordTxAttempt,
  });

  return {
    passRunner,
    runPass: () => passRunner.runPass(),
  };
}

type StoppableWatcher = {
  stop: () => Promise<void>;
};

type StoppableOracle = {
  stop: () => void;
};

type ShutdownRegistry = {
  close: () => void;
};

type ProcessWorkerPoolLike = {
  terminate: () => Promise<void>;
};

type RunnerProcessControlDeps = {
  isRunning: () => boolean;
  setRunning: (running: boolean) => void;
  getWatcher: () => StoppableWatcher | null;
  recordArbActivity: (changedPools: number) => void;
  getAdaptiveDebounceMs: () => number;
  runPass: () => Promise<void>;
  shouldRunPass?: () => { ok: boolean; reason?: string; thermalState?: string };
  log: LoggerFn;
  heartbeatIntervalMs: number;
  stopTui: () => void;
  gasOracle?: StoppableOracle | null;
  getRegistry: () => ShutdownRegistry | null;
  workerPool?: ProcessWorkerPoolLike;
  stopMetricsServer?: () => void;
  exit: (code: number) => never;
};

export function createRunnerProcessControl(deps: RunnerProcessControlDeps) {
  const backgroundTaskTracker = createBackgroundTaskTracker();
  async function guardedRunPass() {
    const decision = deps.shouldRunPass?.() ?? { ok: true };
    if (!decision.ok) {
      deps.log("[runner] Skipping arb pass due to resource guard", "warn", {
        event: "resource_guard_skip",
        reason: decision.reason ?? "resource_pressure",
        thermalState: decision.thermalState,
      });
      return;
    }
    await deps.runPass();
  }
  const arbScheduler = createArbScheduler({
    isRunning: deps.isRunning,
    recordArbActivity: deps.recordArbActivity,
    getAdaptiveDebounceMs: deps.getAdaptiveDebounceMs,
    runPass: guardedRunPass,
    onRunError: (err) => {
      deps.log(`Scheduled arb pass failed: ${errorMessage(err)}`, "error", {
        event: "scheduled_arb_error",
        err,
      });
    },
  });
  const heartbeatController = createHeartbeatController({
    intervalMs: deps.heartbeatIntervalMs,
    onHeartbeat: arbScheduler.scheduleArb,
  });
  const shutdown = createShutdownHandler({
    log: deps.log,
    setRunning: deps.setRunning,
    stopTui: deps.stopTui,
    getWatcher: deps.getWatcher,
    gasOracle: deps.gasOracle ?? defaultGasOracle,
    getRegistry: deps.getRegistry,
    workerPool: deps.workerPool ?? defaultWorkerPool,
    stopMetricsServer: deps.stopMetricsServer ?? defaultStopMetricsServer,
    stopHeartbeat: heartbeatController.stop,
    cancelScheduledArb: arbScheduler.cancelScheduledArb,
    waitForArbIdle: arbScheduler.waitForIdle,
    waitForBackgroundTasks: backgroundTaskTracker.waitForIdle,
    exit: deps.exit,
  });

  return {
    scheduleArb: arbScheduler.scheduleArb,
    cancelScheduledArb: arbScheduler.cancelScheduledArb,
    waitForArbIdle: arbScheduler.waitForIdle,
    startHeartbeat: heartbeatController.start,
    stopHeartbeat: heartbeatController.stop,
    isHeartbeatRunning: heartbeatController.isRunning,
    trackBackgroundTask: backgroundTaskTracker.track,
    waitForBackgroundTasks: backgroundTaskTracker.waitForIdle,
    backgroundTaskCount: backgroundTaskTracker.size,
    shutdown,
  };
}

type WatcherLikeBootSurface = {
  start: (cursor?: unknown) => Promise<unknown>;
  wait: () => Promise<unknown>;
  haltMeta?: { reason?: unknown } | null;
};

type RunnerBootSurfaceDeps<BotStateGeneric extends BotState> = {
  botState: BotStateGeneric;
  setBotStatus: (status: "running") => void;
  getRegistry: () => unknown;
  stateCache: RuntimeStateCache;
  setWatcher: (watcher: WatcherLikeBootSurface | null) => void;
  configureWatcher: (watcher: WatcherLikeBootSurface) => void;
  log: LoggerFn;
  loopMode: boolean;
  discoveryOnly: boolean;
  envioApiToken?: string | null;
  runPass: () => Promise<void>;
  shutdown: () => Promise<void>;
  fastArbDebounceMs?: number;
  baseArbDebounceMs?: number;
  heartbeatIntervalMs: number;
  startHeartbeat: () => void;
  scheduleArb: () => void;
  stopHeartbeat: () => void;
  startRealtimeFeeds?: () => void;
  stopRealtimeFeeds?: () => void;
  metricsPort?: number;
  workerCount?: number;
  maxTotalPaths?: number;
  startTui?: (botState: BotStateGeneric) => Promise<() => void>;
  startMetricsServer?: (port: number) => void;
  createWatcher?: () => WatcherLikeBootSurface;
  markWatcherHealthy?: () => void;
};

async function defaultStartTui<BotStateGeneric extends BotState>(botState: BotStateGeneric) {
  const { startTui } = await import("../tui/index.tsx");
  return startTui(botState);
}

function createDefaultWatcher(registry: unknown, stateCache: RuntimeStateCache) {
  return new StateWatcher(registry, stateCache);
}

export function createRunnerBootSurface<BotStateGeneric extends BotState = BotState>(
  deps: RunnerBootSurfaceDeps<BotStateGeneric>,
) {
  let stopTui: (() => void) | null = null;
  const metricsPort = deps.metricsPort ?? METRICS_PORT;
  const workerCount = deps.workerCount ?? WORKER_COUNT;
  const maxTotalPaths = deps.maxTotalPaths ?? MAX_TOTAL_PATHS;

  const bootModeCoordinator = createBootModeCoordinator({
    botState: deps.botState,
    setBotStatus: deps.setBotStatus,
    setStopTui: (next) => {
      stopTui = next;
    },
    startTui: deps.startTui ?? defaultStartTui,
    startMetricsServer: () => {
      (deps.startMetricsServer ?? defaultStartMetricsServer)(metricsPort);
    },
    printBanner: () => {
      printStartupBanner({ workerCount, maxTotalPaths });
    },
    loopMode: deps.loopMode,
    discoveryOnly: deps.discoveryOnly,
    envioApiToken: deps.envioApiToken ?? ENVIO_API_TOKEN,
    runPass: deps.runPass,
    shutdown: deps.shutdown,
    createWatcher: deps.createWatcher ?? (() => createDefaultWatcher(deps.getRegistry(), deps.stateCache)),
    setWatcher: deps.setWatcher,
    configureWatcher: deps.configureWatcher,
    log: deps.log,
    fastArbDebounceMs: deps.fastArbDebounceMs ?? 50,
    baseArbDebounceMs: deps.baseArbDebounceMs ?? 200,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
    formatDuration,
    setWatcherHealthy: deps.markWatcherHealthy ?? setWatcherHealthy,
    startHeartbeat: deps.startHeartbeat,
    scheduleArb: deps.scheduleArb,
    stopHeartbeat: deps.stopHeartbeat,
    startRealtimeFeeds: deps.startRealtimeFeeds,
    stopRealtimeFeeds: deps.stopRealtimeFeeds,
  });

  return {
    bootModeCoordinator,
    stopTui: () => {
      stopTui?.();
      stopTui = null;
    },
  };
}

type PoolLike = {
  tokens?: unknown;
};

type StateCacheLike = Map<string, { timestamp?: number } | undefined>;

type DecimalAwareFetcher<Result> = (
  pool: PoolLike,
  options: { tokenDecimals?: Map<string, number> | null },
) => Promise<Result>;

type NormalizedPoolFetchResult = {
  addr: string;
  normalized: Record<string, unknown>;
};

type RunnerMarketDataAdaptersDeps<
  CurveResult = NormalizedPoolFetchResult,
  DodoResult = NormalizedPoolFetchResult,
  WoofiResult = NormalizedPoolFetchResult,
> = {
  getRepositories: () => RegistryRepositories | null | undefined;
  getPriceOracle: () => PriceOracleLikeMarketData;
  stateCache: StateCacheLike;
  resolvePoolTokens?: (pool: PoolLike) => string[];
  fetchAndNormalizeCurvePool?: DecimalAwareFetcher<CurveResult>;
  fetchAndNormalizeDodoPool?: DecimalAwareFetcher<DodoResult>;
  fetchAndNormalizeWoofiPool?: DecimalAwareFetcher<WoofiResult>;
  maxPriceAgeMs?: number;
  minProbeAmount?: bigint;
  testAmountWei: bigint;
  routeStateMaxAgeMs?: number;
  routeStateMaxSkewMs?: number;
};

export function createRunnerMarketDataAdapters<
  CurveResult = NormalizedPoolFetchResult,
  DodoResult = NormalizedPoolFetchResult,
  WoofiResult = NormalizedPoolFetchResult,
>({
  getRepositories,
  getPriceOracle,
  stateCache,
  resolvePoolTokens,
  fetchAndNormalizeCurvePool,
  fetchAndNormalizeDodoPool,
  fetchAndNormalizeWoofiPool,
  maxPriceAgeMs,
  minProbeAmount,
  testAmountWei,
  routeStateMaxAgeMs,
  routeStateMaxSkewMs,
}: RunnerMarketDataAdaptersDeps<CurveResult, DodoResult, WoofiResult>) {
  const resolvedPoolTokens = getPoolTokens;
  const curveFetcher = fetchAndNormalizeCurvePool ?? (defaultFetchAndNormalizeCurvePool as DecimalAwareFetcher<CurveResult>);
  const dodoFetcher = fetchAndNormalizeDodoPool ?? (defaultFetchAndNormalizeDodoPool as DecimalAwareFetcher<DodoResult>);
  const woofiFetcher = fetchAndNormalizeWoofiPool ?? (defaultFetchAndNormalizeWoofiPool as DecimalAwareFetcher<WoofiResult>);
  const registryReadAccess = createRegistryReadAccess({ getRepositories });
  const pricingService = createPricingService({
    getTokenMeta: (tokenAddress: string) => getRepositories()?.tokens.getMeta(tokenAddress),
    getPriceOracle,
    maxPriceAgeMs: maxPriceAgeMs ?? 30_000,
    minProbeAmount: minProbeAmount ?? 1_000n,
    testAmountWei,
  });
  const getRouteFreshness = createRouteFreshnessReader({
    stateCache,
    maxAgeMs: routeStateMaxAgeMs ?? ROUTE_STATE_MAX_AGE_MS,
    maxSkewMs: routeStateMaxSkewMs ?? ROUTE_STATE_MAX_SKEW_MS,
  });
  const decimalAwarePoolStateFetchers = createDecimalAwarePoolStateFetchers({
    getPoolTokens: resolvedPoolTokens,
    getTokenDecimals: registryReadAccess.getTokenDecimals,
    fetchAndNormalizeCurvePool: curveFetcher,
    fetchAndNormalizeDodoPool: dodoFetcher,
    fetchAndNormalizeWoofiPool: woofiFetcher,
  });

  return {
    registryReadAccess,
    pricingService,
    getRouteFreshness,
    decimalAwarePoolStateFetchers,
    fmtPath: (path: ArbPathLike) => formatRoutePath(path, (token) => pricingService.fmtSym(token)),
  };
}

type CounterMetric = {
  inc: (labels: Record<string, unknown>, value: number) => void;
};

type ObserverMetric = {
  observe: (value: number) => void;
};

type RunnerMetrics = {
  pathsEvaluated: CounterMetric;
  arbsFound: CounterMetric;
  candidateShortlistSize: ObserverMetric;
  candidateOptimizedCount: ObserverMetric;
  candidateProfitableCount: ObserverMetric;
  candidateProfitableYield: ObserverMetric;
  txAttempted: CounterMetric;
  txSuccessful: CounterMetric;
  txReverted: CounterMetric;
  profitAccumulator: ObserverMetric;
};

type DefaultFeeSnapshot = NonNullable<Awaited<ReturnType<typeof defaultFetchFees>>>;
type FeeFetcher<T extends FeeSnapshotLike> = () => Promise<T | null | undefined>;

const defaultMetrics: RunnerMetrics = {
  pathsEvaluated,
  arbsFound,
  candidateShortlistSize,
  candidateOptimizedCount,
  candidateProfitableCount,
  candidateProfitableYield,
  txAttempted,
  txSuccessful,
  txReverted,
  profitAccumulator,
};

type RunnerRuntimeBaseDeps = {
  discoveryOnly: boolean;
  loopMode: boolean;
  liveMode: boolean;
  routeCacheSize?: number;
  runnerLogger?: Pick<PinoLogger, Level | "isLevelEnabled">;
  metrics?: RunnerMetrics;
  maxGasAgeMs?: number;
  arbActivityWindowMs?: number;
  arbBurstPoolThreshold?: number;
  baseArbDebounceMs?: number;
  fastArbDebounceMs?: number;
};

type RunnerRuntimeDeps<T extends FeeSnapshotLike> = RunnerRuntimeBaseDeps & {
  fetchFees?: FeeFetcher<T>;
};

function createRunnerRuntimeWithFetcher<T extends FeeSnapshotLike>(
  deps: RunnerRuntimeBaseDeps,
  fetchFees: FeeFetcher<T>,
) {
  const metrics = deps.metrics ?? defaultMetrics;
  const runnerLogger = deps.runnerLogger ?? defaultLogger.child({ component: "runner" });
  const runtime = createRuntimeContext({
    routeCacheSize: deps.routeCacheSize ?? 1_000,
    initialBotState: createInitialBotState({
      discoveryOnly: deps.discoveryOnly,
      loopMode: deps.loopMode,
      liveMode: deps.liveMode,
    }),
  });
  const { stateCache, routeCache, botState } = runtime;
  const botTelemetry = createBotTelemetry({
    ...metrics,
    state: botState,
    getPassCount: () => runtime.getPassCount(),
    pathsEvaluated,
    arbsFound,
    candidateShortlistSize,
    candidateOptimizedCount,
    candidateProfitableCount,
    candidateProfitableYield,
    txAttempted,
    txSuccessful,
    txReverted,
    profitAccumulator,
  });
  const log = createOperatorLogger(botState, runnerLogger);
  const getCurrentFeeSnapshot = createCurrentFeeSnapshotReader({
    fetchFees,
    maxAgeMs: deps.maxGasAgeMs ?? 10_000,
    setGasPrice: (gasPrice) => {
      botState.gasPrice = gasPrice;
    },
  });
  const arbActivityTracker = createArbActivityTracker({
    windowMs: deps.arbActivityWindowMs ?? 1_000,
    burstPoolThreshold: deps.arbBurstPoolThreshold ?? 10,
    baseDebounceMs: deps.baseArbDebounceMs ?? 200,
    fastDebounceMs: deps.fastArbDebounceMs ?? 50,
  });

  return {
    runtime,
    stateCache,
    routeCache,
    botState,
    botTelemetry,
    log,
    getCurrentFeeSnapshot,
    arbActivityTracker,
  };
}

export function createRunnerRuntime(
  deps: RunnerRuntimeBaseDeps & { fetchFees?: undefined },
): ReturnType<typeof createRunnerRuntimeWithFetcher<DefaultFeeSnapshot>>;
export function createRunnerRuntime<T extends FeeSnapshotLike>(
  deps: RunnerRuntimeBaseDeps & { fetchFees: FeeFetcher<T> },
): ReturnType<typeof createRunnerRuntimeWithFetcher<T>>;
export function createRunnerRuntime(deps: RunnerRuntimeDeps<FeeSnapshotLike>) {
  return createRunnerRuntimeWithFetcher(
    deps,
    deps.fetchFees ?? defaultFetchFees,
  );
}

function isPriceOracleRegistry(registry: unknown): registry is PriceOracleRegistry {
  return (
    registry != null &&
    typeof registry === "object" &&
    typeof (registry as { getPoolMeta?: unknown }).getPoolMeta === "function" &&
    (
      !("getTokenMeta" in registry) ||
      typeof (registry as { getTokenMeta?: unknown }).getTokenMeta === "function"
    )
  );
}

function createDefaultPriceOracle(stateCache: RuntimeStateCache, registry: unknown) {
  if (!isPriceOracleRegistry(registry)) {
    throw new Error("Default PriceOracle requires a registry with getPoolMeta()");
  }
  return new PriceOracle(stateCache, registry);
}

type RunnerStartupDeps<Registry, Repositories, PriceOracleLikeGeneric, NonceManagerLikeGeneric> = {
  dbPath?: string;
  stateCache: RuntimeStateCache;
  log: LoggerFn;
  setPriceOracle: (oracle: PriceOracleLikeGeneric) => void;
  setNonceManager: (nonceManager: NonceManagerLikeGeneric) => void;
  runInitialDiscovery: () => Promise<unknown>;
  seedStateCache: () => void;
  warmupStateCache: () => Promise<unknown>;
  refreshCycles: (force?: boolean) => Promise<unknown>;
  getCachedCycleCount: () => number;
  createRegistry?: (dbPath: string) => Registry;
  createRepositories?: (registry: Registry) => Repositories;
  createPriceOracle?: (stateCache: RuntimeStateCache, registry: Registry) => PriceOracleLikeGeneric;
  createNonceManager?: () => NonceManagerLikeGeneric;
};

export function createRunnerStartupCoordinator<
  Registry = RegistryService,
  Repositories = RegistryRepositories,
  PriceOracleLikeGeneric = PriceOracle,
  NonceManagerLikeGeneric = NonceManager,
>(deps: RunnerStartupDeps<Registry, Repositories, PriceOracleLikeGeneric, NonceManagerLikeGeneric>) {
  const dbPath = deps.dbPath ?? DB_PATH;
  return createStartupCoordinator({
    log: deps.log,
    createRegistry: () => (
      deps.createRegistry?.(dbPath) ??
      new RegistryService(dbPath) as Registry
    ),
    createRepositories: (registry) => (
      deps.createRepositories?.(registry) ??
      createRegistryRepositories(registry as RegistryService) as Repositories
    ),
    createPriceOracle: (registry) => (
      deps.createPriceOracle?.(deps.stateCache, registry) ??
      createDefaultPriceOracle(deps.stateCache, registry) as PriceOracleLikeGeneric
    ),
    createNonceManager: () => (
      deps.createNonceManager?.() ??
      new NonceManager() as NonceManagerLikeGeneric
    ),
    setPriceOracle: deps.setPriceOracle,
    setNonceManager: deps.setNonceManager,
    runInitialDiscovery: deps.runInitialDiscovery,
    seedStateCache: deps.seedStateCache,
    warmupStateCache: deps.warmupStateCache,
    refreshCycles: deps.refreshCycles,
    getCachedCycleCount: deps.getCachedCycleCount,
  });
}
