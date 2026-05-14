/**
 * src/state/uniswap_v3.ts — Uniswap V3 / Algebra pool state fetcher
 *
 * Fetches the full on-chain state needed for deterministic swap simulation:
 *   - slot0 / globalState (sqrtPriceX96, tick)
 *   - liquidity (global L)
 *   - tickBitmap (to discover initialized ticks)
 *   - tick data (liquidityNet for each initialized tick)
 *
 * Supports both:
 *   - Uniswap V3 forks (Uniswap V3, SushiSwap V3) — use slot0() + fee()
 *   - Algebra forks (QuickSwap V3) — use globalState() which bundles price,
 *     tick, and the current dynamic fee in a single call
 *
 * Uses viem multicall for batched RPC calls with retry/backoff.
 */

import { chunk } from "../utils/concurrency.ts";
import { isNoDataReadContractError, multicallWithRetry, readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { ENRICH_CONCURRENCY, V3_BITMAP_MULTICALL_CHUNK_SIZE, V3_TICKS_MULTICALL_CHUNK_SIZE } from "../config/index.ts";
import { isEndpointCapabilityError } from "../utils/rpc_manager.ts";
import { errorMessage } from "../utils/errors.ts";
import { fetchV3PoolCoreSnapshots, type StateReadBlockTag } from "./state_multicall_hydrator.ts";

// ─── ABI fragments ───────────────────────────────────────────

/** Algebra Protocol (QuickSwap V3) globalState() ABI.
 *
 * Combines slot0 + fee into one call. Dynamic fee is stored in the pool
 * and may change per-block via the fee manager.
 *
 * Returns:
 *   [0] sqrtPriceX96   uint160 — current sqrt price (same semantics as Uniswap V3)
 *   [1] tick           int24   — current tick
 *   [2] fee            uint16  — current dynamic fee in hundredths of a bip
 *   [3] timepointIndex uint16  — index of the most recent timepoint
 *   [4] communityFeeToken0  uint8
 *   [5] communityFeeToken1  uint8
 *   [6] unlocked       bool
 */
const KYBER_POOL_STATE_ABI = [
  {
    name: "getPoolState",
    type: "function",
    inputs: [],
    outputs: [
      { name: "sqrtP", type: "uint160" },
      { name: "currentTick", type: "int24" },
      { name: "nearestCurrentTick", type: "int24" },
      { name: "locked", type: "bool" },
    ],
    stateMutability: "view",
  },
];

const KYBER_LIQUIDITY_STATE_ABI = [
  {
    name: "getLiquidityState",
    type: "function",
    inputs: [],
    outputs: [
      { name: "baseL", type: "uint128" },
      { name: "reinvestL", type: "uint128" },
      { name: "reinvestLLast", type: "uint128" },
    ],
    stateMutability: "view",
  },
];

const KYBER_SWAP_FEE_UNITS_ABI = [
  {
    name: "swapFeeUnits",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
  },
];

const KYBER_TICK_DISTANCE_ABI = [
  {
    name: "tickDistance",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
    stateMutability: "view",
  },
];

const TICK_BITMAP_ABI = [
  {
    name: "tickBitmap",
    type: "function",
    inputs: [{ name: "wordPosition", type: "int16" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
];

const KYBER_INITIALIZED_TICKS_ABI = [
  {
    name: "initializedTicks",
    type: "function",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "previous", type: "int24" },
      { name: "next", type: "int24" },
    ],
    stateMutability: "view",
  },
];

const TICKS_ABI = [
  {
    name: "ticks",
    type: "function",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
    stateMutability: "view",
  },
];

const KYBER_TICKS_ABI = [
  {
    name: "ticks",
    type: "function",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside", type: "uint256" },
      { name: "secondsPerLiquidityOutside", type: "uint128" },
    ],
    stateMutability: "view",
  },
];

// ─── Constants ────────────────────────────────────────────────

const MIN_TICK = -887272;
const MAX_TICK = 887272;

type PoolCoreState = {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  fee: number;
  tickSpacing: number;
  swapFeeBps?: number;
  nearestCurrentTick?: number;
};

type TickLiquidity = {
  liquidityGross: bigint;
  liquidityNet: bigint;
};

type V3TupleResult = readonly unknown[];

type TickBitmapResult = {
  bitmaps: Map<number, bigint>;
  tickIndices: number[];
};

type V3MulticallResult = {
  status?: unknown;
  result?: unknown;
  error?: unknown;
};

type V3FetchResult = { addr: string; state: V3PoolState; error: null } | { addr: string; state: null; error: unknown };

function toV3BigInt(value: unknown) {
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`invalid V3 bigint value: ${String(value)}`);
}

