/**
 * src/math/balancer.js — Balancer V2 weighted and stable pool swap math
 *
 * Implements the weighted constant-product invariant for Balancer pools:
 *
 *   Invariant:  V = prod(B_i ^ w_i)
 *
 * Swap formula (exact input):
 *   amountOut = balanceOut * (1 - (balanceIn / (balanceIn + amountInAfterFee))^(wIn/wOut))
 *
 * Swap formula (exact output):
 *   amountIn = balanceIn * ((balanceOut / (balanceOut - amountOut))^(wOut/wIn) - 1) / (1 - fee)
 *
 * All math uses 18-decimal fixed-point BigInt arithmetic to avoid
 * floating-point precision loss.
 *
 * Pool state shape expected:
 *   {
 *     poolId:    string,
 *     protocol:  string,
 *     tokens:    string[],   // token addresses
 *     balances:  bigint[],   // raw balances (token-decimal precision)
 *     weights?:  bigint[],   // weighted pools: normalized weights in 1e18 (must sum to 1e18)
 *     amp?:      bigint,     // stable pools: amplification parameter
 *     ampPrecision?: bigint, // stable pools: amplification precision, usually 1e3
 *     scalingFactors?: bigint[], // stable pools: raw token amount -> scaled18 factor
 *     swapFee:   bigint,     // swap fee in 1e18 (e.g. 3e15 = 0.3%)
 *     timestamp: number,
 *   }
 *
 * References:
 *   https://docs.balancer.fi/reference/math/weighted-math.html
 *   BalancerV2 WeightedMath.sol
 *   BalancerV2 StableMath.sol
 */

// ─── Constants ────────────────────────────────────────────────

const ONE = 10n ** 18n;
const DEFAULT_AMP_PRECISION = 1000n;
const MAX_IN_RATIO = 30n * 10n ** 16n;
const MAX_OUT_RATIO = 30n * 10n ** 16n;

import { toBigInt } from "../utils/bigint.ts";
import { divRoundingUp } from "./full_math.ts";

// Maximum number of iterations for power approximation
const MAX_POW_ITERATIONS = 255;

type BalancerPoolState = Record<string, unknown>;

function asPoolState(value: unknown): BalancerPoolState {
  return value != null && typeof value === "object" ? (value as BalancerPoolState) : {};
}

function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

// ─── Fixed-point power (x^y) via log/exp series ───────────────

/**
 * Compute natural log approximation of x (in 1e18 fixed-point).
 * Uses the identity: ln(x) = 2 * atanh((x-1)/(x+1)) for x > 0.
 * Limited to inputs near 1.0 for the series to converge quickly.
 *
 * For a broader range we use: ln(x) = ln(2) * log2(x)
 * with log2 computed via bit-shifting (integer part) + series (fractional).
 *
 * @param {bigint} a  Input in 1e18 fixed-point (must be > 0)
 * @returns {bigint}  ln(a) in 1e18 fixed-point
 */
function ln(a: bigint): bigint {
  if (a <= 0n) throw new Error("Balancer: ln undefined for non-positive");
  if (a === ONE) return 0n;

  // Use identity: ln(a) = -ln(1/a) for a < 1
  if (a < ONE) {
    return -ln((ONE * ONE) / a);
  }

  // Reduce: find k such that 2^k <= a/1e18 < 2^(k+1)
  // Then ln(a) = k * ln(2) + ln(a / 2^k)
  let k = 0n;
  let z = a;
  // ln(2) ≈ 0.693147180559945...e18
  const LN2 = 693147180559945309n;

  while (z >= 2n * ONE) {
    z /= 2n;
    k++;
  }

  // Now z is in [1e18, 2e18)
  // Taylor series: ln(1+u) = u - u^2/2 + u^3/3 - ... for |u| < 1
  // u = (z - 1e18) / 1e18
  const u = z - ONE;
  let term = u;
  let sum = 0n;
  let neg = false;

  for (let i = 1n; i <= 20n; i++) {
    if (!neg) {
      sum += term / i;
    } else {
      sum -= term / i;
    }
    neg = !neg;
    term = (term * u) / ONE;
    if (term < 100n) break;
  }

  return k * LN2 + sum;
}

