/**
 * src/math/full_math.js — 512-bit precision math (BigInt)
 *
 * JavaScript BigInt port of Uniswap V3's FullMath.sol.
 * BigInt natively handles arbitrary precision, so we don't need
 * the 512-bit assembly tricks — we just use BigInt division directly.
 *
 * All inputs and outputs are BigInt unless noted otherwise.
 */

/**
 * Calculates floor(a * b / denominator) with full precision.
 * Throws if denominator is zero.
 *
 * @param {bigint} a
 * @param {bigint} b
 * @param {bigint} denominator
 * @returns {bigint}
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDiv: denominator is zero");
  return (a * b) / denominator;
}

/**
 * Calculates ceil(a * b / denominator) with full precision.
 * Throws if denominator is zero.
 *
 * @param {bigint} a
 * @param {bigint} b
 * @param {bigint} denominator
 * @returns {bigint}
 */
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDivRoundingUp: denominator is zero");
  const product = a * b;
  const result = product / denominator;
  return product % denominator > 0n ? result + 1n : result;
}

/**
 * Ceiling division: ceil(a / b).
 *
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
export function divRoundingUp(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("divRoundingUp: divisor is zero");
  const result = a / b;
  return a % b > 0n ? result + 1n : result;
}
