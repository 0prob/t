import { createPublicClient, webSocket } from "viem";
import { polygon } from "viem/chains";
import {
  ENABLE_V3_PROTOCOLS,
  PENDING_STATE_REFRESH_BATCH_SIZE,
  PENDING_STATE_REFRESH_TTL_MS,
  PENDING_TX_FETCH_BATCH_SIZE,
  PENDING_TX_FETCH_CONCURRENCY,
  PENDING_TX_WATCHER_ENABLED,
  POLYGON_WS_RPC_URL,
  V3_NEARBY_WORD_RADIUS,
  validatePolygonWsRpcUrl,
} from "../config/index.ts";
import { normalizeEvmAddress } from "../utils/identity.ts";
import { ALL_V3_PROTOCOLS, normalizeProtocolKey } from "../protocols/classification.ts";
import { errorMessage } from "../utils/errors.ts";
import { getPoolMetadata, getPoolTokens } from "../utils/pool_record.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;
type PoolState = Record<string, unknown>;
type StateCache = Map<string, PoolState>;
type Unwatch = () => void;

type PoolRecord = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
};

type PendingTransactionLike = {
  to?: unknown;
  input?: unknown;
  data?: unknown;
  hash?: unknown;
};

type PoolTokenPairIndexEntry = { poolAddress: string; fee: number | null };
type PoolTokenPairIndex = Map<string, PoolTokenPairIndexEntry[]>;
type PendingTxTouchOptions = {
  includeV3Protocols?: boolean;
};

type PendingTxWatcherDeps = {
  isRunning: () => boolean;
  stateCache: StateCache;
  getPoolRecord: (poolAddress: string) => PoolRecord | null | undefined;
  fetchAndCacheStates: (pools: PoolRecord[], options: Record<string, unknown>) => Promise<unknown>;
  handlePoolsChanged: (changedPools: Set<string>) => Promise<unknown> | unknown;
  scheduleArb: (changedPools?: number) => void;
  log: LoggerFn;
  wsUrl?: string;
  enabled?: boolean;
  refreshTtlMs?: number;
  refreshBatchSize?: number;
  txFetchBatchSize?: number;
  txFetchConcurrency?: number;
  v3NearWordRadius?: number;
  includeV3Protocols?: boolean;
  flushDelayMs?: number;
  createClient?: () => PendingTxClient;
};

type PendingTxClient = {
  watchPendingTransactions: (args: {
    batch: boolean;
    onTransactions: (hashes: readonly `0x${string}`[]) => void;
    onError: (error: unknown) => void;
  }) => Unwatch;
  watchBlocks: (args: {
    emitMissed: boolean;
    onBlock: (block: { number?: bigint | number | null }) => void;
    onError: (error: unknown) => void;
  }) => Unwatch;
  getTransaction: (args: { hash: `0x${string}` }) => Promise<PendingTransactionLike>;
};

function normalizePositiveInteger(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
}

function extractEncodedAddressesInOrder(input: unknown) {
  const data = String(input ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 66) return [];
  const addresses: string[] = [];
  for (let offset = 10; offset + 64 <= data.length; offset += 64) {
    const word = data.slice(offset, offset + 64);
    const candidate = normalizeEvmAddress(`0x${word.slice(24)}`);
    if (candidate) addresses.push(candidate);
  }
  return addresses;
}

export function extractEncodedAddresses(input: unknown) {
  return [...new Set(extractEncodedAddressesInOrder(input))];
}

function tokenPairKey(a: string, b: string) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function poolFeePips(pool: PoolRecord, state: PoolState | undefined) {
  const metadata = getPoolMetadata(pool);
  for (const value of [state?.fee, pool.state?.data?.fee, metadata.fee]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  return null;
}

function isV3FamilyProtocol(protocol: unknown) {
  return ALL_V3_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

export function buildPoolTokenPairIndex(
  pools: Iterable<PoolRecord>,
  stateCache: StateCache,
  options: PendingTxTouchOptions = {},
): PoolTokenPairIndex {
  const includeV3Protocols = options.includeV3Protocols ?? ENABLE_V3_PROTOCOLS;
  const index: PoolTokenPairIndex = new Map();
  for (const pool of pools) {
    if (!includeV3Protocols && isV3FamilyProtocol(pool.protocol)) continue;
    const poolAddress = normalizeEvmAddress(pool.pool_address);
    const state = poolAddress ? stateCache.get(poolAddress) : undefined;
    if (!poolAddress || !state) continue;
    const fee = poolFeePips(pool, state);
    const tokens = getPoolTokens(pool);
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const tokenA = tokens[i];
        const tokenB = tokens[j];
        if (!tokenA || !tokenB || tokenA === tokenB) continue;
        const key = tokenPairKey(tokenA, tokenB);
        const entry = { poolAddress, fee };
        const existing = index.get(key);
        if (existing) existing.push(entry);
        else index.set(key, [entry]);
      }
    }
  }
  return index;
}