/**
 * Compute e^x in 1e18 fixed-point.
 * Uses Taylor series: e^x = 1 + x + x^2/2! + x^3/3! + ...
 *
 * @param {bigint} x  Exponent in 1e18 fixed-point
 * @returns {bigint}  e^x in 1e18 fixed-point
 */
function exp(x: bigint): bigint {
  if (x === 0n) return ONE;

  // Handle negative exponent: e^(-x) = 1/e^x
  if (x < 0n) {
    return (ONE * ONE) / exp(-x);
  }

  let sum = ONE;
  let term = ONE;

  for (let i = 1n; i <= 30n; i++) {
    term = (term * x) / (ONE * i);
    sum += term;
    if (term < 10n) break;
  }

  return sum;
}

/**
 * Compute x^y in 1e18 fixed-point.
 *
 * @param {bigint} x  Base in 1e18 fixed-point (must be > 0)
 * @param {bigint} y  Exponent in 1e18 fixed-point
 * @returns {bigint}  x^y in 1e18 fixed-point
 */
function powDown(x: bigint, y: bigint): bigint {
  if (x <= 0n) return 0n;
  if (x === ONE) return ONE;
  if (y === 0n) return ONE;
  const lnX = ln(x);
  return exp((y * lnX) / ONE);
}

// ─── Swap math ────────────────────────────────────────────────

/**
 * Compute output amount for a Balancer weighted pool exactInput swap.
 *
 * Formula:
 *   amountOut = balanceOut * (1 - (balanceIn / (balanceIn + amountIn*(1-fee))) ^ (wIn/wOut))
 *
 * @param {bigint} amountIn   Input amount (in token decimals)
 * @param {Object} poolState  Balancer pool state
 * @param {number} inIdx      Index of input token
 * @param {number} outIdx     Index of output token
 * @returns {bigint}          Output amount (after fees)
 */
export function getBalancerAmountOut(amountIn: bigint, poolState: unknown, inIdx: number, outIdx: number): bigint {
  amountIn = toBigInt(amountIn);
  if (amountIn <= 0n) return 0n;

  const pool = asPoolState(poolState);
  const balances = Array.isArray(pool.balances) ? pool.balances : null;
  const weights = Array.isArray(pool.weights) ? pool.weights : null;
  if (!balances || !weights) return 0n;
  if (!Number.isInteger(inIdx) || !Number.isInteger(outIdx)) return 0n;
  if (inIdx < 0 || outIdx < 0 || inIdx >= balances.length || outIdx >= balances.length) return 0n;
  if (inIdx >= weights.length || outIdx >= weights.length || inIdx === outIdx) return 0n;

  const balIn = toBigInt(balances[inIdx]);
  const balOut = toBigInt(balances[outIdx]);
  const wIn = toBigInt(weights[inIdx]);
  const wOut = toBigInt(weights[outIdx]);
  const fee = toBigInt(pool.swapFee);

  if (balIn <= 0n || balOut <= 0n || wIn <= 0n || wOut <= 0n) return 0n;
  if (fee < 0n || fee >= ONE) return 0n;
  if (amountIn > (balIn * MAX_IN_RATIO) / ONE) return 0n;

  // amountIn after fee: amountIn * (1 - swapFee)
  const feeComplement = ONE - fee;
  if (feeComplement <= 0n) return 0n;
  const amountInAfterFee = (amountIn * feeComplement) / ONE;
  const denominator = balIn + amountInAfterFee;
  if (denominator <= 0n) return 0n;

  // ratio = balIn / (balIn + amountInAfterFee) in 1e18
  const base = (balIn * ONE) / denominator;
  if (base <= 0n || base > ONE) return 0n;

  // exponent = wIn / wOut in 1e18
  const exponent = (wIn * ONE) / wOut;
  if (exponent <= 0n) return 0n;

  // base^exponent
  const power = powDown(base, exponent);
  if (power < 0n || power > ONE) return 0n;

  // amountOut = balOut * (1 - power)
  const amountOut = (balOut * (ONE - power)) / ONE;

  return amountOut > 0n ? amountOut : 0n;
}

