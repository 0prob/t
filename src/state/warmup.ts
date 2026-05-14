import { takeTopNBy } from "../utils/bounded_priority.ts";
import { WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE } from "../config/index.ts";
import { metadataWithRegistryTokenDecimals } from "../state/pool_metadata.ts";
import { normalizeV2State, normalizeV3State } from "../state/normalizer.ts";
import type { V2FetchOptions, V2StateMap } from "../state/uniswap_v2.ts";
import type { V3FetchOptions, V3PoolMeta, V3PoolState, V3StateMap } from "../state/uniswap_v3.ts";
import {
  BALANCER_PROTOCOLS,
  CURVE_PROTOCOLS,
  DODO_PROTOCOLS,
  normalizeProtocolKey,
  V2_PROTOCOLS,
  V3_PROTOCOLS,
  WOOFI_PROTOCOLS,
} from "../protocols/classification.ts";

export type PoolRecord = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
};

export type WarmupRegistry = {
  getCheckpoint: (key: string) => { last_block?: unknown } | null | undefined;
  getGlobalCheckpoint: () => unknown;
  getPools: (opts?: Record<string, unknown>) => PoolRecord[];
  getActivePoolsMeta: () => PoolRecord[];
  getTokenDecimals?: (addresses: string[]) => Map<string, number>;
  batchUpdateStates: (states: Array<{ pool_address: string; block: number; data: object }>) => unknown;
  disablePool: (address: string, reason: string) => unknown;
};

type WarmupStats = {
  scheduled: number;
  fetched: number;
  normalized: number;
  observedUnroutable: number;
  disabled: number;
  failed: number;
  protocols: Record<
    string,
    {
      scheduled: number;
      fetched: number;
      normalized: number;
      observedUnroutable: number;
      disabled: number;
      failed: number;
    }
  >;
};

type WarmupGroupStats = WarmupStats["protocols"][string];
type WarmupGroupResult = {
  addr: string;
  raw?: unknown;
  normalized?: Record<string, unknown> | null;
  noDataFailures?: Set<string>;
  persisted?: boolean;
};
type FetchAndCacheOptions = {
  v3HydrationMode?: "full" | "nearby" | "none" | "tiered";
  v3NearWordRadius?: number;
  blockTag?: "latest" | "pending";
  logContext?: FetchLogContext;
};
type FetchLogContext = {
  label: string;
  eventPrefix: string;
};
type WarmupGroup = {
  key: keyof WarmupStats["protocols"];
  protocols: Set<string>;
  progressPhase?: string;
  fetch: (group: PoolRecord[], stats: WarmupStats) => Promise<WarmupGroupResult[]>;
};

