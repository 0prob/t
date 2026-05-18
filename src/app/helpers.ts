import type { ArbPathLike, AssessmentLike, CandidateEntry, RouteResultLike } from "../arb/assessment.ts";
import { minProfitInTokenUnits } from "../arb/assessment.ts";
import { getPathFreshness } from "../routing/path_freshness.ts";
import { roiMicroUnits } from "../arb/profit_compute.ts";
import type { RawRouteResult } from "../arb/search.ts";
import type { BotState } from "../tui/types.ts";
import { appendOperatorLog, type OperatorLogMetaInput } from "./operator_log.ts";
import { configureWatcherCallbacks } from "./lifecycle.ts";
import type { PoolsChangedEvent, ReorgDetectedEvent, WatcherHaltEvent } from "./runner.ts";
import { parseRunnerArgs } from "../config/cli.ts";
import { DEFAULT_POLL_INTERVAL_SEC } from "../config/index.ts";
import type { Level, Logger as PinoLogger } from "pino";

// Shared local types
type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;
type ConsoleMethod = "log" | "warn" | "error";

// === From arb_activity.ts ===
export type ArbActivityTrackerOptions = {
  windowMs: number;
  burstPoolThreshold: number;
  baseDebounceMs: number;
  fastDebounceMs: number;
  now?: () => number;
};

export function createArbActivityTracker(options: ArbActivityTrackerOptions) {
  const now = options.now ?? Date.now;
  let window: Array<{ ts: number; changedPools: number }> = [];

  function prune(timestamp = now()) {
    window = window.filter((entry) => timestamp - entry.ts <= options.windowMs);
  }

  function record(changedPools: number) {
    if (!Number.isFinite(changedPools) || changedPools <= 0) return;
    const timestamp = now();
    prune(timestamp);
    window.push({ ts: timestamp, changedPools });
  }

  function getAdaptiveDebounceMs() {
    const timestamp = now();
    prune(timestamp);
    const changedPools = window.reduce((total, entry) => total + entry.changedPools, 0);
    return changedPools > options.burstPoolThreshold ? options.fastDebounceMs : options.baseDebounceMs;
  }

  return {
    record,
    getAdaptiveDebounceMs,
  };
}

// === From heartbeat.ts ===
export type HeartbeatControllerOptions = {
  intervalMs: number;
  onHeartbeat: () => void;
};