/**
 * Compute input amount required for a Balancer weighted pool exactOutput swap.
 *
 * Formula:
 *   amountIn = balanceIn * ((balanceOut / (balanceOut - amountOut)) ^ (wOut/wIn) - 1) / (1 - fee)
 *
 * @param {bigint} amountOut  Desired output amount
 * @param {Object} poolState  Balancer pool state
 * @param {number} inIdx      Index of input token
 * @param {number} outIdx     Index of output token
 * @returns {bigint}          Required input amount
 */
export function getBalancerAmountIn(amountOut: bigint, poolState: unknown, inIdx: number, outIdx: number): bigint {
  amountOut = toBigInt(amountOut);
  if (amountOut <= 0n) return 0n;

  const pool = asPoolState(poolState);
  const balances = Array.isArray(pool.balances) ? pool.balances : null;
  const weights = Array.isArray(pool.weights) ? pool.weights : null;
  if (!balances || !weights) return 0n;
  if (!Number.isInteger(inIdx) || !Number.isInteger(outIdx)) return 0n;
  if (inIdx < 0 || outIdx < 0 || inIdx >= balances.length || outIdx >= balances.length) return 0n;
  if (inIdx >= weights.length || outIdx >= weights.length || inIdx === outIdx) return 0n;

  const balIn = toBigInt(balances[inIdx]);
  const balOut = toBigInt(balances[outIdx]);
  const wIn = toBigInt(weights[inIdx]);
  const wOut = toBigInt(weights[outIdx]);
  const fee = toBigInt(pool.swapFee);

  if (balIn <= 0n || balOut <= 0n || wIn <= 0n || wOut <= 0n) return 0n;
  if (fee < 0n || fee >= ONE) return 0n;
  if (amountOut >= balOut) return 0n; // Not enough liquidity
  if (amountOut > (balOut * MAX_OUT_RATIO) / ONE) return 0n;

  // exponent = wOut / wIn
  const exponent = (wOut * ONE) / wIn;
  if (exponent <= 0n) return 0n;

  // base = balOut / (balOut - amountOut)
  const denominator = balOut - amountOut;
  if (denominator <= 0n) return 0n;
  const base = (balOut * ONE) / denominator;
  if (base < ONE) return 0n;

  // power = base^exponent
  const power = powDown(base, exponent);
  if (power < ONE) return 0n;

  // amountInBeforeFee = balIn * (power - 1)
  const amountInBeforeFee = (balIn * (power - ONE)) / ONE;

  // amountIn = amountInBeforeFee / (1 - fee)
  const feeComplement = ONE - fee;
  if (feeComplement <= 0n) return 0n;

  const candidate = (amountInBeforeFee * ONE) / feeComplement + 1n;
  if (candidate <= 0n) return 0n;

  const quoteAt = (amountInCandidate: bigint) => getBalancerAmountOut(amountInCandidate, poolState, inIdx, outIdx);

  let low = 0n;
  let high = candidate;
  let quotedOut = quoteAt(high);

  // The fixed-point power approximation can slightly underestimate the exact-input
  // requirement for larger trades. When that happens, expand upward until the
  // forward quote satisfies the requested output, then binary-search the minimum.
  if (quotedOut < amountOut) {
    low = high;
    high = high > 0n ? high * 2n : 1n;
    for (let i = 0; i < MAX_POW_ITERATIONS; i++) {
      quotedOut = quoteAt(high);
      if (quotedOut >= amountOut) break;
      low = high;
      high *= 2n;
    }
    if (quotedOut < amountOut) return 0n;
  }

  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (quoteAt(mid) >= amountOut) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return high;
}

