import type { CandidateEntry } from "../arb/assessment.ts";
import { DB_PATH, ENABLE_PREDICTIVE_CACHE, getResourceTunedRunParameters, RESOURCE_TUNED_RUN_PARAMETERS } from "../config/index.ts";
import { type RegistryRepositories } from "../db/repositories.ts";
import { type RegistryService } from "../db/registry.ts";
import { StateWatcher } from "../state/watcher.ts";
import { createOpportunityRouteCacheAdapters, resolveRunnerOptions, type RunnerEnv } from "./helpers.ts";
import { createRunnerBootSurface } from "./runner.ts";
import { createRunnerDeferredActions } from "./runner.ts";
import { createRunnerMainController } from "./runner.ts";
import { createRunnerMarketDataAdapters } from "./runner.ts";
import { createRunnerPassCoordinator } from "./runner.ts";
import { createRunnerProcessControl } from "./runner.ts";
import { createRunnerRuntime } from "./runner.ts";
import { createRunnerStartupCoordinator } from "./runner.ts";
import { createRunnerTopologyAdapters } from "./runner.ts";
import { createRunnerWatcherAdapters } from "./runner.ts";
import { createRunnerHydrationAdapters } from "./runner_hydration.ts";
import { createRunnerOpportunityEngine, createRunnerOpportunityEngineWithPredictiveCache } from "./runner_opportunity_engine.ts";
import { createPendingTxStateWatcher } from "../app/mempool_watcher.ts";
import { TxAttemptStore } from "../execution/tx_attempt_store.ts";
import { setAttemptLogSink } from "../execution/attempt_log.ts";
import { logger } from "../utils/logger.ts";

type ProcessSignalRegistrar = {
  on: (signal: string, listener: (...args: unknown[]) => void) => unknown;
};

type WatcherCallbackTargetLike = {
  onBatch: ((payload: unknown) => void) | null;
  onReorg: ((payload: unknown) => void) | null;
  onHalt: ((payload: Record<string, unknown>) => void) | null;
};

function isWatcherCallbackTarget(value: unknown): value is WatcherCallbackTargetLike {
  if (value == null || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    "onBatch" in target &&
    (target.onBatch == null || typeof target.onBatch === "function") &&
    "onReorg" in target &&
    (target.onReorg == null || typeof target.onReorg === "function") &&
    "onHalt" in target &&
    (target.onHalt == null || typeof target.onHalt === "function")
  );
}

type RunnerAppDeps = {
  argv: string[];
  env: RunnerEnv;
  processLike: ProcessSignalRegistrar;
  exit: (code: number) => never;
};

