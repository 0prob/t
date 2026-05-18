import { topic0ForSignature } from "../../hypersync/topics.ts";
import type { HyperSyncRawLog } from "../../hypersync/logs.ts";
import { topicArrayFromHyperSyncLog } from "../../hypersync/logs.ts";
import type {
  DecodedWatcherLog,
  MutableWatcherState,
  WatcherEnqueueEnrichment,
  WatcherPoolMeta,
  WatcherPoolRefresh,
  WatcherV3Refresh,
} from "../../state/watcher_types.ts";
import {
  updateV2State,
  updateV3SwapState,
  updateV3LiquidityState,
} from "./state_ops.ts";

const V2_SYNC_SIG = "event Sync(uint112 reserve0, uint112 reserve1)";
const V3_SWAP_SIG =
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
const V3_MINT_SIG =
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
const V3_BURN_SIG =
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
const BAL_BALANCE_SIG =
  "event PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)";
const CURVE_EXCHANGE_STABLE_SIG =
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
const CURVE_EXCHANGE_CRYPTO_SIG =
  "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought)";
const CURVE_EXCHANGE_UNDERLYING_SIG =
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
const DODO_SWAP_SIG =
  "event DODOSwap(address fromToken, address toToken, uint256 fromAmount, uint256 toAmount, address trader, address receiver)";
const WOOFI_SWAP_SIG =
  "event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee)";

export const TOPIC0 = {
  V2_SYNC: topic0ForSignature(V2_SYNC_SIG),
  V3_SWAP: topic0ForSignature(V3_SWAP_SIG),
  V3_MINT: topic0ForSignature(V3_MINT_SIG),
  V3_BURN: topic0ForSignature(V3_BURN_SIG),
  BAL_BALANCE: topic0ForSignature(BAL_BALANCE_SIG),
  CURVE_EXCHANGE_STABLE: topic0ForSignature(CURVE_EXCHANGE_STABLE_SIG),
  CURVE_EXCHANGE_CRYPTO: topic0ForSignature(CURVE_EXCHANGE_CRYPTO_SIG),
  CURVE_EXCHANGE_UNDERLYING: topic0ForSignature(CURVE_EXCHANGE_UNDERLYING_SIG),
  DODO_SWAP: topic0ForSignature(DODO_SWAP_SIG),
  WOOFI_SWAP: topic0ForSignature(WOOFI_SWAP_SIG),
} as const;

export type LogHandlerContext = {
  addr: string;
  log: HyperSyncRawLog;
  pool: WatcherPoolMeta | null;
  state: MutableWatcherState;
  decoded: DecodedWatcherLog;
  enqueueEnrichment: WatcherEnqueueEnrichment;
  refreshBalancer: WatcherPoolRefresh;
  refreshCurve: WatcherPoolRefresh;
  refreshDodo: WatcherPoolRefresh;
  refreshWoofi: WatcherPoolRefresh;
  refreshV3: WatcherV3Refresh;
};

export type LogHandler = (ctx: LogHandlerContext) => boolean;

function hasInitializedV3BaseState(state: MutableWatcherState) {
  return (
    state?.initialized === true &&
    state?.sqrtPriceX96 != null &&
    state?.sqrtPriceX96 !== 0n &&
    Number.isInteger(state?.tick) &&
    state?.liquidity != null
  );
}

function buildHandlerMap(): Map<string, LogHandler> {
  return new Map<string, LogHandler>([
    [
      TOPIC0.V2_SYNC,
      ({ state, decoded, pool }) => {
        updateV2State(state, decoded, pool);
        return true;
      },
    ],
    [
      TOPIC0.V3_SWAP,
      ({ state, decoded, pool }) => {
        updateV3SwapState(state, decoded, pool);
        return true;
      },
    ],
    [
      TOPIC0.V3_MINT,
      ({ addr, log, state, decoded, pool, enqueueEnrichment, refreshV3 }) => {
        if (!hasInitializedV3BaseState(state)) {
          enqueueEnrichment(addr, () => refreshV3(addr, pool, log));
          return false;
        }
        updateV3LiquidityState(state, decoded, true, pool);
        return true;
      },
    ],
    [
      TOPIC0.V3_BURN,
      ({ addr, log, state, decoded, pool, enqueueEnrichment, refreshV3 }) => {
        if (!hasInitializedV3BaseState(state)) {
          enqueueEnrichment(addr, () => refreshV3(addr, pool, log));
          return false;
        }
        updateV3LiquidityState(state, decoded, false, pool);
        return true;
      },
    ],
    [
      TOPIC0.BAL_BALANCE,
      ({ addr, pool, enqueueEnrichment, refreshBalancer }) => {
        enqueueEnrichment(addr, () => refreshBalancer(addr, pool));
        return false;
      },
    ],
    [
      TOPIC0.CURVE_EXCHANGE_STABLE,
      ({ addr, pool, enqueueEnrichment, refreshCurve }) => {
        enqueueEnrichment(addr, () => refreshCurve(addr, pool));
        return false;
      },
    ],
    [
      TOPIC0.CURVE_EXCHANGE_UNDERLYING,
      ({ addr, pool, enqueueEnrichment, refreshCurve }) => {
        enqueueEnrichment(addr, () => refreshCurve(addr, pool));
        return false;
      },
    ],
    [
      TOPIC0.CURVE_EXCHANGE_CRYPTO,
      ({ addr, pool, enqueueEnrichment, refreshCurve }) => {
        enqueueEnrichment(addr, () => refreshCurve(addr, pool));
        return false;
      },
    ],
    [
      TOPIC0.DODO_SWAP,
      ({ addr, pool, enqueueEnrichment, refreshDodo }) => {
        enqueueEnrichment(addr, () => refreshDodo(addr, pool));
        return false;
      },
    ],
    [
      TOPIC0.WOOFI_SWAP,
      ({ addr, pool, enqueueEnrichment, refreshWoofi }) => {
        enqueueEnrichment(addr, () => refreshWoofi(addr, pool));
        return false;
      },
    ],
  ]);
}

let _handlerMap: Map<string, LogHandler> | null = null;

function getHandlerMap(): Map<string, LogHandler> {
  if (!_handlerMap) {
    _handlerMap = buildHandlerMap();
  }
  return _handlerMap;
}

export function getHandler(topic0: string): LogHandler | undefined {
  return getHandlerMap().get(topic0);
}

export function dispatchLog(
  log: HyperSyncRawLog,
  decoded: DecodedWatcherLog,
  pool: WatcherPoolMeta | null,
  state: MutableWatcherState,
  deps: {
    addr: string;
    enqueueEnrichment: WatcherEnqueueEnrichment;
    refreshBalancer: WatcherPoolRefresh;
    refreshCurve: WatcherPoolRefresh;
    refreshDodo: WatcherPoolRefresh;
    refreshWoofi: WatcherPoolRefresh;
    refreshV3: WatcherV3Refresh;
  },
): boolean {
  const topics = topicArrayFromHyperSyncLog(log);
  if (topics.length === 0) return false;
  const handler = getHandler(topics[0]);
  if (!handler) return false;
  return handler({
    addr: deps.addr,
    log,
    pool,
    state,
    decoded,
    enqueueEnrichment: deps.enqueueEnrichment,
    refreshBalancer: deps.refreshBalancer,
    refreshCurve: deps.refreshCurve,
    refreshDodo: deps.refreshDodo,
    refreshWoofi: deps.refreshWoofi,
    refreshV3: deps.refreshV3,
  });
}