function getScaledBalances(poolState: unknown): bigint[] | null {
  const pool = asPoolState(poolState);
  const balances = Array.isArray(pool.balances) ? pool.balances : null;
  const scalingFactors = Array.isArray(pool.scalingFactors) ? pool.scalingFactors : null;
  if (!balances || !scalingFactors || balances.length !== scalingFactors.length) return null;

  const scaledBalances: bigint[] = balances.map((balance: unknown, index: number) => {
    const rawBalance = toBigInt(balance);
    const scalingFactor = toBigInt(scalingFactors[index]);
    if (rawBalance <= 0n || scalingFactor <= 0n) return 0n;
    return (rawBalance * scalingFactor) / ONE;
  });

  return scaledBalances.every((balance) => balance > 0n) ? scaledBalances : null;
}

/**
 * Compute the Balancer stable invariant using the same Newton iteration shape
 * as Balancer V2 StableMath._calculateInvariant.
 */
export function calculateBalancerStableInvariant(amp: bigint, balances: bigint[], ampPrecision = DEFAULT_AMP_PRECISION): bigint {
  amp = toBigInt(amp);
  ampPrecision = toBigInt(ampPrecision, DEFAULT_AMP_PRECISION);
  if (!Array.isArray(balances) || balances.length < 2 || amp <= 0n || ampPrecision <= 0n) return 0n;

  const numTokens = BigInt(balances.length);
  let sum = 0n;
  for (const rawBalance of balances) {
    const balance = toBigInt(rawBalance);
    if (balance <= 0n) return 0n;
    sum += balance;
  }
  if (sum === 0n) return 0n;

  let invariant = sum;
  const ampTimesTotal = amp * numTokens;
  if (ampTimesTotal <= ampPrecision) return 0n;

  for (let i = 0; i < MAX_POW_ITERATIONS; i++) {
    let D_P = invariant;
    for (const balance of balances) {
      D_P = (D_P * invariant) / (balance * numTokens);
    }

    const prevInvariant = invariant;
    const numerator = ((ampTimesTotal * sum) / ampPrecision + D_P * numTokens) * invariant;
    const denominator = ((ampTimesTotal - ampPrecision) * invariant) / ampPrecision + (numTokens + 1n) * D_P;
    if (denominator <= 0n) return 0n;
    invariant = numerator / denominator;

    if (absDiff(invariant, prevInvariant) <= 1n) return invariant;
  }

  return invariant;
}

function getTokenBalanceGivenStableInvariant(
  amp: bigint,
  balances: bigint[],
  invariant: bigint,
  tokenIndex: number,
  ampPrecision = DEFAULT_AMP_PRECISION,
): bigint {
  amp = toBigInt(amp);
  ampPrecision = toBigInt(ampPrecision, DEFAULT_AMP_PRECISION);
  if (
    !Array.isArray(balances) ||
    balances.length < 2 ||
    !Number.isInteger(tokenIndex) ||
    tokenIndex < 0 ||
    tokenIndex >= balances.length ||
    amp <= 0n ||
    ampPrecision <= 0n ||
    invariant <= 0n
  ) {
    return 0n;
  }

  const numTokens = BigInt(balances.length);
  const ampTimesTotal = amp * numTokens;
  if (ampTimesTotal <= 0n) return 0n;

  let sum = toBigInt(balances[0]);
  let P_D = toBigInt(balances[0]) * numTokens;
  for (let j = 1; j < balances.length; j++) {
    const balance = toBigInt(balances[j]);
    if (balance <= 0n) return 0n;
    P_D = (P_D * balance * numTokens) / invariant;
    sum += balance;
  }

  const indexedBalance = toBigInt(balances[tokenIndex]);
  if (indexedBalance <= 0n || P_D <= 0n) return 0n;
  sum -= indexedBalance;

  const inv2 = invariant * invariant;
  const c = divRoundingUp(inv2 * ampPrecision * indexedBalance, ampTimesTotal * P_D);
  const b = sum + (invariant / ampTimesTotal) * ampPrecision - invariant;

  let tokenBalance = divRoundingUp(inv2 + c, invariant + b);
  for (let i = 0; i < MAX_POW_ITERATIONS; i++) {
    const prevTokenBalance = tokenBalance;
    const denominator = 2n * tokenBalance + b - invariant;
    if (denominator <= 0n) return 0n;
    tokenBalance = divRoundingUp(tokenBalance * tokenBalance + c, denominator);
    if (absDiff(tokenBalance, prevTokenBalance) <= 1n) return tokenBalance;
  }

  return tokenBalance;
}

