import { chunk } from "../utils/concurrency.ts";
import { LogField, JoinMode } from "../hypersync/client.ts";
import { buildHyperSyncLogQuery, DEFAULT_HYPERSYNC_BLOCK_FIELDS, type HyperSyncLogQuery } from "../hypersync/query_policy.ts";
import { topic0ForSignature } from "../hypersync/topics.ts";
import {
  HYPERSYNC_BATCH_SIZE,
  HYPERSYNC_MAX_ADDRESS_FILTER,
  HYPERSYNC_MAX_BLOCKS_PER_REQUEST,
  HYPERSYNC_MAX_FILTERS_PER_REQUEST,
} from "../config/index.ts";
import { HUB_4_TOKENS, POLYGON_HUB_TOKENS } from "../routing/graph.ts";
import type { WatcherTopicMap } from "./watcher_types.ts";

const V2_SYNC = "event Sync(uint112 reserve0, uint112 reserve1)";
const V3_SWAP =
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
const V3_MINT =
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
const V3_BURN =
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
const BAL_BALANCE =
  "event PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)";
const CURVE_EXCHANGE_STABLE =
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
const CURVE_EXCHANGE_CRYPTO =
  "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought)";
const CURVE_EXCHANGE_UNDERLYING =
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
const DODO_SWAP =
  "event DODOSwap(address fromToken, address toToken, uint256 fromAmount, uint256 toAmount, address trader, address receiver)";
const WOOFI_SWAP =
  "event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee)";

export const WATCHER_SIGNATURES = [
  V2_SYNC,
  V3_SWAP,
  V3_MINT,
  V3_BURN,
  BAL_BALANCE,
  CURVE_EXCHANGE_STABLE,
  CURVE_EXCHANGE_CRYPTO,
  CURVE_EXCHANGE_UNDERLYING,
  DODO_SWAP,
  WOOFI_SWAP,
];

export const WATCHER_TOPIC0 = {
  V2_SYNC: topic0ForSignature(V2_SYNC),
  V3_SWAP: topic0ForSignature(V3_SWAP),
  V3_MINT: topic0ForSignature(V3_MINT),
  V3_BURN: topic0ForSignature(V3_BURN),
  BAL_BALANCE: topic0ForSignature(BAL_BALANCE),
  CURVE_EXCHANGE_STABLE: topic0ForSignature(CURVE_EXCHANGE_STABLE),
  CURVE_EXCHANGE_CRYPTO: topic0ForSignature(CURVE_EXCHANGE_CRYPTO),
  CURVE_EXCHANGE_UNDERLYING: topic0ForSignature(CURVE_EXCHANGE_UNDERLYING),
  DODO_SWAP: topic0ForSignature(DODO_SWAP),
  WOOFI_SWAP: topic0ForSignature(WOOFI_SWAP),
} as const satisfies WatcherTopicMap;

let _watcherTopics: string[] | null = null;

function _getWatcherTopics(): string[] {
  if (_watcherTopics) return _watcherTopics;
  let v3Enabled = true;
  try {
    const env = process.env.ENABLE_V3_PROTOCOLS;
    v3Enabled = env === undefined || env === "" || env === "true" || env === "1";
  } catch {
    /* config not ready */
  }
  _watcherTopics = [
    WATCHER_TOPIC0.V2_SYNC,
    ...(v3Enabled ? [WATCHER_TOPIC0.V3_SWAP, WATCHER_TOPIC0.V3_MINT, WATCHER_TOPIC0.V3_BURN] : []),
    WATCHER_TOPIC0.BAL_BALANCE,
    WATCHER_TOPIC0.CURVE_EXCHANGE_STABLE,
    WATCHER_TOPIC0.CURVE_EXCHANGE_CRYPTO,
    WATCHER_TOPIC0.CURVE_EXCHANGE_UNDERLYING,
    WATCHER_TOPIC0.DODO_SWAP,
    WATCHER_TOPIC0.WOOFI_SWAP,
  ];
  return _watcherTopics;
}