export type V3PoolState = PoolCoreState & {
  address: string;
  bitmaps: Map<number, bigint>;
  ticks: Map<number, TickLiquidity>;
  fetchedAt: number;
  initialized: boolean;
  isAlgebra: boolean;
  isKyberElastic: boolean;
  hydrationMode: V3HydrationMode;
};

export type V3PoolMeta = {
  isAlgebra?: boolean;
  isKyberElastic?: boolean;
  swapFeeBps?: number | string | bigint | null;
  swapFeeUnits?: number | string | bigint | null;
};

export type V3HydrationMode = "full" | "nearby" | "none";

export type V3FetchOptions = {
  hydrationMode?: V3HydrationMode;
  nearWordRadius?: number;
  blockTag?: StateReadBlockTag;
};

export type V3StateMap = Map<string, V3PoolState> & {
  noDataFailures?: Set<string>;
};

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Determine the range of word positions that cover all possible ticks.
 */
function wordRange(tickSpacing: number): { minWord: number; maxWord: number } {
  const minWord = Math.floor(Math.floor(MIN_TICK / tickSpacing) / 256);
  const maxWord = Math.floor(Math.floor(MAX_TICK / tickSpacing) / 256);
  return { minWord, maxWord };
}

/**
 * Extract initialized tick indices from a bitmap word.
 *
 * @param {bigint} word       The 256-bit bitmap word
 * @param {number} wordPos    The word position index
 * @param {number} tickSpacing The pool's tick spacing
 * @returns {number[]}        Array of initialized tick values
 */
function extractTicksFromWord(word: bigint, wordPos: number, tickSpacing: number): number[] {
  const ticks: number[] = [];
  if (word === 0n) return ticks;

  for (let bit = 0; bit < 256; bit++) {
    if ((word >> BigInt(bit)) & 1n) {
      const compressed = wordPos * 256 + bit;
      ticks.push(compressed * tickSpacing);
    }
  }
  return ticks;
}

function normalizeOptionalSwapFeeBps(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0 || n > 10_000) return null;
  return n;
}

// ─── Core State Fetcher ───────────────────────────────────────

/**
 * Fetch the core state for a single V3 pool.
 *
 * For standard Uniswap V3 forks (Uniswap V3, SushiSwap V3):
 *   calls slot0() + liquidity() + fee() + tickSpacing() (4 RPC calls)
 *
 * For Algebra forks (QuickSwap V3):
 *   calls globalState() + liquidity() + tickSpacing() (3 RPC calls —
 *   globalState already bundles price, tick, and the current dynamic fee)
 *
 * @param {string}  poolAddress     Checksummed pool address
 * @param {Object}  [options]
 * @param {boolean} [options.isAlgebra=false]  Use Algebra globalState() instead of slot0()
 * @returns {{ sqrtPriceX96: bigint, tick: number, liquidity: bigint, fee: number, tickSpacing: number }}
 */