type PoolTokenPairIndexCacheDeps = {
  stateCache: StateCache;
  getPoolRecord: (poolAddress: string) => PoolRecord | null | undefined;
  includeV3Protocols?: boolean;
  buildIndex?: typeof buildPoolTokenPairIndex;
};

export function createPoolTokenPairIndexCache(deps: PoolTokenPairIndexCacheDeps) {
  const buildIndex = deps.buildIndex ?? buildPoolTokenPairIndex;
  let cachedIndex: PoolTokenPairIndex | null = null;
  let cachedPoolCount = -1;

  function rebuild() {
    const pools: PoolRecord[] = [];
    for (const addr of deps.stateCache.keys()) {
      const pool = deps.getPoolRecord(addr);
      if (pool) pools.push(pool);
    }
    cachedPoolCount = deps.stateCache.size;
    cachedIndex = buildIndex(pools, deps.stateCache, { includeV3Protocols: deps.includeV3Protocols });
    return cachedIndex;
  }

  return {
    get() {
      if (!cachedIndex || cachedPoolCount !== deps.stateCache.size) return rebuild();
      return cachedIndex;
    },
    invalidate() {
      cachedIndex = null;
      cachedPoolCount = -1;
    },
  };
}

function addPoolsForTokenPath(touched: Set<string>, addresses: readonly string[], tokenPairIndex: PoolTokenPairIndex | null | undefined) {
  if (!tokenPairIndex || addresses.length < 2) return;
  for (let i = 0; i + 1 < addresses.length; i++) {
    const tokenA = addresses[i];
    const tokenB = addresses[i + 1];
    if (!tokenA || !tokenB || tokenA === tokenB) continue;
    const pools = tokenPairIndex.get(tokenPairKey(tokenA, tokenB));
    if (!pools) continue;
    for (const pool of pools) touched.add(pool.poolAddress);
  }
}

function addPoolsForPackedV3Paths(touched: Set<string>, input: unknown, tokenPairIndex: PoolTokenPairIndex | null | undefined) {
  if (!tokenPairIndex) return;
  const data = String(input ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 88) return;
  const hex = data.slice(2).toLowerCase();
  const packedHopChars = 40 + 6 + 40;
  for (let offset = 0; offset + packedHopChars <= hex.length; offset += 2) {
    const tokenA = normalizeEvmAddress(`0x${hex.slice(offset, offset + 40)}`);
    if (!tokenA) continue;
    const feeHex = hex.slice(offset + 40, offset + 46);
    const fee = Number.parseInt(feeHex, 16);
    if (!Number.isFinite(fee) || fee <= 0 || fee > 1_000_000) continue;
    const tokenB = normalizeEvmAddress(`0x${hex.slice(offset + 46, offset + 86)}`);
    if (!tokenB || tokenA === tokenB) continue;
    const pools = tokenPairIndex.get(tokenPairKey(tokenA, tokenB));
    if (!pools) continue;
    const feeMatchedPools = pools.filter((pool) => pool.fee === fee);
    const poolsToTouch = feeMatchedPools.length > 0 ? feeMatchedPools : pools;
    for (const pool of poolsToTouch) touched.add(pool.poolAddress);
  }
}

export function touchedPoolsFromPendingTransaction(
  tx: PendingTransactionLike,
  stateCache: StateCache,
  tokenPairIndexOrPools?: PoolTokenPairIndex | Iterable<PoolRecord>,
  options: PendingTxTouchOptions = {},
) {
  const includeV3Protocols = options.includeV3Protocols ?? ENABLE_V3_PROTOCOLS;
  const touched = new Set<string>();
  const to = normalizeEvmAddress(tx?.to);
  if (to && stateCache.has(to)) touched.add(to);

  const calldata = tx?.input ?? tx?.data;
  const encodedAddresses = extractEncodedAddressesInOrder(calldata);
  for (const candidate of new Set(encodedAddresses)) {
    if (stateCache.has(candidate)) touched.add(candidate);
  }

  const tokenPairIndex =
    tokenPairIndexOrPools instanceof Map
      ? tokenPairIndexOrPools
      : tokenPairIndexOrPools
        ? buildPoolTokenPairIndex([...tokenPairIndexOrPools], stateCache, { includeV3Protocols })
        : null;
  addPoolsForTokenPath(touched, encodedAddresses, tokenPairIndex);
  if (includeV3Protocols) addPoolsForPackedV3Paths(touched, calldata, tokenPairIndex);
  return touched;
}