const WATCHER_LOG_FIELDS = [
  LogField.Address,
  LogField.Data,
  LogField.Topic0,
  LogField.Topic1,
  LogField.Topic2,
  LogField.Topic3,
  LogField.BlockNumber,
  LogField.BlockHash,
  LogField.TransactionHash,
  LogField.LogIndex,
  LogField.TransactionIndex,
];

export function normalizeWatchedAddresses(addresses: unknown[]) {
  if (!Array.isArray(addresses) || addresses.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const address of addresses) {
    if (typeof address !== "string") continue;
    const next = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(next) || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

export function watcherFilterMode(addrCount: number) {
  const normalizedCount = Math.max(0, Number(addrCount) || 0);
  const shardCount = Math.max(1, Math.ceil(normalizedCount / HYPERSYNC_MAX_ADDRESS_FILTER));
  const requestCount = Math.max(1, Math.ceil(shardCount / HYPERSYNC_MAX_FILTERS_PER_REQUEST));
  if (normalizedCount === 0) return "topic-only (no pools yet)";
  if (shardCount === 1) return `${normalizedCount} pool address(es)`;
  return `${normalizedCount} pool address(es) across ${shardCount} filter shard(s) and ${requestCount} request(s)`;
}

export function buildWatcherLogQueries(addresses: unknown[], fromBlock: number): HyperSyncLogQuery[] {
  const watchedAddresses = normalizeWatchedAddresses(addresses);

  // Sort addresses by activity/liquidity priority if available
  // High-liquidity pools get prioritized in earlier filter slots
  const sortedAddresses = sortAddressesByPriority(watchedAddresses);

  const logFilters =
    sortedAddresses.length > 0
      ? chunk(sortedAddresses, HYPERSYNC_MAX_ADDRESS_FILTER).map((address) => ({
          address,
          topics: [_getWatcherTopics()],
        }))
      : [{ topics: [_getWatcherTopics()] }];

  return chunk(logFilters, HYPERSYNC_MAX_FILTERS_PER_REQUEST).map((logs) =>
    buildHyperSyncLogQuery({
      fromBlock,
      logs,
      maxNumLogs: HYPERSYNC_BATCH_SIZE,
      // Bound catch-up scans so resumed live polling stays within HyperSync's
      // documented request-time budget after downtime.
      maxNumBlocks: HYPERSYNC_MAX_BLOCKS_PER_REQUEST,
      joinMode: JoinMode.JoinNothing,
      logFields: WATCHER_LOG_FIELDS,
      blockFields: DEFAULT_HYPERSYNC_BLOCK_FIELDS,
    }),
  );
}

/**
 * Sort addresses by priority (liquidity/activity).
 * High-value pools appear first to maximize discovery in limited filter slots.
 * Priority tiers:
 *   1. HUB_4_TOKENS (highest liquidity bluechip pairs)
 *   2. Known high-activity pools from cached swap frequency hints
 *   3. Remaining pools (stable ordering)
 */
const _priorityCache = new Map<string, number>();
let _priorityCacheEpoch = 0;

function sortAddressesByPriority(addresses: string[]): string[] {
  if (addresses.length <= 1) return addresses;
  const result = [...addresses];
  const epoch = Date.now();
  const cacheTTL = 120_000; // 2 min cache

  if (epoch - _priorityCacheEpoch > cacheTTL) {
    _priorityCache.clear();
    _priorityCacheEpoch = epoch;
  }

  result.sort((a, b) => {
    let pa = _priorityCache.get(a);
    if (pa === undefined) {
      pa = _poolPriorityScore(a);
      _priorityCache.set(a, pa);
    }
    let pb = _priorityCache.get(b);
    if (pb === undefined) {
      pb = _poolPriorityScore(b);
      _priorityCache.set(b, pb);
    }
    return pb - pa;
  });
  return result;
}

function _poolPriorityScore(address: string): number {
  if (HUB_4_TOKENS.has(address)) return 200;
  if (POLYGON_HUB_TOKENS.has(address)) return 100;
  if (address.startsWith("0x00000000000000000000000000000000000000")) return -1;
  return 0;
}