export async function fetchPoolCore(
  poolAddress: string,
  { isAlgebra = false, isKyberElastic = false, swapFeeBps, swapFeeUnits }: V3PoolMeta = {},
  options: { blockTag?: StateReadBlockTag } = {},
): Promise<PoolCoreState> {
  if (isKyberElastic) {
    const providedSwapFeeBps = normalizeOptionalSwapFeeBps(swapFeeBps) ?? normalizeOptionalSwapFeeBps(swapFeeUnits);
    const [poolStateResult, liquidityStateResult, tickDistanceResult] = await Promise.all([
      readContractWithRetry<V3TupleResult>({
        address: poolAddress,
        abi: KYBER_POOL_STATE_ABI,
        functionName: "getPoolState",
        blockTag: options.blockTag,
      }),
      readContractWithRetry<V3TupleResult>({
        address: poolAddress,
        abi: KYBER_LIQUIDITY_STATE_ABI,
        functionName: "getLiquidityState",
        blockTag: options.blockTag,
      }),
      readContractWithRetry({
        address: poolAddress,
        abi: KYBER_TICK_DISTANCE_ABI,
        functionName: "tickDistance",
        blockTag: options.blockTag,
      }),
    ]);
    const swapFeeBpsResult =
      providedSwapFeeBps ??
      (await readContractWithRetry({
        address: poolAddress,
        abi: KYBER_SWAP_FEE_UNITS_ABI,
        functionName: "swapFeeUnits",
        blockTag: options.blockTag,
      }));

    const baseLiquidity = toV3BigInt(liquidityStateResult[0]);
    const reinvestLiquidity = toV3BigInt(liquidityStateResult[1]);
    const normalizedSwapFeeBps = Number(swapFeeBpsResult);

    return {
      sqrtPriceX96: toV3BigInt(poolStateResult[0]),
      tick: Number(poolStateResult[1]),
      liquidity: baseLiquidity + reinvestLiquidity,
      fee: normalizedSwapFeeBps * 100,
      swapFeeBps: normalizedSwapFeeBps,
      tickSpacing: Number(tickDistanceResult),
      nearestCurrentTick: Number(poolStateResult[2]),
    };
  }

  if (isAlgebra) {
    const snapshots = await fetchV3PoolCoreSnapshots([{ address: poolAddress, isAlgebra: true }], { blockTag: options.blockTag });
    const core = snapshots.get(poolAddress.toLowerCase());
    if (!core) throw new Error(`V3 core multicall returned no data for ${poolAddress}`);
    return core;
  }

  const snapshots = await fetchV3PoolCoreSnapshots([{ address: poolAddress, isAlgebra: false }], { blockTag: options.blockTag });
  const core = snapshots.get(poolAddress.toLowerCase());
  if (!core) throw new Error(`V3 core multicall returned no data for ${poolAddress}`);
  return core;
}

/**
 * Fetch the tick bitmap for a pool, returning all initialized tick indices.
 *
 * Strategy: Fetch all 256-bit words in the valid tick range, extract set bits.
 * Uses throttledMap to avoid RPC rate limits.
 *
 * @param {string} poolAddress  Pool address
 * @param {number} tickSpacing  Pool tick spacing
 * @returns {Promise<{ bitmaps: Map<number, bigint>, tickIndices: number[] }>}
 */
export async function fetchTickBitmap(poolAddress: string, tickSpacing: number): Promise<TickBitmapResult> {
  const { minWord, maxWord } = wordRange(tickSpacing);
  return fetchTickBitmapWordRange(poolAddress, tickSpacing, minWord, maxWord);
}