export function createPendingTxStateWatcher(deps: PendingTxWatcherDeps) {
  const configuredWsUrl = deps.wsUrl ?? POLYGON_WS_RPC_URL;
  const wsUrlValidation = validatePolygonWsRpcUrl(configuredWsUrl);
  const wsUrl = wsUrlValidation.url;
  const enabled = Boolean(wsUrl) && (deps.enabled ?? PENDING_TX_WATCHER_ENABLED);
  const refreshTtlMs = normalizePositiveInteger(deps.refreshTtlMs ?? PENDING_STATE_REFRESH_TTL_MS, 100);
  const refreshBatchSize = normalizePositiveInteger(deps.refreshBatchSize ?? PENDING_STATE_REFRESH_BATCH_SIZE, 32);
  const txFetchBatchSize = normalizePositiveInteger(deps.txFetchBatchSize ?? PENDING_TX_FETCH_BATCH_SIZE, 24);
  const txFetchConcurrency = normalizePositiveInteger(deps.txFetchConcurrency ?? PENDING_TX_FETCH_CONCURRENCY, 4);
  const includeV3Protocols = deps.includeV3Protocols ?? ENABLE_V3_PROTOCOLS;
  const v3NearWordRadius = normalizePositiveInteger(deps.v3NearWordRadius ?? V3_NEARBY_WORD_RADIUS, 2);
  const flushDelayMs = Math.max(0, Number(deps.flushDelayMs ?? 25) || 0);
  const pendingPools = new Set<string>();
  const lastRefreshByPool = new Map<string, number>();
  let client: PendingTxClient | null = null;
  let unwatchPending: Unwatch | null = null;
  let unwatchBlocks: Unwatch | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight = false;
  let started = false;

  const poolTokenPairIndexCache = createPoolTokenPairIndexCache({
    stateCache: deps.stateCache,
    getPoolRecord: deps.getPoolRecord,
    includeV3Protocols,
  });

  function createClient() {
    if (deps.createClient) return deps.createClient();
    return createPublicClient({
      chain: polygon,
      transport: webSocket(wsUrl, {
        reconnect: true,
        retryCount: 10,
        retryDelay: 500,
        timeout: 10_000,
      }),
      batch: {
        multicall: { wait: 16 },
      },
    }) as PendingTxClient;
  }

  function enqueuePools(pools: Iterable<string>) {
    for (const pool of pools) {
      const normalized = normalizeEvmAddress(pool);
      if (!normalized) continue;
      pendingPools.add(normalized);
    }
    if (pendingPools.size === 0 || flushTimer || flushInFlight) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPendingPools();
    }, flushDelayMs);
    flushTimer.unref?.();
  }

  async function flushPendingPools(): Promise<void> {
    if (flushInFlight || pendingPools.size === 0 || !deps.isRunning()) return;
    flushInFlight = true;
    let attemptedRefreshPools = 0;
    try {
      const now = Date.now();
      const selected: string[] = [];
      for (const addr of pendingPools) {
        pendingPools.delete(addr);
        const lastRefresh = lastRefreshByPool.get(addr) ?? 0;
        if (now - lastRefresh < refreshTtlMs) continue;
        selected.push(addr);
        if (selected.length >= refreshBatchSize) break;
      }

      if (selected.length === 0) return;

      const records = selected.map((addr) => deps.getPoolRecord(addr)).filter((pool): pool is PoolRecord => pool != null);
      if (records.length === 0) return;
      attemptedRefreshPools = records.length;

      deps.log(`[mempool] Refreshing ${records.length} touched pool state(s) from pending block tag`, "debug", {
        event: "pending_state_refresh",
        pools: records.length,
        ttlMs: refreshTtlMs,
      });

      const fetchOptions: Record<string, unknown> = {
        blockTag: "pending",
        logContext: {
          label: "Pending tx refresh",
          eventPrefix: "pending_state_refresh",
        },
      };
      if (includeV3Protocols) {
        fetchOptions.v3HydrationMode = "nearby";
        fetchOptions.v3NearWordRadius = v3NearWordRadius;
      }

      await deps.fetchAndCacheStates(records, fetchOptions);
      poolTokenPairIndexCache.invalidate();

      const changedPools = new Set(records.map((pool) => pool.pool_address.toLowerCase()));
      for (const addr of changedPools) lastRefreshByPool.set(addr, Date.now());
      await deps.handlePoolsChanged(changedPools);
      deps.scheduleArb(changedPools.size);
    } catch (err) {
      const reason = errorMessage(err);
      deps.log(`Pending state refresh failed: ${reason}`, "warn", {
        event: "pending_state_refresh_error",
        err,
        reason,
        pools: attemptedRefreshPools,
        ttlMs: refreshTtlMs,
      });
    } finally {
      flushInFlight = false;
      if (pendingPools.size > 0 && deps.isRunning()) {
        enqueuePools([]);
      }
    }
  }

  async function handlePendingHashes(hashes: readonly `0x${string}`[]) {
    if (!client || !deps.isRunning() || hashes.length === 0) return;
    const limited = hashes.slice(0, txFetchBatchSize);
    const tokenPairIndex = poolTokenPairIndexCache.get();
    const touchedSets = await mapWithConcurrency(limited, Math.min(txFetchConcurrency, limited.length), async (hash) => {
      try {
        const tx = await client!.getTransaction({ hash });
        return touchedPoolsFromPendingTransaction(tx, deps.stateCache, tokenPairIndex, { includeV3Protocols });
      } catch {
        return new Set<string>();
      }
    });
    const touched = new Set<string>();
    for (const set of touchedSets) {
      for (const addr of set) touched.add(addr);
    }
    if (touched.size > 0) {
      deps.log(`[mempool] ${touched.size} known pool(s) touched by pending tx batch`, "debug", {
        event: "pending_tx_touched_pools",
        hashes: limited.length,
        touchedPools: touched.size,
      });
      enqueuePools(touched);
    }
  }

  function handleBlock(block: { number?: bigint | number | null }) {
    lastRefreshByPool.clear();
    poolTokenPairIndexCache.invalidate();
    deps.log("[mempool] New block observed on WebSocket feed", "debug", {
      event: "ws_block",
      blockNumber: block?.number != null ? String(block.number) : null,
    });
    deps.scheduleArb(0);
  }

  function start() {
    if (started) return;
    started = true;
    if (!enabled || !wsUrl) {
      deps.log("[mempool] WebSocket pending tx watcher disabled", "debug", {
        event: "pending_tx_watcher_disabled",
        enabled,
        hasWsUrl: Boolean(wsUrl),
        reason: configuredWsUrl && !wsUrl ? wsUrlValidation.reason : null,
      });
      return;
    }

    client = createClient();
    unwatchPending = client.watchPendingTransactions({
      batch: true,
      onTransactions: (hashes) => {
        void handlePendingHashes(hashes);
      },
      onError: (err) => {
        const reason = errorMessage(err);
        deps.log(`Pending tx WebSocket subscription error: ${reason}`, "warn", {
          event: "pending_tx_ws_error",
          err,
          reason,
        });
      },
    });
    unwatchBlocks = client.watchBlocks({
      emitMissed: true,
      onBlock: handleBlock,
      onError: (err) => {
        const reason = errorMessage(err);
        deps.log(`Block WebSocket subscription error: ${reason}`, "warn", {
          event: "block_ws_error",
          err,
          reason,
        });
      },
    });
    deps.log("[mempool] WebSocket pending tx and block watcher started", "info", {
      event: "pending_tx_watcher_start",
      refreshTtlMs,
      refreshBatchSize,
      txFetchBatchSize,
      txFetchConcurrency,
      includeV3Protocols,
    });
  }

  function stop() {
    if (!started) return;
    started = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingPools.clear();
    unwatchPending?.();
    unwatchBlocks?.();
    unwatchPending = null;
    unwatchBlocks = null;
    client = null;
    deps.log("[mempool] WebSocket pending tx and block watcher stopped", "debug", {
      event: "pending_tx_watcher_stop",
    });
  }

  return {
    start,
    stop,
    _enqueuePools: enqueuePools,
    _flushPendingPools: flushPendingPools,
  };
}
