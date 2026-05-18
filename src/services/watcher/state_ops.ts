import { JoinMode, LogField } from "../../hypersync/client.ts";
import { buildHyperSyncLogQuery, DEFAULT_HYPERSYNC_BLOCK_FIELDS, type HyperSyncLogQuery } from "../../hypersync/query_policy.ts";
import type { HyperSyncGetResponse } from "../../hypersync/client.ts";
import { topicArrayFromHyperSyncLog, type HyperSyncRawLog } from "../../hypersync/logs.ts";
import { parsePoolMetadataValue } from "../../utils/pool_record.ts";
import { resolveV2FeeDenominator, resolveV2FeeNumerator, resolveV3Fee, validatePoolState } from "../../state/normalizer.ts";
import { mergeStateIntoCache } from "../../state/cache_utils.ts";
import type { RouteStateCache } from "../../routing/simulation_types.ts";
import type {
  DecodedWatcherLog,
  MutableWatcherState,
  V3WatcherTickState,
  WatcherPoolMeta,
  WatcherPersistedStateUpdate,
  WatcherStateUpdate,
} from "../../state/watcher_types.ts";

function decodedValue(decoded: DecodedWatcherLog, section: "indexed" | "body", index: number) {
  return decoded[section]?.[index]?.val;
}

function decodedBigInt(decoded: DecodedWatcherLog, section: "indexed" | "body", index: number): bigint {
  const value = decodedValue(decoded, section, index);
  if (value == null) return 0n;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return BigInt(value);
  }
  return 0n;
}

function isTickRecord(value: unknown): value is Partial<V3WatcherTickState> {
  return value != null && typeof value === "object";
}

function toTickBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return 0n;
}

function tickEntriesFrom(value: unknown): Array<[unknown, unknown]> {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) return [entry[0], entry[1]] as [unknown, unknown];
        if (isTickRecord(entry) && ("tick" in entry || "index" in entry)) {
          const record = entry as Record<string, unknown>;
          return [record.tick ?? record.index, entry] as [unknown, unknown];
        }
        return null;
      })
      .filter((entry): entry is [unknown, unknown] => entry != null);
  }
  if (typeof value === "object") return Object.entries(value);
  return [];
}

export function normalizeWatcherTicks(ticks: unknown): Map<number, V3WatcherTickState> {
  if (ticks instanceof Map) return ticks;
  const normalized = new Map<number, V3WatcherTickState>();
  for (const [tick, data] of tickEntriesFrom(ticks)) {
    if (!isTickRecord(data)) continue;
    const tickNumber = Number(tick);
    if (!Number.isInteger(tickNumber)) continue;
    normalized.set(tickNumber, {
      liquidityGross: toTickBigInt(data.liquidityGross),
      liquidityNet: toTickBigInt(data.liquidityNet),
    });
  }
  return normalized;
}

function ensureV3Fee(state: MutableWatcherState, pool: WatcherPoolMeta | null = null) {
  const currentFee = typeof state.fee === "bigint" ? state.fee : null;
  if (currentFee != null && currentFee >= 0n) return;
  const metadata = parsePoolMetadataValue(pool?.metadata);
  state.fee = resolveV3Fee(metadata);
  state.feeSource = metadata?.fee != null ? "metadata" : "default";
}

export function updateV2State(state: MutableWatcherState, decoded: DecodedWatcherLog, pool: WatcherPoolMeta | null = null) {
  state.reserve0 = decodedBigInt(decoded, "body", 0);
  state.reserve1 = decodedBigInt(decoded, "body", 1);
  const metadata = parsePoolMetadataValue(pool?.metadata);
  const currentFee = typeof state.fee === "bigint" ? state.fee : null;
  const currentFeeDenominator = typeof state.feeDenominator === "bigint" ? state.feeDenominator : null;
  if (
    currentFee == null ||
    currentFeeDenominator == null ||
    currentFeeDenominator <= 0n ||
    currentFee <= 0n ||
    currentFee >= currentFeeDenominator
  ) {
    const feeDenominator = resolveV2FeeDenominator(metadata);
    state.fee = resolveV2FeeNumerator(metadata, 997n, feeDenominator);
    state.feeDenominator = feeDenominator;
    state.feeSource = metadata?.feeNumerator != null || metadata?.fee != null ? "metadata" : "default";
  }
}

export function updateV3SwapState(state: MutableWatcherState, decoded: DecodedWatcherLog, pool: WatcherPoolMeta | null = null) {
  state.sqrtPriceX96 = decodedBigInt(decoded, "body", 2);
  state.liquidity = decodedBigInt(decoded, "body", 3);
  state.tick = Number(decodedValue(decoded, "body", 4));
  state.initialized = true;
  ensureV3Fee(state, pool);
}

export function updateTickState(state: MutableWatcherState, tick: number, liquidityGrossDelta: bigint, liquidityNetDelta: bigint) {
  state.ticks = normalizeWatcherTicks(state.ticks);
  const data = state.ticks.get(tick) ?? { liquidityGross: 0n, liquidityNet: 0n };
  data.liquidityGross += liquidityGrossDelta;
  data.liquidityNet += liquidityNetDelta;
  if (data.liquidityGross === 0n) state.ticks.delete(tick);
  else state.ticks.set(tick, data);
  state.tickVersion = Number.isFinite(Number(state.tickVersion)) ? Number(state.tickVersion) + 1 : 1;
}