async function fetchTickBitmapWordRange(
  poolAddress: string,
  tickSpacing: number,
  minWord: number,
  maxWord: number,
): Promise<TickBitmapResult> {
  const wordPositions: number[] = [];
  for (let w = minWord; w <= maxWord; w++) {
    wordPositions.push(w);
  }

  const bitmaps = new Map<number, bigint>();
  const tickIndices: number[] = [];
  const wordChunkSize = Math.max(1, Math.floor(V3_BITMAP_MULTICALL_CHUNK_SIZE));
  const wordChunks = chunk(wordPositions, wordChunkSize);

  await throttledMap(
    wordChunks,
    async (wordChunk: number[]) => {
      const contracts = wordChunk.map((wordPos) => ({
        address: poolAddress,
        abi: TICK_BITMAP_ABI,
        functionName: "tickBitmap",
        args: [wordPos],
      }));

      let results: V3MulticallResult[];
      try {
        results = (await multicallWithRetry({
          contracts,
          allowFailure: true,
        })) as V3MulticallResult[];
      } catch (error) {
        // Fall back only when multicall is unsupported. Retrying a rate-limit or
        // transport failure as per-word reads multiplies RPC load during warmup.
        if (!shouldFallbackToIndividualV3Reads(error)) throw error;
        results = await Promise.all(
          wordChunk.map(async (wordPos) => {
            try {
              const result = await readContractWithRetry({
                address: poolAddress,
                abi: TICK_BITMAP_ABI,
                functionName: "tickBitmap",
                args: [wordPos],
              });
              return { status: "success", result };
            } catch {
              return { status: "failure", result: 0n };
            }
          }),
        );
      }

      for (let i = 0; i < wordChunk.length; i++) {
        const wordPos = wordChunk[i];
        const result = results[i];
        if (!result || result.status !== "success") continue;
        const word = toV3BigInt(result.result);
        if (word === 0n) continue;
        bitmaps.set(wordPos, word);
        tickIndices.push(...extractTicksFromWord(word, wordPos, tickSpacing));
      }
    },
    ENRICH_CONCURRENCY,
  );

  return { bitmaps, tickIndices: tickIndices.sort((a, b) => a - b) };
}

export async function fetchTickBitmapWindow(
  poolAddress: string,
  tickSpacing: number,
  centerTick: number,
  wordRadius: number,
): Promise<TickBitmapResult> {
  const { minWord, maxWord } = wordRange(tickSpacing);
  const activeWord = Math.floor(Math.floor(centerTick / tickSpacing) / 256);
  const clampedMinWord = Math.max(minWord, activeWord - Math.max(0, wordRadius));
  const clampedMaxWord = Math.min(maxWord, activeWord + Math.max(0, wordRadius));
  return fetchTickBitmapWordRange(poolAddress, tickSpacing, clampedMinWord, clampedMaxWord);
}

/**
 * Fetch liquidityNet for a batch of initialized ticks.
 *
 * @param {string} poolAddress     Pool address
 * @param {number[]} tickIndices   Array of initialized tick values
 * @returns {Map<number, { liquidityGross: bigint, liquidityNet: bigint }>}
 */
export async function fetchTickData(poolAddress: string, tickIndices: number[]): Promise<Map<number, TickLiquidity>> {
  const tickMap = new Map<number, TickLiquidity>();

  if (tickIndices.length === 0) return tickMap;
  const tickChunkSize = Math.max(1, Math.floor(V3_TICKS_MULTICALL_CHUNK_SIZE));
  const tickChunks = chunk(tickIndices, tickChunkSize);

  await throttledMap(
    tickChunks,
    async (tickChunk: number[]) => {
      const contracts = tickChunk.map((tick) => ({
        address: poolAddress,
        abi: TICKS_ABI,
        functionName: "ticks",
        args: [tick],
      }));

      let results: V3MulticallResult[];
      try {
        results = (await multicallWithRetry({
          contracts,
          allowFailure: true,
        })) as V3MulticallResult[];
      } catch (error) {
        // Preserve existing behavior only if multicall cannot be used.
        if (!shouldFallbackToIndividualV3Reads(error)) throw error;
        results = await Promise.all(
          tickChunk.map(async (tick) => {
            try {
              const result = await readContractWithRetry({
                address: poolAddress,
                abi: TICKS_ABI,
                functionName: "ticks",
                args: [tick],
              });
              return { status: "success", result };
            } catch {
              return { status: "failure" };
            }
          }),
        );
      }

      for (let i = 0; i < tickChunk.length; i++) {
        const tick = tickChunk[i];
        const result = results[i];
        if (!result || result.status !== "success") continue;
        const decoded = result.result;
        if (!Array.isArray(decoded)) continue;
        const liquidityGross = toV3BigInt(decoded[0]);
        if (!decoded[7] || liquidityGross <= 0n) continue;
        tickMap.set(tick, {
          liquidityGross,
          liquidityNet: toV3BigInt(decoded[1]),
        });
      }
    },
    ENRICH_CONCURRENCY,
  );

  return tickMap;
}