/**
 * Compute output amount for a Balancer stable/composable-stable exactInput swap.
 */
export function getBalancerStableAmountOut(amountIn: bigint, poolState: unknown, inIdx: number, outIdx: number): bigint {
  amountIn = toBigInt(amountIn);
  if (amountIn <= 0n) return 0n;
  if (!Number.isInteger(inIdx) || !Number.isInteger(outIdx) || inIdx === outIdx) return 0n;

  const pool = asPoolState(poolState);
  const scaledBalances = getScaledBalances(poolState);
  if (!scaledBalances) return 0n;
  if (inIdx < 0 || outIdx < 0 || inIdx >= scaledBalances.length || outIdx >= scaledBalances.length) return 0n;

  const scalingFactors = Array.isArray(pool.scalingFactors) ? pool.scalingFactors.map((value: unknown) => toBigInt(value)) : [];
  const fee = toBigInt(pool.swapFee);
  if (fee < 0n || fee >= ONE || scalingFactors[inIdx] <= 0n || scalingFactors[outIdx] <= 0n) return 0n;

  const amountInAfterFee = (amountIn * (ONE - fee)) / ONE;
  const scaledAmountIn = (amountInAfterFee * scalingFactors[inIdx]) / ONE;
  if (scaledAmountIn <= 0n) return 0n;

  const amp = toBigInt(pool.amp);
  const ampPrecision = toBigInt(pool.ampPrecision, DEFAULT_AMP_PRECISION);
  const invariant = calculateBalancerStableInvariant(amp, scaledBalances, ampPrecision);
  if (invariant <= 0n) return 0n;

  const balancesAfterIn = [...scaledBalances];
  balancesAfterIn[inIdx] += scaledAmountIn;
  const finalBalanceOut = getTokenBalanceGivenStableInvariant(amp, balancesAfterIn, invariant, outIdx, ampPrecision);
  if (finalBalanceOut <= 0n || finalBalanceOut >= scaledBalances[outIdx]) return 0n;

  const scaledAmountOut = scaledBalances[outIdx] - finalBalanceOut - 1n;
  if (scaledAmountOut <= 0n) return 0n;
  const amountOut = (scaledAmountOut * ONE) / scalingFactors[outIdx];

  return amountOut > 0n ? amountOut : 0n;
}

/**
 * Simulate a Balancer pool swap given a unified pool state.
 *
 * Routing-compatible wrapper.
 *
 * @param {bigint}  amountIn    Input amount
 * @param {Object}  poolState   Normalized Balancer pool state (from normalizer)
 * @param {number}  inIdx       Input token index
 * @param {number}  outIdx      Output token index
 * @returns {{ amountOut: bigint, gasEstimate: number }}
 */
export function simulateBalancerSwap(
  amountIn: bigint,
  poolState: unknown,
  inIdx = 0,
  outIdx = 1,
): { amountOut: bigint; gasEstimate: number } {
  amountIn = toBigInt(amountIn);
  if (amountIn <= 0n) return { amountOut: 0n, gasEstimate: 0 };

  let amountOut = 0n;
  try {
    const pool = asPoolState(poolState);
    amountOut =
      pool.isStable === true || pool.amp != null
        ? getBalancerStableAmountOut(amountIn, poolState, inIdx, outIdx)
        : getBalancerAmountOut(amountIn, poolState, inIdx, outIdx);
  } catch {
    amountOut = 0n;
  }

  // Balancer swaps: ~150k gas
  return { amountOut, gasEstimate: 150_000 };
}
