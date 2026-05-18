/**
 * src/math/uniswap_v3.js — Optimized Uniswap V3 swap simulator
 *
 * Deterministic off-chain simulation of a V3 swap.
 * Optimized for high-frequency trading (HFT) performance:
 *   - Pre-sorts and caches initialized ticks to avoid O(N log N) sorts in hot path.
 *   - Uses binary search (O(log N)) to find the next initialized tick.
 *
 * This module is a pure function — it takes a pool state snapshot
 * and returns the swap result without side effects.
 */

import { getSqrtRatioAtTick, getTickAtSqrtRatioInRange, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "./tick_math.ts";
import { computeSwapStep } from "./swap_math.ts";
import { toBigIntOrNull } from "../utils/bigint.ts";

// ─── Optimized Tick Navigation ──────────────────────────────────

type V3PoolStateLike = Record<string, unknown>;
type V3TickData = Record<string, unknown>;

const sortedTicksCache = new Map<
  string,
  {
    tickVersion: number;
    ticksRef: Map<unknown, unknown>;
    sortedTicks: number[];
  }
>();

function asPoolState(value: unknown): V3PoolStateLike {
  return value != null && typeof value === "object" ? (value as V3PoolStateLike) : {};
}

function asTickData(value: unknown): V3TickData | null {
  return value != null && typeof value === "object" ? (value as V3TickData) : null;
}

function poolCacheKey(pool: V3PoolStateLike) {
  if (typeof pool.poolId === "string" && pool.poolId) return pool.poolId;
  const addr = typeof pool.address === "string" ? pool.address.toLowerCase() : "";
  if (addr) return addr;
  return String(pool.pool_address ?? "");
}

/**
 * Find the next initialized tick in the swap direction using binary search.
 *
 * @param {number[]} sortedTicks  Pre-sorted array of initialized tick indices
 * @param {number}   currentTick  Current pool tick
 * @param {boolean}  zeroForOne   Direction (true = decreasing, false = increasing)
 * @returns {number|null}
 */
function nextInitializedTickOptimized(sortedTicks: readonly number[], currentTick: number, zeroForOne: boolean) {
  if (sortedTicks.length === 0) return null;

  let low = 0;
  let high = sortedTicks.length - 1;
  let result: number | null = null;

  if (zeroForOne) {
    // Price decreasing: find largest tick <= currentTick
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (sortedTicks[mid] <= currentTick) {
        result = sortedTicks[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  } else {
    // Price increasing: find smallest tick > currentTick
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (sortedTicks[mid] > currentTick) {
        result = sortedTicks[mid];
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  return result;
}

function getSortedTicks(state: V3PoolStateLike) {
  const ticks = state.ticks;
  if (!(ticks instanceof Map) || ticks.size === 0) return [];

  const tickVersion = Number.isFinite(Number(state?.tickVersion)) ? Number(state.tickVersion) : 0;
  const key = poolCacheKey(state);
  if (key) {
    const cached = sortedTicksCache.get(key);
    if (cached && cached.ticksRef === ticks && cached.tickVersion === tickVersion) {
      return cached.sortedTicks;
    }
  }

  const sortedTicks = Array.from(ticks.keys())
    .filter((tick): tick is number => Number.isInteger(tick))
    .sort((a, b) => a - b);
  if (key) {
    sortedTicksCache.set(key, {
      tickVersion,
      ticksRef: ticks,
      sortedTicks,
    });
  }
  return sortedTicks;
}

// ─── V3 Swap Simulator ───────────────────────────────────────

/**
 * Simulate a Uniswap V3 exactInput swap.
 *
 * @param {Object} state             Pool state snapshot
 * @param {bigint} amountIn          Amount of input token (positive)
 * @param {boolean} zeroForOne       Direction: true = token0→token1, false = token1→token0
 * @param {number} [feeOverride]     Optional fee tier override
 * @returns {{ amountOut: bigint, sqrtPriceX96After: bigint, tickAfter: number, gasEstimate: number }}
 */
export function simulateV3Swap(state: unknown, amountIn: bigint, zeroForOne: boolean, feeOverride?: number) {
  const pool = asPoolState(state);
  const sqrtPriceInitial = toBigIntOrNull(pool.sqrtPriceX96);
  const liquidityInitial = toBigIntOrNull(pool.liquidity);
  const feePips = toBigIntOrNull(feeOverride ?? pool.fee);
  const fallbackSqrtPrice = sqrtPriceInitial ?? 0n;
  const fallbackTick = Number.isInteger(pool.tick) ? Number(pool.tick) : 0;

  if (
    amountIn <= 0n ||
    !pool.initialized ||
    sqrtPriceInitial == null ||
    sqrtPriceInitial < MIN_SQRT_RATIO ||
    sqrtPriceInitial >= MAX_SQRT_RATIO ||
    liquidityInitial == null ||
    liquidityInitial <= 0n ||
    feePips == null ||
    feePips < 0n ||
    feePips >= 1_000_000n
  ) {
    return {
      amountOut: 0n,
      sqrtPriceX96After: fallbackSqrtPrice,
      tickAfter: fallbackTick,
      gasEstimate: 0,
    };
  }

  // Price limit: min or max sqrt ratio depending on direction
  const sqrtPriceLimitX96 = zeroForOne ? getSqrtRatioAtTick(MIN_TICK) + 1n : getSqrtRatioAtTick(MAX_TICK) - 1n;

  const sortedTicks = getSortedTicks(pool);
  const ticks = pool.ticks instanceof Map ? pool.ticks : null;

  // Mutable swap state
  let sqrtPriceX96 = sqrtPriceInitial;
  let tick = fallbackTick;
  let liquidity = liquidityInitial;
  let amountRemaining = amountIn; // exactIn: positive
  let amountCalculated = 0n; // accumulated output
  let ticksCrossed = 0;

  // Safety: max iterations to prevent infinite loops
  const MAX_ITERATIONS = 500;

  for (let i = 0; i < MAX_ITERATIONS && amountRemaining > 0n; i++) {
    // Find the next initialized tick boundary
    const nextTick = nextInitializedTickOptimized(sortedTicks, tick, zeroForOne);

    // Determine the sqrt price at the next tick boundary
    const sqrtPriceNextTickX96 = nextTick !== null ? getSqrtRatioAtTick(nextTick) : sqrtPriceLimitX96;

    // Clamp to price limit
    const sqrtRatioTargetX96 = zeroForOne
      ? sqrtPriceNextTickX96 < sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtPriceNextTickX96
      : sqrtPriceNextTickX96 > sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtPriceNextTickX96;

    // Compute swap within this tick range
    const step = computeSwapStep(sqrtPriceX96, sqrtRatioTargetX96, liquidity, amountRemaining, feePips);

    // Update state
    sqrtPriceX96 = step.sqrtRatioNextX96;
    amountRemaining -= step.amountIn + step.feeAmount;
    amountCalculated += step.amountOut;

    // Check if we crossed a tick boundary
    if (sqrtPriceX96 === sqrtPriceNextTickX96 && nextTick !== null) {
      // Cross the tick — adjust liquidity
      const tickData = asTickData(ticks?.get(nextTick));
      if (tickData) {
        // OPTIMIZATION: Assume internal state is already BigInt or cast once
        const liquidityNetRaw = tickData.liquidityNet;
        const liquidityNet = typeof liquidityNetRaw === "bigint" ? liquidityNetRaw : toBigIntOrNull(liquidityNetRaw);
        
        if (liquidityNet == null) break;
        // When moving left (zeroForOne), we subtract liquidityNet
        // When moving right (!zeroForOne), we add liquidityNet
        liquidity = zeroForOne ? liquidity - liquidityNet : liquidity + liquidityNet;
        ticksCrossed++;
      }

      // Update tick position
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else {
      // Didn't reach the next initialized boundary, so derive the active tick
      // from the post-swap sqrt price to keep downstream metadata canonical.
      // We already know the active tick must lie within the interval bounded by
      // the previous active tick and the next initialized boundary when present.
      const minTick = zeroForOne ? (nextTick ?? MIN_TICK) : tick;
      const maxTick = zeroForOne ? tick : nextTick != null ? nextTick - 1 : MAX_TICK;
      tick = getTickAtSqrtRatioInRange(sqrtPriceX96, minTick, maxTick);
      break;
    }

    // Safety: if liquidity drops to zero, we can't continue
    if (liquidity <= 0n) break;
  }

  // Gas estimate: ~185k base (Polygon V3 measured) + ~25k per tick crossed.
  // Previous value of 130k base understated cost by ~40–50k, inflating net profit projections.
  const gasEstimate = 185_000 + ticksCrossed * 25_000;

  return {
    amountOut: amountCalculated,
    sqrtPriceX96After: sqrtPriceX96,
    tickAfter: tick,
    gasEstimate,
  };
}

/**
 * Quote a V3 swap: given amountIn of one token, how much of the other do you get?
 *
 * @param {Object} state      Pool state snapshot
 * @param {bigint} amountIn   Input amount
 * @param {boolean} zeroForOne Direction
 * @param {number} [fee]      Optional fee tier override
 * @returns {bigint}          Output amount
 */
export function quoteV3(state: unknown, amountIn: bigint, zeroForOne: boolean, fee?: number) {
  return simulateV3Swap(state, amountIn, zeroForOne, fee).amountOut;
}