async function fetchKyberTickData(poolAddress: string, tickIndices: number[]) {
  const uniqueTicks = [...new Set(tickIndices)].filter((tick) => Number.isSafeInteger(tick)).sort((a, b) => a - b);
  const tickMap = new Map<number, TickLiquidity>();
  if (uniqueTicks.length === 0) return tickMap;

  await throttledMap(
    uniqueTicks,
    async (tick) => {
      try {
        const decoded = await readContractWithRetry<V3TupleResult>({
          address: poolAddress,
          abi: KYBER_TICKS_ABI,
          functionName: "ticks",
          args: [tick],
        });
        const liquidityGross = toV3BigInt(decoded[0]);
        if (liquidityGross <= 0n) return;
        tickMap.set(tick, {
          liquidityGross,
          liquidityNet: toV3BigInt(decoded[1]),
        });
      } catch {
        // A sparse or removed Kyber tick should not poison the whole pool.
      }
    },
    ENRICH_CONCURRENCY,
  );

  return tickMap;
}

async function fetchKyberInitializedTickWindow(poolAddress: string, centerTick: number, tickRadius: number) {
  const radius = Math.max(0, Math.min(Math.trunc(Number(tickRadius) || 0), 64));
  const tickSet = new Set<number>();
  if (Number.isSafeInteger(centerTick)) tickSet.add(centerTick);

  async function neighborTicks(tick: number) {
    const decoded = await readContractWithRetry<V3TupleResult>({
      address: poolAddress,
      abi: KYBER_INITIALIZED_TICKS_ABI,
      functionName: "initializedTicks",
      args: [tick],
    });
    return {
      previous: Number(decoded[0]),
      next: Number(decoded[1]),
    };
  }

  let left = centerTick;
  for (let i = 0; i < radius && Number.isSafeInteger(left); i++) {
    try {
      const { previous } = await neighborTicks(left);
      if (!Number.isSafeInteger(previous) || previous === left || tickSet.has(previous)) break;
      tickSet.add(previous);
      left = previous;
    } catch {
      break;
    }
  }

  let right = centerTick;
  for (let i = 0; i < radius && Number.isSafeInteger(right); i++) {
    try {
      const { next } = await neighborTicks(right);
      if (!Number.isSafeInteger(next) || next === right || tickSet.has(next)) break;
      tickSet.add(next);
      right = next;
    } catch {
      break;
    }
  }

  const tickIndices = [...tickSet].sort((a, b) => a - b);
  return {
    bitmaps: new Map<number, bigint>(),
    tickIndices,
    ticks: await fetchKyberTickData(poolAddress, tickIndices),
  };
}

function shouldFallbackToIndividualV3Reads(error: unknown): boolean {
  return isEndpointCapabilityError(error);
}

/**
 * Fetch complete V3 pool state for swap simulation.
 *
 * Returns an immutable state snapshot containing everything needed
 * for deterministic off-chain swap simulation.
 *
 * @param {string}  poolAddress        Checksummed pool address
 * @param {Object}  [options]
 * @param {boolean} [options.isAlgebra=false]  Use Algebra globalState() interface
 * @returns {Promise<Object>}
 */