export function updateV3LiquidityState(
  state: MutableWatcherState,
  decoded: DecodedWatcherLog,
  isMint: boolean,
  pool: WatcherPoolMeta | null = null,
) {
  ensureV3Fee(state, pool);
  const tickLower = Number(decodedValue(decoded, "indexed", 1));
  const tickUpper = Number(decodedValue(decoded, "indexed", 2));
  const amount = decodedBigInt(decoded, "body", isMint ? 1 : 0);
  if (state.tick != null && state.tick >= tickLower && state.tick < tickUpper) {
    const currentLiquidity = toTickBigInt(state.liquidity);
    if (isMint) state.liquidity = currentLiquidity + amount;
    else state.liquidity = currentLiquidity >= amount ? currentLiquidity - amount : 0n;
  }
  const liquidityGrossDelta = isMint ? amount : -amount;
  updateTickState(state, tickLower, liquidityGrossDelta, isMint ? amount : -amount);
  updateTickState(state, tickUpper, liquidityGrossDelta, isMint ? -amount : amount);
}

export function mergeWatcherState(cache: RouteStateCache, addr: string, nextState: MutableWatcherState): MutableWatcherState {
  return mergeStateIntoCache(cache, addr, nextState) as MutableWatcherState;
}

export type WatcherStateIntegrityError = Error & {
  poolAddress: string;
  validationReason: string;
  blockNumber?: number;
  transactionHash?: string;
  topic0?: string | null;
};

function toTopicArray(log: HyperSyncRawLog) {
  return topicArrayFromHyperSyncLog(log);
}

function watcherStateIntegrityError(reason: string, context: { addr?: unknown; poolAddress?: unknown; rawLog?: HyperSyncRawLog | null } = {}): WatcherStateIntegrityError {
  const addr = String(context?.addr ?? context?.poolAddress ?? "unknown").toLowerCase();
  const err = new Error(`watcher state integrity failed for ${addr}: ${reason}`) as WatcherStateIntegrityError;
  err.name = "WatcherStateIntegrityError";
  err.poolAddress = addr;
  err.validationReason = reason;
  if (context?.rawLog?.blockNumber != null) err.blockNumber = Number(context.rawLog.blockNumber);
  if (context?.rawLog?.transactionHash != null) err.transactionHash = String(context.rawLog.transactionHash);
  if (context?.rawLog != null) err.topic0 = toTopicArray(context.rawLog)[0] ?? null;
  return err;
}

function validateWatcherStateOrThrow(state: MutableWatcherState, context: { addr?: unknown; rawLog?: HyperSyncRawLog | null } = {}) {
  const verdict = validatePoolState(state);
  if (!verdict.valid) {
    throw watcherStateIntegrityError(verdict.reason ?? "invalid watcher state", context);
  }
  if (typeof state.protocol === "string" && state.protocol.includes("V3")) {
    if (state.liquidity == null || state.liquidity < 0n) {
      throw watcherStateIntegrityError("V3: negative liquidity", context);
    }
    if (state.ticks instanceof Map) {
      for (const [tick, data] of state.ticks.entries()) {
        if (data.liquidityGross < 0n) {
          throw watcherStateIntegrityError(`V3: negative liquidityGross at tick ${tick}`, context);
        }
      }
    }
  }
}

export function commitWatcherStatesBatch(
  cache: RouteStateCache,
  persistStates: (states: WatcherPersistedStateUpdate[]) => unknown,
  updates: WatcherStateUpdate[],
) {
  if (!Array.isArray(updates) || updates.length === 0) return [];
  const committed: WatcherPersistedStateUpdate[] = [];
  const nextStates = new Map<string, MutableWatcherState>();
  const committedAt = Date.now();
  for (const update of updates) {
    const addr = update.addr.toLowerCase();
    const state = update?.state;
    if (!addr || !state) continue;
    if (typeof state.timestamp !== "number" || !Number.isFinite(state.timestamp) || state.timestamp <= 0) {
      state.timestamp = committedAt;
    }
    validateWatcherStateOrThrow(state, { addr, rawLog: update?.rawLog });
    committed.push({
      pool_address: addr,
      block: Number(update?.rawLog?.blockNumber ?? 0),
      data: state,
    });
    nextStates.set(addr, state);
  }
  if (committed.length > 0) {
    persistStates(committed);
  }
  for (const [addr, state] of nextStates.entries()) {
    mergeStateIntoCache(cache, addr, state);
  }
  return [...nextStates.keys()];
}

export function buildLogQuery(fromBlock: number, addresses: string[]): HyperSyncLogQuery {
  return buildHyperSyncLogQuery({
    fromBlock,
    logs: [{ address: addresses }],
    maxNumLogs: 5000,
    maxNumBlocks: 1_000_000,
    joinMode: JoinMode.JoinNothing,
    logFields: [
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
    ],
    blockFields: DEFAULT_HYPERSYNC_BLOCK_FIELDS,
  });
}