type WarmupDeps = {
  getRegistry: () => WarmupRegistry | null | undefined;
  stateCache: Map<string, Record<string, unknown>>;
  log: (msg: string, level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace", meta?: unknown) => void;
  getPoolTokens: (pool: PoolRecord) => string[];
  getPoolMetadata: (pool: PoolRecord) => Record<string, unknown>;
  validatePoolState: (state: unknown) => { valid: boolean; reason?: string };
  normalizePoolState: (
    addr: string,
    protocol: string,
    tokens: string[],
    raw: unknown,
    metadata?: unknown,
  ) => Record<string, unknown> | null;
  fetchMultipleV2States: (addresses: string[], concurrency: number, options?: V2FetchOptions) => Promise<V2StateMap>;
  fetchMultipleV3States: (
    addresses: string[],
    concurrency: number,
    poolMeta: Map<string, V3PoolMeta>,
    onProgress: (completed: number, total: number, addr: string, rawState: V3PoolState | null) => void,
    fetchOptions?: V3FetchOptions,
  ) => Promise<V3StateMap>;
  fetchAndNormalizeBalancerPool: (
    pool: PoolRecord,
    options?: { tokenDecimals?: Map<string, number> | null },
  ) => Promise<{ addr: string; normalized: Record<string, unknown> }>;
  fetchAndNormalizeCurvePool: (
    pool: PoolRecord,
    options?: { tokenDecimals?: Map<string, number> | null },
  ) => Promise<{ addr: string; normalized: Record<string, unknown> }>;
  fetchAndNormalizeDodoPool: (
    pool: PoolRecord,
    options?: { tokenDecimals?: Map<string, number> | null },
  ) => Promise<{ addr: string; normalized: Record<string, unknown> }>;
  fetchAndNormalizeWoofiPool: (
    pool: PoolRecord,
    options?: { tokenDecimals?: Map<string, number> | null },
  ) => Promise<{ addr: string; normalized: Record<string, unknown> }>;
  throttledMap: <T, R>(items: T[], mapper: (item: T) => Promise<R>, concurrency: number) => Promise<R[]>;
  polygonHubTokens: Set<string>;
  hub4Tokens: Set<string>;
  maxSyncWarmupPools: number;
  maxSyncWarmupV3Pools: number;
  maxSyncWarmupOneHubPools: number;
  maxSyncWarmupOneHubV3Pools: number;
  v2PollConcurrency: number;
  v3PollConcurrency: number;
  enrichConcurrency: number;
};

const WARMUP_V2 = V2_PROTOCOLS;
const WARMUP_V3 = V3_PROTOCOLS();
const WARMUP_BAL = BALANCER_PROTOCOLS;
const WARMUP_CRV = CURVE_PROTOCOLS;
const WARMUP_DODO = DODO_PROTOCOLS;
const WARMUP_WOOFI = WOOFI_PROTOCOLS;
const SUPPORTED_WARMUP_PROTOCOLS = new Set([...WARMUP_V2, ...WARMUP_V3, ...WARMUP_BAL, ...WARMUP_CRV, ...WARMUP_DODO, ...WARMUP_WOOFI]);
const WARMUP_PROGRESS_LOG_EVERY = 25;
const EFFECTIVE_WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE = Math.max(1, Math.floor(WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE));
const EMPTY_PROTOCOL_STATS = { scheduled: 0, fetched: 0, normalized: 0, observedUnroutable: 0, disabled: 0, failed: 0 };
const WARMUP_POOL_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isSupportedWarmupProtocol(protocol: string | null | undefined) {
  return SUPPORTED_WARMUP_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

function hasWarmupTimestamp(state: unknown) {
  if (!state || typeof state !== "object") return false;
  const timestamp = Number((state as { timestamp?: unknown }).timestamp);
  return Number.isFinite(timestamp) && timestamp > 0;
}

function isBigIntConvertiblePrimitive(value: unknown): value is string | number | bigint | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean";
}

function hasBigIntLikeValue(value: unknown) {
  if (!isBigIntConvertiblePrimitive(value)) return false;
  try {
    BigInt(value);
    return true;
  } catch {
    return false;
  }
}

function hasObservedReservePair(state: Record<string, unknown>, left: string, right: string) {
  return hasBigIntLikeValue(state?.[left]) && hasBigIntLikeValue(state?.[right]);
}

function hasObservedBalances(state: Record<string, unknown>) {
  return Array.isArray(state?.balances) && Array.isArray(state?.tokens) && state.balances.length === state.tokens.length;
}

export function isObservedUnroutableWarmupState(state: unknown, verdict: { valid: boolean; reason?: string }) {
  if (!hasWarmupTimestamp(state)) return false;
  if (verdict.valid) return false;

  const stateObject = state as Record<string, unknown>;
  switch (verdict.reason) {
    case "V2: zero reserves":
      return hasObservedReservePair(stateObject, "reserve0", "reserve1");
    case "V3: not initialized":
      return stateObject.initialized === false && hasBigIntLikeValue(stateObject.sqrtPriceX96);
    case "V3: zero liquidity":
      return hasBigIntLikeValue(stateObject.sqrtPriceX96) && hasBigIntLikeValue(stateObject.liquidity);
    case "Curve: zero balance":
    case "Balancer: zero balance":
      return hasObservedBalances(stateObject);
    case "DODO: zero reserves":
      return hasObservedReservePair(stateObject, "baseReserve", "quoteReserve");
    case "DODO: zero targets":
      return hasObservedReservePair(stateObject, "baseTarget", "quoteTarget");
    case "WOOFi: zero balance":
      return hasObservedBalances(stateObject);
    default:
      return false;
  }
}

export function createWarmupManager(deps: WarmupDeps) {
  function resolveFetchLogContext(options: FetchAndCacheOptions): FetchLogContext {
    return (
      options.logContext ?? {
        label: "State warmup",
        eventPrefix: "warmup",
      }
    );
  }

  function eventName(logContext: FetchLogContext, suffix: string) {
    return `${logContext.eventPrefix}_${suffix}`;
  }

  function effectiveSyncWarmupV3FullBudget() {
    const cappedByTotalWarmup = Math.min(
      deps.maxSyncWarmupV3Pools,
      deps.maxSyncWarmupPools + deps.maxSyncWarmupOneHubPools + deps.maxSyncWarmupOneHubV3Pools,
    );
    return Math.max(0, cappedByTotalWarmup);
  }

  function isAlgebraPool(pool: PoolRecord) {
    const metadata = deps.getPoolMetadata(pool);
    return (
      pool?.protocol === "QUICKSWAP_V3" ||
      pool?.protocol === "KYBERSWAP_ELASTIC" ||
      metadata?.isAlgebra === true ||
      metadata?.isKyberElastic === true
    );
  }

  function getPoolMetadataWithDecimals(pool: PoolRecord, tokens: string[]) {
    return metadataWithRegistryTokenDecimals(deps.getRegistry(), pool, tokens);
  }

  function supportsWarmupProtocol(pool: PoolRecord | null | undefined) {
    return isSupportedWarmupProtocol(pool?.protocol);
  }

  function warmupProgressSnapshot(stats: WarmupStats) {
    const protocolStats = stats.protocols || {};
    return {
      scheduled: stats.scheduled,
      fetched: stats.fetched,
      normalized: stats.normalized,
      observedUnroutable: stats.observedUnroutable,
      disabled: stats.disabled,
      failed: stats.failed,
      remaining: Math.max(0, stats.scheduled - (stats.normalized + stats.disabled + stats.failed)),
      protocols: Object.fromEntries(
        Object.entries(protocolStats).map(([name, protocol]) => [
          name,
          {
            scheduled: protocol.scheduled,
            fetched: protocol.fetched,
            normalized: protocol.normalized,
            observedUnroutable: protocol.observedUnroutable,
            disabled: protocol.disabled,
            failed: protocol.failed,
            remaining: Math.max(0, protocol.scheduled - (protocol.normalized + protocol.disabled + protocol.failed)),
          },
        ]),
      ),
    };
  }

  function logWarmupProgress(stats: WarmupStats, phase: string, logContext: FetchLogContext, meta: Record<string, unknown> = {}) {
    deps.log(`${logContext.label} progress: ${phase}.`, "info", {
      event: eventName(logContext, "progress"),
      phase,
      ...warmupProgressSnapshot(stats),
      ...(meta || {}),
    });
  }

  function resolveWarmupPersistBlock() {
    const registry = deps.getRegistry();
    const watcherCheckpoint = registry?.getCheckpoint("HYPERSYNC_WATCHER");
    const watcherBlock = Number(watcherCheckpoint?.last_block);
    if (Number.isFinite(watcherBlock) && watcherBlock >= 0) return watcherBlock;

    const globalCheckpoint = registry?.getGlobalCheckpoint();
    const globalBlock = Number(globalCheckpoint);
    if (Number.isFinite(globalBlock) && globalBlock >= 0) return globalBlock;

    // Discovery can fail before any checkpoint exists, but the fetched warmup
    // snapshot is still useful to resume from on the next boot.
    return 0;
  }

  function createWarmupStats(pools: PoolRecord[], groups: WarmupGroup[]): WarmupStats {
    return {
      scheduled: pools.length,
      fetched: 0,
      normalized: 0,
      observedUnroutable: 0,
      disabled: 0,
      failed: 0,
      protocols: Object.fromEntries(
        groups.map((group) => [
          group.key,
          { ...EMPTY_PROTOCOL_STATS, scheduled: pools.filter((pool) => group.protocols.has(normalizeProtocolKey(pool.protocol))).length },
        ]),
      ),
    } as WarmupStats;
  }

  function persistWarmupBatch(states: Array<{ pool_address: string; block: number; data: object }>, persistBlock: number | null) {
    if (persistBlock == null || states.length === 0) return;
    deps.getRegistry()?.batchUpdateStates(states);
  }

  function normalizeFetchedWarmupState(pool: PoolRecord, raw: unknown) {
    if (!raw) return null;
    const addr = pool.pool_address.toLowerCase();
    const tokens = deps.getPoolTokens(pool);
    if (!tokens.length) return null;
    const protocol = normalizeProtocolKey(pool.protocol);
    const metadata = getPoolMetadataWithDecimals(pool, tokens);

    if (WARMUP_V2.has(protocol) || WARMUP_V3.has(protocol)) {
      try {
        const snapshot = WARMUP_V2.has(protocol)
          ? normalizeV2State(addr, protocol, tokens, raw, metadata)
          : normalizeV3State(addr, protocol, tokens, raw, metadata);
        const verdict = deps.validatePoolState(snapshot);
        if (verdict.valid || isObservedUnroutableWarmupState(snapshot, verdict)) {
          return snapshot;
        }
        return null;
      } catch {
        return null;
      }
    }

    return deps.normalizePoolState(addr, protocol, tokens, raw, metadata);
  }

  function disableWarmupNoDataPools(
    pools: PoolRecord[],
    noDataFailures: Set<string> | undefined,
    sourceLabel: string,
    logContext: FetchLogContext,
    stats: WarmupStats,
    groupStats: WarmupGroupStats,
  ) {
    if (!(noDataFailures instanceof Set) || noDataFailures.size === 0) return;

    const registry = deps.getRegistry();
    for (const pool of pools) {
      const addr = pool.pool_address.toLowerCase();
      if (!noDataFailures.has(addr)) continue;

      registry?.disablePool(addr, `${sourceLabel}: readContract returned no data`);
      deps.stateCache.delete(addr);
      groupStats.disabled++;
      stats.disabled++;
      deps.log(`[${logContext.eventPrefix}] Disabled ${addr} after permanent ${sourceLabel} failure.`, "warn", {
        event: eventName(logContext, "disable_pool"),
        poolAddress: addr,
        source: sourceLabel,
        ...warmupProgressSnapshot(stats),
      });
    }
  }

  async function runWarmupGroup(
    pools: PoolRecord[],
    group: WarmupGroup,
    stats: WarmupStats,
    persistBlock: number | null,
    logContext: FetchLogContext,
  ) {
    if (!pools.length) return;

    const groupStats = stats.protocols[group.key];
    const persisted: Array<{ pool_address: string; block: number; data: object }> = [];
    const results = await group.fetch(pools, stats);
    const noDataFailures = new Set<string>();

    for (const result of results) {
      if (result.noDataFailures instanceof Set) {
        for (const addr of result.noDataFailures) noDataFailures.add(addr);
      }
      if (!result.raw || !result.normalized) continue;
      deps.stateCache.set(result.addr, result.normalized);
      if (persistBlock != null && result.persisted !== true) {
        persisted.push({ pool_address: result.addr, block: persistBlock, data: result.normalized });
      }
      const verdict = deps.validatePoolState(result.normalized);
      if (!verdict.valid && isObservedUnroutableWarmupState(result.normalized, verdict)) {
        groupStats.observedUnroutable++;
        stats.observedUnroutable++;
      }
      groupStats.fetched++;
      groupStats.normalized++;
      stats.fetched++;
      stats.normalized++;
    }

    const failedWithoutDisable = Math.max(0, groupStats.scheduled - (groupStats.normalized + noDataFailures.size));
    groupStats.failed += failedWithoutDisable;
    stats.failed += failedWithoutDisable;

    disableWarmupNoDataPools(
      pools,
      noDataFailures,
      `${String(group.key)} ${logContext.label.toLowerCase()}`,
      logContext,
      stats,
      groupStats,
    );
    persistWarmupBatch(persisted, persistBlock);

    if (group.progressPhase) {
      logWarmupProgress(stats, group.progressPhase, logContext, {
        protocol: group.key,
        completed: groupStats.normalized + groupStats.failed + groupStats.disabled,
        total: groupStats.scheduled,
      });
    }
  }

  async function fetchAndCacheStates(pools: PoolRecord[], options: FetchAndCacheOptions = {}) {
    const logContext = resolveFetchLogContext(options);
    if (!pools.length) {
      return {
        scheduled: 0,
        fetched: 0,
        normalized: 0,
        observedUnroutable: 0,
        disabled: 0,
        failed: 0,
        protocols: {},
      };
    }

    const supportedPools = pools.filter((pool) => supportsWarmupProtocol(pool));
    const unsupportedProtocols = [
      ...new Set(pools.filter((pool) => !supportsWarmupProtocol(pool)).map((pool) => String(pool.protocol || "unknown"))),
    ].sort();
    if (unsupportedProtocols.length > 0) {
      deps.log(`${logContext.label}: skipping unsupported protocols in RPC batch.`, "info", {
        event: eventName(logContext, "skip_unsupported_protocols"),
        skippedPools: pools.length - supportedPools.length,
        unsupportedProtocols,
      });
    }
    if (!supportedPools.length) {
      return {
        scheduled: 0,
        fetched: 0,
        normalized: 0,
        observedUnroutable: 0,
        disabled: 0,
        failed: 0,
        protocols: {},
      };
    }

    const persistBlock = resolveWarmupPersistBlock();
    const groups: WarmupGroup[] = [
      {
        key: "v2",
        protocols: WARMUP_V2,
        progressPhase: "v2_complete",
        async fetch(group) {
          const statesMap = await deps.fetchMultipleV2States(
            group.map((pool) => pool.pool_address),
            deps.v2PollConcurrency,
            { blockTag: options.blockTag },
          );
          return group.map((pool) => {
            const addr = pool.pool_address.toLowerCase();
            const raw = statesMap.get(addr);
            return {
              addr,
              raw,
              normalized: normalizeFetchedWarmupState(pool, raw),
              noDataFailures: statesMap?.noDataFailures,
            };
          });
        },
      },
      {
        key: "v3",
        protocols: WARMUP_V3,
        progressPhase: "v3_complete",
        async fetch(group) {
          const poolMeta = new Map();
          const poolByAddress = new Map<string, PoolRecord>();
          for (const pool of group) {
            poolByAddress.set(pool.pool_address.toLowerCase(), pool);
            if (isAlgebraPool(pool)) {
              const metadata = deps.getPoolMetadata(pool);
              poolMeta.set(pool.pool_address.toLowerCase(), {
                isAlgebra: true,
                isKyberElastic: normalizeProtocolKey(pool.protocol) === "KYBERSWAP_ELASTIC" || metadata?.isKyberElastic === true,
                swapFeeBps: metadata?.swapFeeBps,
                swapFeeUnits: metadata?.swapFeeUnits,
              });
            }
          }
          let lastV3ProgressLogAt = 0;
          const hydrationMode = options.v3HydrationMode ?? "tiered";
          const fullHydrationBudget = effectiveSyncWarmupV3FullBudget();
          const pendingV3ProgressPersist = new Map<string, { pool_address: string; block: number; data: object }>();
          const persistedV3Progress = new Set<string>();
          const flushV3ProgressPersist = () => {
            if (persistBlock == null || pendingV3ProgressPersist.size === 0) return;
            const batch = [...pendingV3ProgressPersist.values()];
            pendingV3ProgressPersist.clear();
            persistWarmupBatch(batch, persistBlock);
            for (const state of batch) persistedV3Progress.add(state.pool_address);
          };
          const persistPartialV3State = (addr: string, rawState: unknown | null | undefined) => {
            if (!rawState) return;
            const normalizedAddr = addr.toLowerCase();
            const pool = poolByAddress.get(normalizedAddr);
            if (!pool) return;
            const normalized = normalizeFetchedWarmupState(pool, rawState);
            if (!normalized) return;
            deps.stateCache.set(normalizedAddr, normalized);
            if (persistBlock != null) {
              pendingV3ProgressPersist.set(normalizedAddr, { pool_address: normalizedAddr, block: persistBlock, data: normalized });
              if (pendingV3ProgressPersist.size >= EFFECTIVE_WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE) {
                flushV3ProgressPersist();
              }
            }
          };
          const progress = (completed: number, total: number, addr: string, rawState: V3PoolState | null) => {
            if (addr) persistPartialV3State(addr, rawState);
            const now = Date.now();
            if (completed === total || completed % 10 === 0 || now - lastV3ProgressLogAt >= 5_000) {
              lastV3ProgressLogAt = now;
              deps.log(`${logContext.label} progress: v3_progress (${completed}/${total}).`, "info", {
                event: eventName(logContext, "progress"),
                phase: "v3_progress",
                protocol: "v3",
                completed,
                total,
                remaining: Math.max(0, total - completed),
              });
            }
          };
          const statesMap = new Map<string, V3PoolState>() as V3StateMap;

          if (hydrationMode === "tiered") {
            const fullPools = group.slice(0, fullHydrationBudget);
            const nearbyPools = group.slice(fullHydrationBudget);
            const noDataFailures = new Set<string>();
            let completed = 0;
            const total = group.length;

            for (const [batchPools, batchMode] of [
              [fullPools, "full"],
              [nearbyPools, "nearby"],
            ] as const) {
              if (batchPools.length === 0) continue;
              const batchStates = await deps.fetchMultipleV3States(
                batchPools.map((pool) => pool.pool_address),
                deps.v3PollConcurrency,
                poolMeta,
                (batchCompleted: number, batchTotal: number, addr: string, rawState: V3PoolState | null) => {
                  progress(completed + batchCompleted, total, addr, rawState);
                  if (batchCompleted === batchTotal) completed += batchTotal;
                },
                {
                  hydrationMode: batchMode,
                  nearWordRadius: options.v3NearWordRadius,
                  blockTag: options.blockTag,
                },
              );
              for (const [addr, state] of batchStates.entries()) statesMap.set(addr, state);
              if (batchStates.noDataFailures instanceof Set) {
                for (const addr of batchStates.noDataFailures) noDataFailures.add(addr);
              }
            }
            statesMap.noDataFailures = noDataFailures;
          } else {
            const batchStates = await deps.fetchMultipleV3States(
              group.map((pool) => pool.pool_address),
              deps.v3PollConcurrency,
              poolMeta,
              progress,
              {
                hydrationMode,
                nearWordRadius: options.v3NearWordRadius,
                blockTag: options.blockTag,
              },
            );
            for (const [addr, state] of batchStates.entries()) statesMap.set(addr, state);
            statesMap.noDataFailures = batchStates.noDataFailures;
          }
          flushV3ProgressPersist();
          return group.map((pool) => {
            const addr = pool.pool_address.toLowerCase();
            const raw = statesMap.get(addr);
            return {
              addr,
              raw,
              normalized: normalizeFetchedWarmupState(pool, raw),
              noDataFailures: statesMap?.noDataFailures,
              persisted: persistedV3Progress.has(addr),
            };
          });
        },
      },
      {
        key: "balancer",
        protocols: WARMUP_BAL,
        progressPhase: "balancer_progress",
        async fetch(group, stats) {
          let completed = 0;
          const groupTokens = [...new Set(group.flatMap((pool) => deps.getPoolTokens(pool).map((t) => t.toLowerCase())))];
          const tokenDecimals = deps.getRegistry()?.getTokenDecimals?.(groupTokens) ?? null;
          return deps.throttledMap(
            group,
            async (pool: PoolRecord) => {
              try {
                const { addr, normalized } = await withTimeout(
                  deps.fetchAndNormalizeBalancerPool(pool, { tokenDecimals }),
                  WARMUP_POOL_TIMEOUT_MS,
                  `Balancer pool ${pool.pool_address} warmup timed out`,
                );
                return { addr, raw: normalized, normalized };
              } catch {
                return { addr: pool.pool_address.toLowerCase(), raw: null, normalized: null };
              } finally {
                completed++;
                if (completed === group.length || completed % WARMUP_PROGRESS_LOG_EVERY === 0) {
                  logWarmupProgress(stats, "balancer_progress", logContext, {
                    protocol: "balancer",
                    completed,
                    total: group.length,
                  });
                }
              }
            },
            deps.enrichConcurrency,
          );
        },
      },
      {
        key: "curve",
        protocols: WARMUP_CRV,
        progressPhase: "curve_progress",
        async fetch(group, stats) {
          let completed = 0;
          const groupTokens = [...new Set(group.flatMap((pool) => deps.getPoolTokens(pool).map((t) => t.toLowerCase())))];
          const tokenDecimals = deps.getRegistry()?.getTokenDecimals?.(groupTokens) ?? null;
          return deps.throttledMap(
            group,
            async (pool: PoolRecord) => {
              try {
                const { addr, normalized } = await withTimeout(
                  deps.fetchAndNormalizeCurvePool(pool, { tokenDecimals }),
                  WARMUP_POOL_TIMEOUT_MS,
                  `Curve pool ${pool.pool_address} warmup timed out`,
                );
                return { addr, raw: normalized, normalized };
              } catch {
                return { addr: pool.pool_address.toLowerCase(), raw: null, normalized: null };
              } finally {
                completed++;
                if (completed === group.length || completed % WARMUP_PROGRESS_LOG_EVERY === 0) {
                  logWarmupProgress(stats, "curve_progress", logContext, {
                    protocol: "curve",
                    completed,
                    total: group.length,
                  });
                }
              }
            },
            deps.enrichConcurrency,
          );
        },
      },
      {
        key: "dodo",
        protocols: WARMUP_DODO,
        progressPhase: "dodo_progress",
        async fetch(group, stats) {
          let completed = 0;
          const groupTokens = [...new Set(group.flatMap((pool) => deps.getPoolTokens(pool).map((t) => t.toLowerCase())))];
          const tokenDecimals = deps.getRegistry()?.getTokenDecimals?.(groupTokens) ?? null;
          return deps.throttledMap(
            group,
            async (pool: PoolRecord) => {
              try {
                const { addr, normalized } = await withTimeout(
                  deps.fetchAndNormalizeDodoPool(pool, { tokenDecimals }),
                  WARMUP_POOL_TIMEOUT_MS,
                  `Dodo pool ${pool.pool_address} warmup timed out`,
                );
                return { addr, raw: normalized, normalized };
              } catch {
                return { addr: pool.pool_address.toLowerCase(), raw: null, normalized: null };
              } finally {
                completed++;
                if (completed === group.length || completed % WARMUP_PROGRESS_LOG_EVERY === 0) {
                  logWarmupProgress(stats, "dodo_progress", logContext, {
                    protocol: "dodo",
                    completed,
                    total: group.length,
                  });
                }
              }
            },
            deps.enrichConcurrency,
          );
        },
      },
      {
        key: "woofi",
        protocols: WARMUP_WOOFI,
        progressPhase: "woofi_progress",
        async fetch(group, stats) {
          let completed = 0;
          const groupTokens = [...new Set(group.flatMap((pool) => deps.getPoolTokens(pool).map((t) => t.toLowerCase())))];
          const tokenDecimals = deps.getRegistry()?.getTokenDecimals?.(groupTokens) ?? null;
          return deps.throttledMap(
            group,
            async (pool: PoolRecord) => {
              try {
                const { addr, normalized } = await withTimeout(
                  deps.fetchAndNormalizeWoofiPool(pool, { tokenDecimals }),
                  WARMUP_POOL_TIMEOUT_MS,
                  `WooFi pool ${pool.pool_address} warmup timed out`,
                );
                return { addr, raw: normalized, normalized };
              } catch {
                return { addr: pool.pool_address.toLowerCase(), raw: null, normalized: null };
              } finally {
                completed++;
                if (completed === group.length || completed % WARMUP_PROGRESS_LOG_EVERY === 0) {
                  logWarmupProgress(stats, "woofi_progress", logContext, {
                    protocol: "woofi",
                    completed,
                    total: group.length,
                  });
                }
              }
            },
            deps.enrichConcurrency,
          );
        },
      },
    ];

    const stats = createWarmupStats(supportedPools, groups);
    logWarmupProgress(stats, "rpc_fetch_started", logContext);
    await Promise.all(
      groups.map((group) => {
        const groupPools = supportedPools.filter((pool) => group.protocols.has(normalizeProtocolKey(pool.protocol)));
        return runWarmupGroup(groupPools, group, stats, persistBlock, logContext);
      }),
    );
    return stats;
  }

  function poolBothTokensAreHubs(pool: PoolRecord, hubTokens: Set<string>) {
    const tokens = deps.getPoolTokens(pool);
    if (!tokens || tokens.length < 2) return false;
    let hubMatches = 0;
    for (const token of tokens) {
      if (!hubTokens.has(token)) continue;
      hubMatches++;
      if (hubMatches >= 2) return true;
    }
    return false;
  }

  function poolTouchesAnyHub(pool: PoolRecord, hubTokens: Set<string>) {
    const tokens = deps.getPoolTokens(pool);
    if (!tokens || tokens.length === 0) return false;
    return tokens.some((token) => hubTokens.has(token));
  }

  function warmupPriority(pool: PoolRecord) {
    const tokens = deps.getPoolTokens(pool);
    let coreHubMatches = 0;
    let totalHubMatches = 0;
    for (const token of tokens) {
      if (deps.polygonHubTokens.has(token)) totalHubMatches++;
      if (deps.hub4Tokens.has(token)) coreHubMatches++;
    }
    const bothCoreHubs = coreHubMatches >= 2;
    const tokenCount = tokens.length > 0 ? tokens.length : Number.MAX_SAFE_INTEGER;
    const metadata = deps.getPoolMetadata(pool);
    const protocol = normalizeProtocolKey(pool.protocol);

    let protocolRank = 3;
    if (WARMUP_V2.has(protocol)) protocolRank = 0;
    else if (WARMUP_V3.has(protocol)) protocolRank = 1;
    else if (WARMUP_BAL.has(protocol)) protocolRank = 2;
    else if (WARMUP_DODO.has(protocol)) protocolRank = 2;
    else if (WARMUP_WOOFI.has(protocol)) protocolRank = 2;

    let metadataReadiness = 0;
    if (WARMUP_V2.has(protocol)) {
      if (metadata.feeNumerator != null || metadata.fee != null) metadataReadiness += 1;
    } else if (WARMUP_V3.has(protocol)) {
      if (metadata.fee != null) metadataReadiness += 2;
      if (metadata.tickSpacing != null) metadataReadiness += 1;
      if (metadata.isAlgebra === true) metadataReadiness += 1;
    } else if (WARMUP_BAL.has(protocol)) {
      if (metadata.poolId != null || metadata.pool_id != null) metadataReadiness += 2;
    } else if (WARMUP_CRV.has(protocol)) {
      if (metadata.coins != null || metadata.nCoins != null) metadataReadiness += 1;
    } else if (WARMUP_DODO.has(protocol)) {
      if (metadata.baseToken != null && metadata.quoteToken != null) metadataReadiness += 1;
    } else if (WARMUP_WOOFI.has(protocol)) {
      if (metadata.wooPP != null && metadata.quoteToken != null) metadataReadiness += 1;
    }

    return [
      bothCoreHubs ? 0 : 1,
      -Math.min(coreHubMatches, 4),
      -Math.min(totalHubMatches, 8),
      tokenCount,
      -metadataReadiness,
      protocolRank,
      pool.pool_address.toLowerCase(),
    ];
  }

  function compareWarmupPriority(a: PoolRecord, b: PoolRecord) {
    const left = warmupPriority(a);
    const right = warmupPriority(b);
    for (let i = 0; i < left.length; i++) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  }

  function seedStateCache() {
    const pools = deps.getRegistry()?.getPools({ status: "active" }) ?? [];
    let withState = 0;

    for (const pool of pools) {
      const addr = pool.pool_address.toLowerCase();
      if (pool.state?.data) {
        deps.stateCache.set(addr, pool.state.data);
        withState++;
      } else {
        deps.stateCache.set(addr, {
          poolId: addr,
          protocol: pool.protocol,
          tokens: deps.getPoolTokens(pool),
          timestamp: 0,
        });
      }
    }

    deps.log(
      `Seeded stateCache: ${withState} pools with persisted state, ${pools.length - withState} empty (${pools.length} total)`,
      "info",
      {
        event: "seed_state_cache",
        activePools: pools.length,
        persistedPools: withState,
        emptyPools: pools.length - withState,
      },
    );
  }

  async function warmupStateCache() {
    const activePools = deps.getRegistry()?.getActivePoolsMeta() ?? [];
    const needsState: PoolRecord[] = [];
    let observedUnroutablePools = 0;
    for (const pool of activePools) {
      const state = deps.stateCache.get(pool.pool_address.toLowerCase());
      const verdict = deps.validatePoolState(state);
      if (verdict.valid) continue;
      if (isObservedUnroutableWarmupState(state, verdict)) {
        observedUnroutablePools++;
        continue;
      }
      needsState.push(pool);
    }
    const supportedNeedsState = needsState.filter((pool: PoolRecord) => supportsWarmupProtocol(pool));
    const unsupportedHubAdjacentPools = needsState.filter(
      (pool: PoolRecord) => !supportsWarmupProtocol(pool) && poolTouchesAnyHub(pool, deps.polygonHubTokens),
    );

    if (needsState.length === 0) {
      deps.log("State cache already warm — skipping warmup.", "info", {
        event: "warmup_skip",
        reason: observedUnroutablePools > 0 ? "state_cache_warm_or_observed_unroutable" : "state_cache_already_warm",
        observedUnroutablePools,
      });
      return;
    }

    const hubPairPools = supportedNeedsState.filter((p: PoolRecord) => poolBothTokensAreHubs(p, deps.polygonHubTokens));
    const oneHubPools = supportedNeedsState.filter(
      (p: PoolRecord) => !poolBothTokensAreHubs(p, deps.polygonHubTokens) && poolTouchesAnyHub(p, deps.polygonHubTokens),
    );
    if (hubPairPools.length === 0 && oneHubPools.length === 0) {
      deps.log("State warmup: no hub-adjacent pools without state — watcher will populate the rest.", "info", {
        event: "warmup_skip",
        reason:
          unsupportedHubAdjacentPools.length > 0 ? "no_supported_hub_adjacent_pools_without_state" : "no_hub_adjacent_pools_without_state",
        needsState: needsState.length,
        supportedNeedsState: supportedNeedsState.length,
        unsupportedHubAdjacentPools: unsupportedHubAdjacentPools.length,
        observedUnroutablePools,
      });
      return;
    }

    function distributeBudget(pools: PoolRecord[], budget: number): PoolRecord[] {
      if (pools.length <= budget) return [...pools];
      const byProtocol = new Map<string, PoolRecord[]>();
      for (const pool of pools) {
        const key = normalizeProtocolKey(pool.protocol);
        if (!byProtocol.has(key)) byProtocol.set(key, []);
        byProtocol.get(key)!.push(pool);
      }
      for (const [, list] of byProtocol) list.sort(compareWarmupPriority);
      const numProtocols = byProtocol.size;
      const maxPerProtocol = Math.max(1, Math.ceil(budget / numProtocols));
      const result: PoolRecord[] = [];
      const counters = new Map<string, number>();
      for (const key of byProtocol.keys()) counters.set(key, 0);
      const iterators = [...byProtocol.entries()].map(([key, list]) => ({ key, list, idx: 0 }));
      while (result.length < budget) {
        let added = false;
        for (const it of iterators) {
          if (it.idx >= it.list.length) continue;
          if ((counters.get(it.key) ?? 0) >= maxPerProtocol) continue;
          result.push(it.list[it.idx++]);
          counters.set(it.key, (counters.get(it.key) ?? 0) + 1);
          added = true;
          if (result.length >= budget) break;
        }
        if (!added) break;
      }
      return result;
    }

    const prioritizedHubPairPools = distributeBudget(hubPairPools, deps.maxSyncWarmupPools);
    const secondaryWarmupBudget = Math.max(0, deps.maxSyncWarmupOneHubPools);
    const secondaryWarmupV3Budget = Math.max(0, deps.maxSyncWarmupOneHubV3Pools);
    const oneHubV3Pools = oneHubPools.filter((pool: PoolRecord) => WARMUP_V3.has(normalizeProtocolKey(pool.protocol)));
    const oneHubNonV3Pools = oneHubPools.filter((pool: PoolRecord) => !WARMUP_V3.has(normalizeProtocolKey(pool.protocol)));
    const prioritizedOneHubPools = distributeBudget(oneHubNonV3Pools, secondaryWarmupBudget);
    const prioritizedOneHubV3Pools = takeTopNBy(oneHubV3Pools, secondaryWarmupV3Budget, compareWarmupPriority);
    const syncWarmupPools = [];

    for (const pool of prioritizedHubPairPools) {
      syncWarmupPools.push(pool);
    }

    let secondaryWarmupPools = 0;
    for (const pool of prioritizedOneHubPools) {
      if (secondaryWarmupPools >= secondaryWarmupBudget) break;
      syncWarmupPools.push(pool);
      secondaryWarmupPools++;
    }
    let secondaryWarmupV3Pools = 0;
    for (const pool of prioritizedOneHubV3Pools) {
      if (secondaryWarmupV3Pools >= secondaryWarmupV3Budget) break;
      syncWarmupPools.push(pool);
      secondaryWarmupV3Pools++;
    }

    const targetedPools = hubPairPools.length + oneHubPools.length;
    const deferredPools = targetedPools - syncWarmupPools.length;

    if (syncWarmupPools.length === 0) {
      deps.log("State warmup: synchronous warmup budget is 0 — watcher will populate hub-adjacent pools.", "info", {
        event: "warmup_skip",
        reason: "sync_warmup_budget_zero",
        hubPairPools: hubPairPools.length,
        oneHubPools: oneHubPools.length,
        oneHubV3Pools: oneHubV3Pools.length,
        maxSyncWarmupOneHubV3Pools: deps.maxSyncWarmupOneHubV3Pools,
      });
      return;
    }

    let v2Count = 0;
    let v3Count = 0;
    let balancerCount = 0;
    let curveCount = 0;
    let dodoCount = 0;
    let woofiCount = 0;
    for (const pool of syncWarmupPools) {
      const protocol = normalizeProtocolKey(pool.protocol);
      if (WARMUP_V2.has(protocol)) v2Count++;
      else if (WARMUP_V3.has(protocol)) v3Count++;
      else if (WARMUP_BAL.has(protocol)) balancerCount++;
      else if (WARMUP_CRV.has(protocol)) curveCount++;
      else if (WARMUP_DODO.has(protocol)) dodoCount++;
      else if (WARMUP_WOOFI.has(protocol)) woofiCount++;
    }

    deps.log(`State warmup: fetching ${syncWarmupPools.length}/${targetedPools} hub-adjacent pools via RPC (sync)...`, "info", {
      event: "warmup_start",
      needsState: needsState.length,
      supportedNeedsState: supportedNeedsState.length,
      unsupportedHubAdjacentPools: unsupportedHubAdjacentPools.length,
      observedUnroutablePools,
      hubPairPools: hubPairPools.length,
      oneHubPools: oneHubPools.length,
      oneHubV3Pools: oneHubV3Pools.length,
      syncWarmupPools: syncWarmupPools.length,
      secondaryWarmupPools,
      secondaryWarmupV3Pools,
      deferredPools,
      maxSyncWarmupPools: deps.maxSyncWarmupPools,
      maxSyncWarmupV3Pools: deps.maxSyncWarmupV3Pools,
      effectiveSyncWarmupV3FullBudget: effectiveSyncWarmupV3FullBudget(),
      maxSyncWarmupOneHubPools: deps.maxSyncWarmupOneHubPools,
      maxSyncWarmupOneHubV3Pools: deps.maxSyncWarmupOneHubV3Pools,
      protocolBreakdown: {
        v2: v2Count,
        v3: v3Count,
        balancer: balancerCount,
        curve: curveCount,
        dodo: dodoCount,
        woofi: woofiCount,
      },
    });

    const warmupStats = await fetchAndCacheStates(syncWarmupPools);
    let valid = 0;
    for (const pool of syncWarmupPools) {
      if (deps.validatePoolState(deps.stateCache.get(pool.pool_address.toLowerCase())).valid) {
        valid++;
      }
    }
    deps.log(`State warmup complete: ${valid}/${syncWarmupPools.length} sync hub-adjacent pools routable.`, "info", {
      event: "warmup_complete",
      supportedNeedsState: supportedNeedsState.length,
      unsupportedHubAdjacentPools: unsupportedHubAdjacentPools.length,
      observedUnroutablePools,
      hubPairPools: hubPairPools.length,
      oneHubPools: oneHubPools.length,
      oneHubV3Pools: oneHubV3Pools.length,
      syncWarmupPools: syncWarmupPools.length,
      secondaryWarmupPools,
      secondaryWarmupV3Pools,
      deferredPools,
      routablePools: valid,
      unroutablePools: syncWarmupPools.length - valid,
      warmupStats,
    });
  }

  return {
    fetchAndCacheStates,
    seedStateCache,
    warmupStateCache,
  };
}