export function createHeartbeatController(options: HeartbeatControllerOptions) {
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function start() {
    heartbeat = setInterval(options.onHeartbeat, options.intervalMs);
  }

  function stop() {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function isRunning() {
    return heartbeat != null;
  }

  return {
    start,
    stop,
    isRunning,
  };
}

// === From bot_state.ts ===
export type RuntimeModeOptions = {
  discoveryOnly: boolean;
  loopMode: boolean;
  liveMode: boolean;
};

export function runtimeModeLabel(options: RuntimeModeOptions) {
  if (options.discoveryOnly) return "discovery";
  if (options.loopMode && options.liveMode) return "loop-live";
  if (options.loopMode) return "loop-dry";
  if (options.liveMode) return "single-live";
  return "single-dry";
}

export function createInitialBotState(options: RuntimeModeOptions): BotState {
  return {
    status: "idle",
    mode: runtimeModeLabel(options),
    passCount: 0,
    consecutiveErrors: 0,
    gasPrice: "0",
    lastArbMs: 0,
    stateCacheSize: 0,
    cachedPathCount: 0,
    lastPassDurationMs: 0,
    lastOpportunityCount: 0,
    lastPathsEvaluated: 0,
    lastCandidateCount: 0,
    lastShortlistCount: 0,
    lastOptimizedCount: 0,
    lastProfitableCount: 0,
    lastUpdateMs: 0,
    currentActivity: "Idle",
    currentActivityDetail: "Waiting for runtime activity",
    currentActivityUpdatedMs: 0,
    currentActivityProgress: null,
    opportunities: [],
    logs: [],
    totalTxAttempted: 0,
    totalTxSuccessful: 0,
    totalTxReverted: 0,
    totalProfitWei: 0n,
  };
}

// === From operator_surface.ts ===
type StartupBannerOptions = {
  workerCount: number;
  maxTotalPaths: number;
  writeLine?: (line: string) => void;
};

export function printStartupBanner({ workerCount, maxTotalPaths, writeLine = console.log }: StartupBannerOptions) {
  writeLine("╔══════════════════════════════════════════════╗");
  writeLine("║   Polygon Arbitrage Bot — Event-Driven       ║");
  writeLine(`║   Workers: ${String(workerCount).padEnd(3)}  Paths: ${String(maxTotalPaths).padEnd(7)}          ║`);
  writeLine("╚══════════════════════════════════════════════╝");
}

// === From route_display.ts ===
export type RouteDisplayPath = {
  startToken: string;
  edges: Array<{
    tokenOut: string;
    protocol: string;
  }>;
};

export function formatRoutePath(path: RouteDisplayPath, formatToken: (tokenAddress: string) => string) {
  const tokens = [path.startToken, ...path.edges.map((edge) => edge.tokenOut)];
  const protocols = path.edges.map((edge) => edge.protocol);
  return `${tokens.map((token) => formatToken(token)).join("→")}  [${protocols.join("/")}]`;
}

// === From console_output.ts ===
const CONSOLE_LEVELS: Record<ConsoleMethod, LogLevel> = {
  log: "info",
  warn: "warn",
  error: "error",
};

function formatConsoleArg(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function routeConsoleOutputToLog<T>(run: () => Promise<T>, log: LoggerFn, eventPrefix = "routed_console"): Promise<T> {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  const route = (method: ConsoleMethod, args: unknown[]) => {
    const message = args.map(formatConsoleArg).join(" ").trimEnd();
    if (!message) return;
    log(message, CONSOLE_LEVELS[method], {
      event: `${eventPrefix}_${method}`,
      source: "console",
    });
  };

  console.log = (...args: unknown[]) => route("log", args);
  console.warn = (...args: unknown[]) => route("warn", args);
  console.error = (...args: unknown[]) => route("error", args);

  try {
    return await run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

// === From pool_state_fetchers.ts ===
type PoolLike = {
  tokens?: unknown;
};

type TokenDecimals = Map<string, number> | null;

type DecimalAwareFetcher<Result> = (pool: PoolLike, options: { tokenDecimals?: TokenDecimals }) => Promise<Result>;

type DecimalAwarePoolStateFetchersDeps<CurveResult, DodoResult, WoofiResult> = {
  getPoolTokens: (pool: PoolLike) => string[];
  getTokenDecimals: (tokens: string[]) => TokenDecimals;
  fetchAndNormalizeCurvePool: DecimalAwareFetcher<CurveResult>;
  fetchAndNormalizeDodoPool: DecimalAwareFetcher<DodoResult>;
  fetchAndNormalizeWoofiPool: DecimalAwareFetcher<WoofiResult>;
};

export function createDecimalAwarePoolStateFetchers<CurveResult, DodoResult, WoofiResult>({
  getPoolTokens,
  getTokenDecimals,
  fetchAndNormalizeCurvePool,
  fetchAndNormalizeDodoPool,
  fetchAndNormalizeWoofiPool,
}: DecimalAwarePoolStateFetchersDeps<CurveResult, DodoResult, WoofiResult>) {
  function tokenDecimalsForPool(pool: PoolLike) {
    return getTokenDecimals(getPoolTokens(pool));
  }

  return {
    fetchAndNormalizeCurvePool: (pool: PoolLike) => fetchAndNormalizeCurvePool(pool, { tokenDecimals: tokenDecimalsForPool(pool) }),
    fetchAndNormalizeDodoPool: (pool: PoolLike) => fetchAndNormalizeDodoPool(pool, { tokenDecimals: tokenDecimalsForPool(pool) }),
    fetchAndNormalizeWoofiPool: (pool: PoolLike) => fetchAndNormalizeWoofiPool(pool, { tokenDecimals: tokenDecimalsForPool(pool) }),
  };
}

// === From registry_access.ts ===
type PoolRecord = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
  [key: string]: unknown;
};

type RegistryReadRepositories = {
  pools: {
    getActiveMeta: () => PoolRecord[];
    getMeta: (address: string) => PoolRecord | undefined;
  };
  tokens: {
    getDecimals: (addresses: string[]) => Map<string, number>;
  };
};

type RegistryReadAccessDeps = {
  getRepositories: () => RegistryReadRepositories | null | undefined;
};

export function createRegistryReadAccess({ getRepositories }: RegistryReadAccessDeps) {
  return {
    getActivePoolMeta() {
      return getRepositories()?.pools.getActiveMeta() ?? [];
    },
    getPoolMeta(address: string) {
      return getRepositories()?.pools.getMeta(address);
    },
    getTokenDecimals(addresses: string[]) {
      return getRepositories()?.tokens.getDecimals(addresses) ?? null;
    },
  };
}

// === From route_freshness.ts ===
type StateCacheLike = Map<string, { timestamp?: number } | undefined>;

type RouteFreshnessReaderDeps = {
  stateCache: StateCacheLike;
  maxAgeMs: number;
  maxSkewMs: number;
  nowMs?: () => number;
};

export function createRouteFreshnessReader({ stateCache, maxAgeMs, maxSkewMs, nowMs }: RouteFreshnessReaderDeps) {
  return function getRouteFreshness(path: ArbPathLike) {
    return getPathFreshness(path, stateCache, {
      maxAgeMs,
      maxSkewMs,
      nowMs: nowMs?.(),
    });
  };
}

// === From execution_events.ts ===
export type ExecutionQuarantine = {
  failures: number;
  until: number;
};

type PreparedCandidateErrorLoggerDeps = {
  log: LoggerFn;
  fmtPath: (path: CandidateEntry["path"]) => string;
  now?: () => number;
};

export function createPreparedCandidateErrorLogger({ log, fmtPath, now = Date.now }: PreparedCandidateErrorLoggerDeps) {
  return function onPreparedCandidateError(candidate: CandidateEntry, reason: string, quarantine: ExecutionQuarantine) {
    log(`[runner] Quarantining route after execution preparation failure: ${reason}`, "warn", {
      event: "execute_quarantine_add",
      route: fmtPath(candidate.path),
      hopCount: candidate.path.hopCount,
      failures: quarantine.failures,
      quarantineMs: Math.max(0, quarantine.until - now()),
      reason,
    });
  };
}

// === From gas_status.ts ===
export type FeeSnapshotLike = {
  effectiveGasPriceWei?: bigint | null;
  maxFee?: bigint | null;
  updatedAt?: number | null;
};

type CurrentFeeSnapshotReaderDeps<T extends FeeSnapshotLike> = {
  fetchFees: () => Promise<T | null | undefined>;
  maxAgeMs: number;
  setGasPrice: (gasPriceGwei: string) => void;
  now?: () => number;
};

export function createCurrentFeeSnapshotReader<T extends FeeSnapshotLike>({
  fetchFees,
  maxAgeMs,
  setGasPrice,
  now = Date.now,
}: CurrentFeeSnapshotReaderDeps<T>) {
  return async function getCurrentFeeSnapshot() {
    try {
      const fees = await fetchFees();
      const displayGasPrice = fees?.effectiveGasPriceWei ?? fees?.maxFee;
      if (displayGasPrice) {
        setGasPrice((Number(displayGasPrice) / 1e9).toFixed(2));
      }
      if (!fees?.updatedAt) {
        return null;
      }
      const ageMs = now() - fees.updatedAt;
      if (ageMs > maxAgeMs || ageMs < -maxAgeMs) {
        return null;
      }
      return fees;
    } catch {
      return null;
    }
  };
}

// === From pass_policy.ts ===
export function roiForCandidate(candidate: CandidateEntry | null | undefined) {
  const assessedRoi = candidate?.assessment?.roi;
  if (typeof assessedRoi === "number" && Number.isFinite(assessedRoi)) {
    return assessedRoi;
  }

  const result = candidate?.result;
  if (!result?.amountIn || result.amountIn <= 0n) return -Infinity;
  return roiMicroUnits(result.profit, result.amountIn);
}

export function deriveOnChainMinProfit(assessment: AssessmentLike | null | undefined, tokenToMaticRate: bigint, minProfitWei: bigint) {
  const minProfitTokens = minProfitInTokenUnits(tokenToMaticRate, minProfitWei);
  const modeledNet = assessment && assessment.netProfitAfterGas > 0n ? assessment.netProfitAfterGas : (assessment?.netProfit ?? 0n);
  const buffered = modeledNet > 0n ? (modeledNet * 50n) / 100n : 0n;
  return buffered > minProfitTokens ? buffered : minProfitTokens;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// === From opportunity_route_cache.ts ===
type RouteCacheLike = {
  update: (candidates: CandidateEntry[]) => unknown;
  getByPools: (changedPools: Set<string>) => Array<{ path: unknown; result: RawRouteResult }>;
  removeByRoute: (path: ArbPathLike) => number;
};

type OpportunityEngineLike = {
  toRouteResultLike: (result: RawRouteResult) => RouteResultLike;
};

type OpportunityRouteCacheAdaptersDeps = {
  routeCache: RouteCacheLike;
  getOpportunityEngine: () => OpportunityEngineLike | null | undefined;
};

export function createOpportunityRouteCacheAdapters({ routeCache, getOpportunityEngine }: OpportunityRouteCacheAdaptersDeps) {
  return {
    updateCandidates(candidates: CandidateEntry[]) {
      return routeCache.update(candidates);
    },
    removeCandidate(path: ArbPathLike) {
      return routeCache.removeByRoute(path);
    },
    getAffectedRoutes(changedPools: Set<string>) {
      const opportunityEngine = getOpportunityEngine();
      if (!opportunityEngine) {
        throw new Error("opportunity engine is not initialized");
      }

      return routeCache.getByPools(changedPools).map(({ path, result }) => ({
        path: path as ArbPathLike,
        result: opportunityEngine.toRouteResultLike(result),
      }));
    },
  };
}

// === From watcher_configurator.ts ===
type WatcherLike = Parameters<typeof configureWatcherCallbacks>[0]["watcher"];

type WatcherConfiguratorDeps = {
  log: LoggerFn;
  handlePoolsChanged: (changedPools: PoolsChangedEvent["changedPools"]) => Promise<void> | void;
  handleReorgDetected: (
    reorgBlock: ReorgDetectedEvent["reorgBlock"],
    changedPools: ReorgDetectedEvent["changedPools"],
  ) => Promise<void> | void;
  handleHaltDetected: (payload: WatcherHaltEvent["payload"]) => Promise<void> | void;
  scheduleArb: (changedPools?: number) => void;
};

export function createWatcherConfigurator({
  log,
  handlePoolsChanged,
  handleReorgDetected,
  handleHaltDetected,
  scheduleArb,
}: WatcherConfiguratorDeps) {
  return function configureWatcher(watcher: WatcherLike) {
    configureWatcherCallbacks({
      watcher,
      log,
      onPoolsChanged: async ({ changedPools }) => {
        await handlePoolsChanged(changedPools);
      },
      onReorgDetected: ({ reorgBlock, changedPools }) => {
        handleReorgDetected(reorgBlock, changedPools);
      },
      onHaltDetected: ({ payload }) => {
        handleHaltDetected(payload);
      },
      scheduleArb,
    });
  };
}

// === From runner_log.ts ===
const MAX_OPERATOR_LOGS = 200;

export function createOperatorLogger(
  state: Pick<BotState, "logs"> &
    Partial<Pick<BotState, "currentActivity" | "currentActivityDetail" | "currentActivityUpdatedMs" | "currentActivityProgress">>,
  logger: Pick<PinoLogger, Level | "isLevelEnabled">,
) {
  return function log(msg: string, level: Level = "info", meta: OperatorLogMetaInput = undefined) {
    if (!logger.isLevelEnabled(level)) return;

    const payload = appendOperatorLog(state, msg, level, meta, MAX_OPERATOR_LOGS);

    if (payload && Object.keys(payload).length > 0) {
      (logger[level] as (obj: object, msg: string) => void)(payload, msg);
      return;
    }
    (logger[level] as (msg: string) => void)(msg);
  };
}

// === From runner_options.ts ===
export type RunnerEnv = Record<string, string | undefined>;

function parseNonNegativeBps(raw: string | undefined, name: string) {
  if (raw == null || raw.trim() === "") return 0n;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a non-negative integer basis-point value`);
  const value = BigInt(raw.trim());
  if (value > 10_000n) throw new Error(`${name} must be <= 10000`);
  return value;
}

export function resolveRunnerOptions(args: string[], env: RunnerEnv, defaultPollIntervalSec = DEFAULT_POLL_INTERVAL_SEC) {
  const parsedArgs = parseRunnerArgs(args, defaultPollIntervalSec);
  const pollIntervalSec = parsedArgs.pollIntervalSec;

  return {
    loopMode: parsedArgs.loopMode,
    liveMode: parsedArgs.liveMode,
    discoveryOnly: parsedArgs.discoveryOnly,
    tuiMode: parsedArgs.tuiMode,
    maxPasses: parsedArgs.maxPasses,
    pollIntervalSec,
    privateKey: env.PRIVATE_KEY || null,
    executorAddress: env.EXECUTOR_ADDRESS || null,
    minProfitWei: env.MIN_PROFIT_WEI != null && env.MIN_PROFIT_WEI !== "" ? BigInt(env.MIN_PROFIT_WEI) : BigInt("1000000000000000"),
    flashLoanFeeBps: parseNonNegativeBps(env.BALANCER_FLASH_LOAN_FEE_BPS, "BALANCER_FLASH_LOAN_FEE_BPS"),
    testAmountWei: 10n ** 18n,
    maxExecutionBatch: 3,
    executionRouteQuarantineMs: 120_000,
    heartbeatIntervalMs: Math.max(pollIntervalSec * 1000, 30_000),
  };
}
