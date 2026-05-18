/**
 * src/math/sqrt_price_math.js — Q64.96 sqrt price math
 *
 * JavaScript BigInt port of Uniswap V3's SqrtPriceMath.sol.
 * Computes token deltas and next prices from sqrt price and liquidity.
 *
 * All values are BigInt. Rounding follows the Solidity contract exactly:
 *   - amountIn calculations round UP (pessimistic for the swapper)
 *   - amountOut calculations round DOWN (pessimistic for the swapper)
 */

import { mulDiv, mulDivRoundingUp, divRoundingUp } from "./full_math.ts";

// ─── Constants ────────────────────────────────────────────────

const Q96 = 1n << 96n;

// ─── Next sqrt price from token0 delta ────────────────────────

/**
 * Gets the next sqrt price given a delta of token0.
 * Always rounds up.
 *
 * Formula: L * sqrtP / (L + amount * sqrtP)  [if adding]
 *          L * sqrtP / (L - amount * sqrtP)  [if removing]
 *
 * @param {bigint} sqrtPX96   Current sqrt price (Q64.96)
 * @param {bigint} liquidity  Usable liquidity (uint128)
 * @param {bigint} amount     Amount of token0 to add/remove
 * @param {boolean} add       Whether adding or removing token0
 * @returns {bigint}          Next sqrt price (Q64.96)
 */
export function getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPX96;

  const numerator1 = liquidity << 96n;

  if (add) {
    const product = amount * sqrtPX96;
    const denominator = numerator1 + product;
    if (denominator >= numerator1) {
      return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
    }
    // Overflow fallback
    return divRoundingUp(numerator1, numerator1 / sqrtPX96 + amount);
  } else {
    const product = amount * sqrtPX96;
    if (numerator1 <= product) {
      throw new Error("SqrtPriceMath: denominator underflow");
    }
    const denominator = numerator1 - product;
    return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
  }
}

// ─── Next sqrt price from token1 delta ────────────────────────

/**
 * Gets the next sqrt price given a delta of token1.
 * Always rounds down.
 *
 * Formula: sqrtP + amount / L  [if adding]
 *          sqrtP - amount / L  [if removing]
 *
 * @param {bigint} sqrtPX96   Current sqrt price (Q64.96)
 * @param {bigint} liquidity  Usable liquidity (uint128)
 * @param {bigint} amount     Amount of token1 to add/remove
 * @param {boolean} add       Whether adding or removing token1
 * @returns {bigint}          Next sqrt price (Q64.96)
 */
export function getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) {
    const quotient = mulDiv(amount, Q96, liquidity);
    return sqrtPX96 + quotient;
  } else {
    const quotient = mulDivRoundingUp(amount, Q96, liquidity);
    if (sqrtPX96 <= quotient) {
      throw new Error("SqrtPriceMath: price underflow");
    }
    return sqrtPX96 - quotient;
  }
}

// ─── Next sqrt price from input ───────────────────────────────

/**
 * Gets the next sqrt price given an input amount of token0 or token1.
 *
 * @param {bigint} sqrtPX96   Current sqrt price
 * @param {bigint} liquidity  Usable liquidity
 * @param {bigint} amountIn   Input amount
 * @param {boolean} zeroForOne Whether swapping token0 for token1
 * @returns {bigint}          Next sqrt price
 */
export function getNextSqrtPriceFromInput(sqrtPX96: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtPX96 <= 0n) throw new Error("SqrtPriceMath: sqrtPX96 must be > 0");
  if (liquidity <= 0n) throw new Error("SqrtPriceMath: liquidity must be > 0");

  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

/**
 * Gets the next sqrt price given an output amount of token0 or token1.
 *
 * @param {bigint} sqrtPX96   Current sqrt price
 * @param {bigint} liquidity  Usable liquidity
 * @param {bigint} amountOut  Output amount
 * @param {boolean} zeroForOne Whether swapping token0 for token1
 * @returns {bigint}          Next sqrt price
 */
export function getNextSqrtPriceFromOutput(sqrtPX96: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint {
  if (sqrtPX96 <= 0n) throw new Error("SqrtPriceMath: sqrtPX96 must be > 0");
  if (liquidity <= 0n) throw new Error("SqrtPriceMath: liquidity must be > 0");

  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}

// ─── Token amount deltas ──────────────────────────────────────

/**
 * Gets the amount0 delta between two prices.
 *
 * amount0 = L * (sqrtB - sqrtA) / (sqrtA * sqrtB)
 *
 * @param {bigint} sqrtRatioAX96  A sqrt price
 * @param {bigint} sqrtRatioBX96  Another sqrt price
 * @param {bigint} liquidity      Usable liquidity (uint128)
 * @param {boolean} roundUp       Whether to round up
 * @returns {bigint}              Amount of token0
 */
export function getAmount0Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  // Ensure A < B
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }

  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;

  if (sqrtRatioAX96 <= 0n) {
    throw new Error("SqrtPriceMath: sqrtRatioAX96 must be > 0");
  }

  if (roundUp) {
    return divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), sqrtRatioAX96);
  } else {
    return mulDiv(numerator1, numerator2, sqrtRatioBX96) / sqrtRatioAX96;
  }
}

/**
 * Gets the amount1 delta between two prices.
 *
 * amount1 = L * (sqrtB - sqrtA)
 *
 * @param {bigint} sqrtRatioAX96  A sqrt price
 * @param {bigint} sqrtRatioBX96  Another sqrt price
 * @param {bigint} liquidity      Usable liquidity (uint128)
 * @param {boolean} roundUp       Whether to round up
 * @returns {bigint}              Amount of token1
 */
export function getAmount1Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  // Ensure A < B
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }

  if (roundUp) {
    return mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
  } else {
    return mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
  }
}