export async function fetchV3PoolState(
  poolAddress: string,
  {
    isAlgebra = false,
    isKyberElastic = false,
    swapFeeBps,
    swapFeeUnits,
    hydrationMode = "full",
    nearWordRadius = 2,
    blockTag,
  }: V3PoolMeta & V3FetchOptions = {},
): Promise<V3PoolState> {
  // Step 1: Core state (dispatches to Algebra or Uniswap V3 interface)
  const useAlgebraInterface = isAlgebra === true;
  const core = await fetchPoolCore(
    poolAddress,
    {
      isAlgebra: useAlgebraInterface,
      isKyberElastic,
      swapFeeBps,
      swapFeeUnits,
    },
    {
      blockTag,
    },
  );

  // Skip pools that are uninitialized (sqrtPriceX96 == 0)
  if (core.sqrtPriceX96 === 0n) {
    return {
      address: poolAddress,
      ...core,
      bitmaps: new Map(),
      ticks: new Map(),
      fetchedAt: Date.now(),
      initialized: false,
      isAlgebra: useAlgebraInterface,
      isKyberElastic,
      hydrationMode,
    };
  }

  let bitmaps = new Map<number, bigint>();
  let tickIndices: number[] = [];
  let ticks = new Map<number, TickLiquidity>();
  if (isKyberElastic && hydrationMode !== "none") {
    const tickWindow = await fetchKyberInitializedTickWindow(poolAddress, core.nearestCurrentTick ?? core.tick, nearWordRadius);
    bitmaps = tickWindow.bitmaps;
    tickIndices = tickWindow.tickIndices;
    ticks = tickWindow.ticks;
  } else {
    if (hydrationMode === "full") {
      ({ bitmaps, tickIndices } = await fetchTickBitmap(poolAddress, core.tickSpacing));
    } else if (hydrationMode === "nearby") {
      ({ bitmaps, tickIndices } = await fetchTickBitmapWindow(poolAddress, core.tickSpacing, core.tick, nearWordRadius));
    }

    // Algebra ticks() returns the same types as Uniswap V3, so TICKS_ABI is
    // compatible with both.
    ticks = await fetchTickData(poolAddress, tickIndices);
  }

  return {
    address: poolAddress,
    ...core,
    bitmaps,
    ticks,
    fetchedAt: Date.now(),
    initialized: true,
    isAlgebra: useAlgebraInterface,
    isKyberElastic,
    hydrationMode,
  };
}

/**
 * Fetch state for multiple V3 pools in parallel with concurrency control.
 *
 * @param {string[]} poolAddresses   Array of pool addresses
 * @param {number}   [concurrency=2] Max parallel pool fetches
 * @param {Map<string, { isAlgebra?: boolean }>} [poolMeta]
 *   Per-pool options keyed by lowercase address. Pass `{ isAlgebra: true }`
 *   for Algebra-based pools (QuickSwap V3) so the right state interface is used.
 * @returns {Promise<Map<string, Object>>}
 */
export async function fetchMultipleV3States(
  poolAddresses: string[],
  concurrency = 2,
  poolMeta: Map<string, V3PoolMeta> = new Map(),
  onProgress: ((completed: number, total: number, addr: string, state: V3PoolState | null) => void) | null = null,
  fetchOptions: V3FetchOptions = {},
): Promise<V3StateMap> {
  const states: V3StateMap = new Map();
  const noDataFailures = new Set<string>();
  let completed = 0;
  const total = poolAddresses.length;

  const results = await throttledMap(
    poolAddresses,
    async (addr: string): Promise<V3FetchResult> => {
      let fetchedState: V3PoolState | null = null;
      try {
        const meta = poolMeta.get(addr.toLowerCase()) || {};
        const state = await fetchV3PoolState(addr, {
          isAlgebra: meta.isAlgebra || false,
          isKyberElastic: meta.isKyberElastic || false,
          swapFeeBps: meta.swapFeeBps,
          swapFeeUnits: meta.swapFeeUnits,
          hydrationMode: fetchOptions.hydrationMode,
          nearWordRadius: fetchOptions.nearWordRadius,
        });
        fetchedState = state;
        return { addr, state, error: null };
      } catch (error) {
        if (isNoDataReadContractError(error)) {
          noDataFailures.add(addr.toLowerCase());
        }
        console.warn(`  Failed to fetch state for ${addr}: ${errorMessage(error)}`);
        return { addr, state: null, error };
      } finally {
        completed++;
        if (onProgress) {
          try {
            onProgress(completed, total, addr, fetchedState);
          } catch {
            // progress callbacks must never break state fetches
          }
        }
      }
    },
    concurrency,
  );

  for (const { addr, state } of results) {
    if (state) {
      states.set(addr.toLowerCase(), state);
    }
  }

  states.noDataFailures = noDataFailures;
  return states;
}