export function createRunnerApp({ argv, env, processLike, exit }: RunnerAppDeps) {
  const options = resolveRunnerOptions(argv, env);
  const resourcePlan = RESOURCE_TUNED_RUN_PARAMETERS;
  const maxExecutionBatch = Math.min(options.maxExecutionBatch, resourcePlan.maxExecutionBatch);

  let registry: RegistryService | null = null;
  let repositories: RegistryRepositories | null = null;
  let txAttemptStore: TxAttemptStore | null = null;
  let opportunityEngine: ReturnType<typeof createRunnerOpportunityEngine> | null = null;
  let predictiveCacheApi: {
    notifyPoolStateChanged: (pools: Set<string>) => void;
    prefetchIdleBatch: (batchSize?: number) => Promise<number>;
    shutdown: () => Promise<void>;
  } | null = null;
  let passCoordinator: ReturnType<typeof createRunnerPassCoordinator> | null = null;
  let processControl: ReturnType<typeof createRunnerProcessControl> | null = null;
  let bootSurface: ReturnType<typeof createRunnerBootSurface> | null = null;

  const runnerRuntime = createRunnerRuntime({
    discoveryOnly: options.discoveryOnly,
    loopMode: options.loopMode,
    liveMode: options.liveMode,
  });
  const { runtime, stateCache, routeCache, botState, botTelemetry, log, getCurrentFeeSnapshot, arbActivityTracker } = runnerRuntime;

  const marketDataAdapters = createRunnerMarketDataAdapters({
    getRepositories: () => repositories,
    getPriceOracle: () => runtime.getPriceOracle(),
    stateCache,
    testAmountWei: options.testAmountWei,
  });
  const { registryReadAccess, pricingService, getRouteFreshness, decimalAwarePoolStateFetchers, fmtPath } = marketDataAdapters;
  const opportunityRouteCache = createOpportunityRouteCacheAdapters({
    routeCache,
    getOpportunityEngine: () => opportunityEngine,
  });

  const onPreparedCandidateError = (
    candidate: Pick<CandidateEntry, "path">,
    reason: string,
    quarantine: { failures: number; until: number },
  ) => {
    const { path } = candidate;
    const removed = routeCache.removeByRoute(path);
    if (removed > 0) {
      log("[runner] Evicted execution-failed route from opportunity cache", "debug", {
        event: "route_cache_evict_execution_failed",
        route: fmtPath(path),
        removed,
        reason,
        failures: quarantine.failures,
        quarantineMs: Math.max(0, quarantine.until - Date.now()),
      });
    }
  };

  const topologyAdapters = createRunnerTopologyAdapters({
    routeCache,
    stateCache,
    registryReadAccess,
    log,
    getPriceOracle: () => runtime.getPriceOracle(),
    clearExecutionRouteQuarantine: (reason: string) => opportunityEngine?.clearExecutionRouteQuarantine(reason),
  });
  const topologyRefreshCoordinator = topologyAdapters.topologyRefreshCoordinator;
  const deferredActions = createRunnerDeferredActions({
    getTopologyAdapters: () => topologyAdapters,
    getPassCoordinator: () => passCoordinator,
  });

  const hydrationAdapters = createRunnerHydrationAdapters({
    discoveryOutputMode: options.tuiMode ? "log" : "console",
    getRegistry: () => registry,
    getRepositories: () => repositories,
    getWatcher: () => runtime.getWatcher(),
    isRunning: () => runtime.isRunning(),
    stateCache,
    log,
    fetchAndNormalizeCurvePool: decimalAwarePoolStateFetchers.fetchAndNormalizeCurvePool,
    fetchAndNormalizeDodoPool: decimalAwarePoolStateFetchers.fetchAndNormalizeDodoPool,
    fetchAndNormalizeWoofiPool: decimalAwarePoolStateFetchers.fetchAndNormalizeWoofiPool,
    getActivePoolMeta: registryReadAccess.getActivePoolMeta,
    admitPools: topologyAdapters.admitPools,
    invalidateTopology: topologyAdapters.invalidate,
    refreshCycles: deferredActions.refreshCycles,
    v2PollConcurrency: resourcePlan.v2PollConcurrency,
    v3PollConcurrency: resourcePlan.v3PollConcurrency,
    enrichConcurrency: resourcePlan.enrichConcurrency,
    quietPoolSweepBatchSize: resourcePlan.quietPoolSweepBatchSize,
    quietPoolSweepCatchupBatchSize: resourcePlan.quietPoolSweepCatchupBatchSize,
  });
  const seedStateCache = hydrationAdapters.seedStateCache;
  const warmupStateCache = hydrationAdapters.warmupStateCache;
  const maybeRunDiscovery = hydrationAdapters.maybeRunDiscovery;
  const maybeHydrateQuietPools = hydrationAdapters.maybeHydrateQuietPools;

  const resourcePassDecision = () => {
    const currentPlan = getResourceTunedRunParameters();
    if (currentPlan.allowIntensiveWork) {
      return { ok: true, thermalState: currentPlan.thermalState };
    }
    const reason = currentPlan.reasons.length > 0 ? currentPlan.reasons[0] : "thermal_critical";
    return { ok: false, reason, thermalState: currentPlan.thermalState };
  };
  async function guardedRunPass() {
    const decision = resourcePassDecision();
    if (!decision.ok) {
      log("[runner] Skipping arb pass due to resource guard", "warn", {
        event: "resource_guard_skip",
        reason: decision.reason,
        thermalState: decision.thermalState,
      });
      return;
    }
    await deferredActions.runPass();
    // After pass completes, use idle time to pre-compute stale shadow state entries
    predictiveCacheApi?.prefetchIdleBatch(5).catch(() => {});
  }

  processControl = createRunnerProcessControl({
    isRunning: () => runtime.isRunning(),
    setRunning: (running) => runtime.setRunning(running),
    getWatcher: () => runtime.getWatcher(),
    recordArbActivity: arbActivityTracker.record,
    getAdaptiveDebounceMs: arbActivityTracker.getAdaptiveDebounceMs,
    runPass: deferredActions.runPass,
    shouldRunPass: resourcePassDecision,
    log,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    stopTui: () => bootSurface?.stopTui(),
    getRegistry: () => registry,
    exit,
  });
  const scheduleArb = processControl.scheduleArb;
  const cancelScheduledArb = processControl.cancelScheduledArb;
  const trackBackgroundTask = processControl.trackBackgroundTask;
  const shutdown = processControl.shutdown;

  const watcherAdapters = createRunnerWatcherAdapters({
    stateCache,
    log,
    removePoolsFromTopology: topologyAdapters.removePools,
    removeRoutesByPools: (poolAddresses: Set<string>) => routeCache.removeByPools(poolAddresses),
    admitPools: topologyAdapters.admitPools,
    updatePriceOracle: (changedPools?: Iterable<string>) => runtime.getPriceOracle()?.update(changedPools),
    revalidateCachedRoutes: async (changedPools: Set<string>) => {
      predictiveCacheApi?.notifyPoolStateChanged(changedPools);
      await opportunityEngine?.revalidateCachedRoutes(changedPools);
    },
    clearRouteCache: () => routeCache.clear(),
    clearTopologyCycles: topologyAdapters.clearCycles,
    resetTopology: topologyAdapters.resetGraphs,
    setRunning: (running: boolean) => runtime.setRunning(running),
    setBotStatus: (status) => {
      botState.status = status;
    },
    cancelScheduledArb,
    stopHeartbeat: processControl.stopHeartbeat,
    scheduleArb,
  });
  const configureWatcher = watcherAdapters.configureWatcher;
  const pendingTxWatcher = createPendingTxStateWatcher({
    isRunning: () => runtime.isRunning(),
    stateCache,
    getPoolRecord: (poolAddress: string) => repositories?.pools.getMeta(poolAddress) ?? repositories?.pools.get(poolAddress) ?? null,
    fetchAndCacheStates: (pools, options) => hydrationAdapters.fetchAndCacheStates(pools, options),
    handlePoolsChanged: (changedPools) => watcherAdapters.watcherBatchCoordinator.handlePoolsChanged(changedPools),
    scheduleArb,
    log,
  });
  const startupCoordinator = createRunnerStartupCoordinator({
    stateCache,
    log,
    setPriceOracle: (oracle) => runtime.setPriceOracle(oracle),
    setNonceManager: (nonceManager) => runtime.setNonceManager(nonceManager),
    runInitialDiscovery: () => hydrationAdapters.runInitialDiscovery(),
    seedStateCache,
    warmupStateCache,
    refreshCycles: deferredActions.refreshCycles,
    getCachedCycleCount: topologyAdapters.getCachedCycleCount,
  });

  // Single shared deps object — createRunnerOpportunityEngineWithPredictiveCache
  // mutates getAffectedRoutes on this object before building the engine, ensuring
  // the predictive-cache wrapper is wired into the engine the bot actually uses.
  const opportunityEngineDeps: Parameters<typeof createRunnerOpportunityEngineWithPredictiveCache>[0] = {
    liveMode: options.liveMode,
    privateKey: options.privateKey,
    executorAddress: options.executorAddress,
    getNonceManager: () => runtime.getNonceManager(),
    maxExecutionBatch,
    executionRouteQuarantineMs: options.executionRouteQuarantineMs,
    minProfitWei: options.minProfitWei,
    flashLoanFeeBps: options.flashLoanFeeBps,
    log,
    fmtPath,
    getRouteFreshness,
    getCurrentFeeSnapshot,
    getFreshTokenToMaticRate: pricingService.getFreshTokenToMaticRate,
    onPreparedCandidateError,
    cachedCycles: topologyAdapters.getCachedCycles,
    topologyDirty: topologyAdapters.isTopologyDirty,
    refreshCycles: deferredActions.refreshCycles,
    passCount: () => runtime.getPassCount(),
    stateCache,
    getProbeAmountsForToken: pricingService.getProbeAmountsForToken,
    routeCacheUpdate: opportunityRouteCache.updateCandidates,
    routeCacheRemove: opportunityRouteCache.removeCandidate,
    fmtProfit: pricingService.fmtProfit,
    onPathsEvaluated: botTelemetry.recordPathsEvaluated,
    onCandidateMetrics: botTelemetry.recordCandidateMetrics,
    onArbsFound: botTelemetry.recordArbsFound,
    workerCount: resourcePlan.workerCount,
    maxPathsToOptimize: resourcePlan.maxPathsToOptimize,
    getAffectedRoutes: opportunityRouteCache.getAffectedRoutes,
    testAmountWei: options.testAmountWei,
    getPoolRecord: (poolAddress: string) => repositories?.pools.getMeta(poolAddress) ?? repositories?.pools.get(poolAddress) ?? null,
    fetchAndCacheStates: (pools, fetchOptions) => hydrationAdapters.fetchAndCacheStates(pools, fetchOptions),
    routeCache,
  };
  const predictiveEngine = createRunnerOpportunityEngineWithPredictiveCache(opportunityEngineDeps);
  opportunityEngine = predictiveEngine.engine;
  if (ENABLE_PREDICTIVE_CACHE) {
    predictiveCacheApi = {
      notifyPoolStateChanged: predictiveEngine.notifyPoolStateChanged,
      prefetchIdleBatch: predictiveEngine.prefetchIdleBatch,
      shutdown: predictiveEngine.shutdown,
    };
  }
  passCoordinator = createRunnerPassCoordinator({
    stateCache,
    getCachedCycleCount: topologyAdapters.getCachedCycleCount,
    incrementPassCount: () => runtime.incrementPassCount(),
    getConsecutiveErrors: () => runtime.getConsecutiveErrors(),
    incrementConsecutiveErrors: () => runtime.incrementConsecutiveErrors(),
    resetConsecutiveErrors: () => runtime.resetConsecutiveErrors(),
    botTelemetry,
    log,
    trackBackgroundTask: (task) => {
      trackBackgroundTask(task as Promise<void>);
    },
    maybeRunDiscovery,
    reconcileDiscoveryResult: (result) =>
      hydrationAdapters.reconcileDiscoveryResult(result as { totalDiscovered?: number } | null | undefined),
    refreshCycles: deferredActions.refreshCycles,
    maybeHydrateQuietPools,
    refreshPriceOracleIfStale: () => topologyRefreshCoordinator.refreshPriceOracleIfStale(),
    onPassComplete: (passCount) => {
      if (options.maxPasses != null && passCount >= options.maxPasses) {
        log(`[runner] Reached max passes (${options.maxPasses}) — shutting down`, "info", {
          event: "max_passes_reached",
          maxPasses: options.maxPasses,
          passCount,
        });
        void shutdown(0, "complete");
      }
    },
    searchOpportunities: () =>
      opportunityEngine ? opportunityEngine.search() : (console.warn("searchOpportunities called before engine init"), Promise.resolve([])),
    executeBatchIfIdle: (candidates, reason) =>
      opportunityEngine
        ? opportunityEngine.executeBatchIfIdle(candidates, reason)
        : Promise.resolve({ submitted: false, error: "execution engine not initialized" }),
    maxExecutionBatch,
    formatProfit: (profit, startToken) => pricingService.fmtProfit(profit, startToken),
    recordTxAttempt: (success, profitWei) => botTelemetry.recordTransactionAttempt(success, profitWei ?? 0n),
  });

  bootSurface = createRunnerBootSurface<typeof botState>({
    botState,
    setBotStatus: (status) => {
      botState.status = status;
    },
    getRegistry: () => registry,
    stateCache,
    loopMode: options.loopMode,
    discoveryOnly: options.discoveryOnly,
    runPass: guardedRunPass,
    shutdown,
    setWatcher: (watcher) => {
      if (watcher !== null && !(watcher instanceof StateWatcher)) {
        throw new Error("Runner boot surface returned an incompatible watcher instance");
      }
      runtime.setWatcher(watcher);
    },
    configureWatcher: (watcher) => {
      if (!isWatcherCallbackTarget(watcher)) {
        throw new Error("Runner boot surface returned a watcher without callback hooks");
      }
      configureWatcher(watcher);
    },
    log,
    workerCount: resourcePlan.workerCount,
    maxTotalPaths: resourcePlan.maxTotalPaths,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    startHeartbeat: processControl.startHeartbeat,
    scheduleArb: () => {
      scheduleArb();
    },
    stopHeartbeat: processControl.stopHeartbeat,
    startRealtimeFeeds: pendingTxWatcher.start,
    stopRealtimeFeeds: pendingTxWatcher.stop,
  });
  const bootModeCoordinator = bootSurface.bootModeCoordinator;
  return createRunnerMainController({
    tuiMode: options.tuiMode,
    liveMode: options.liveMode,
    bootModeCoordinator,
    startupCoordinator,
    setRuntime: (initializedRuntime) => {
      registry = initializedRuntime.registry;
      repositories = initializedRuntime.repositories;

      // Initialize transaction attempt logging on first runtime assignment
      if (!txAttemptStore) {
        try {
          txAttemptStore = new TxAttemptStore(DB_PATH);
          setAttemptLogSink(txAttemptStore.write.bind(txAttemptStore));
          logger.child({ component: "runner_app" }).info({ dbPath: DB_PATH }, "Transaction attempt logging enabled");

          // Prune rows older than 7 days, once per week (non-blocking background task)
          setInterval(
            () => {
              try {
                txAttemptStore?.prune(7);
              } catch {
                /* diagnostic infra, ignore */
              }
            },
            7 * 24 * 60 * 60 * 1000,
          ).unref?.();
        } catch (err) {
          logger
            .child({ component: "runner_app" })
            .warn({ err: String(err) }, "Failed to initialize TxAttemptStore — attempt logging disabled");
        }
      }
    },
    processLike,
    shutdown,
    workerCount: resourcePlan.workerCount,
    evalWorkerThreshold: resourcePlan.allowIntensiveWork ? undefined : Number.POSITIVE_INFINITY,
    log,
  });
}
