/**
 * src/math/curve.js — Curve StableSwap swap math
 *
 * Implements the StableSwap invariant for 2-token and multi-token pools.
 *
 * Invariant:  A * n^n * sum(x_i) + D = A * n^n * D + D^(n+1) / (n^n * prod(x_i))
 *
 * Supports:
 *   - getCurveAmountOut(amountIn, poolState) — exactIn swap
 *   - getCurveAmountIn(amountOut, poolState) — exactOut (reverse)
 *
 * Pool state shape expected:
 *   {
 *     poolId:     string,
 *     protocol:   string,
 *     tokens:     string[],     // token addresses
 *     balances:   bigint[],     // raw on-chain balances (18-decimal normalized)
 *     rates:      bigint[],     // rate multipliers (1e18 = 1.0)
 *     fee:        bigint,       // swap fee in 1e10 basis (1e7 = 0.04%)
 *     A:          bigint,       // amplification coefficient
 *     timestamp:  number,
 *   }
 *
 * Fees: Curve fees are expressed as a fraction of 1e10.
 *   Default fee = 4e6 / 1e10 = 0.04%.
 *   Admin fee = 5e9 / 1e10 = 50% of swap fee.
 *
 * References:
 *   https://curve.fi/files/stableswap-paper.pdf
 *   Curve contracts: exchange() in pool implementations
 */

// ─── Constants ────────────────────────────────────────────────

const PRECISION = 10n ** 18n;
const FEE_DENOMINATOR = 10n ** 10n;
const A_PRECISION = 100n;

import { toBigIntOrNull } from "../utils/bigint.ts";

// Max Newton iterations for invariant solve
const MAX_ITERATIONS = 255;

type CurvePoolState = Record<string, unknown>;

function asPoolState(value: unknown): CurvePoolState {
  return value != null && typeof value === "object" ? (value as CurvePoolState) : {};
}

// ─── Invariant helpers ────────────────────────────────────────

/**
 * Compute the StableSwap invariant D given balances and amplification A.
 *
 * Uses Newton's method to solve:
 *   A * n^n * S + D = A * D * n^n + D^(n+1) / (n^n * P)
 *
 * @param {bigint[]} xp  Precision-scaled balances
 * @param {bigint}   A   Amplification coefficient (in A_PRECISION units)
 * @returns {bigint}     D — the invariant
 */
function getD(xp: bigint[], A: bigint) {
  const n = BigInt(xp.length);
  const S = xp.reduce((a, b) => a + b, 0n);
  if (S === 0n) return 0n;

  let D = S;
  const Ann = A * n; // A * n (already in A_PRECISION units)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let D_P = D;
    for (const x of xp) {
      D_P = (D_P * D) / (x * n);
    }

    const Dprev = D;
    // D = (Ann * S / A_PRECISION + D_P * n) * D / ((Ann / A_PRECISION - 1) * D + (n + 1) * D_P)
    D = (((Ann * S) / A_PRECISION + D_P * n) * D) / (((Ann - A_PRECISION) * D) / A_PRECISION + (n + 1n) * D_P);

    const diff = D > Dprev ? D - Dprev : Dprev - D;
    if (diff <= 1n) return D;
  }

  return D;
}

/**
 * Compute the output balance y given:
 *   - the new input balance x for coin i
 *   - all current balances xp
 *   - index i (input coin)
 *   - index j (output coin)
 *
 * Solves: D = A * n^n * S + D^(n+1)/(n^n*P) for y
 *
 * @param {bigint}   x    New balance of input coin after adding amountIn
 * @param {number}   i    Index of input coin
 * @param {number}   j    Index of output coin
 * @param {bigint[]} xp   Current precision-scaled balances
 * @param {bigint}   A    Amplification coefficient (A_PRECISION units)
 * @param {bigint}   D    Invariant
 * @returns {bigint}      New balance of output coin y
 */
function getY(x: bigint, i: number, j: number, xp: bigint[], A: bigint, D: bigint) {
  const n = BigInt(xp.length);
  const Ann = A * n;

  let S_ = 0n;
  let C = D;

  for (let k = 0; k < xp.length; k++) {
    let x_k;
    if (k === i) {
      x_k = x;
    } else if (k !== j) {
      x_k = xp[k];
    } else {
      continue;
    }
    S_ += x_k;
    C = (C * D) / (x_k * n);
  }

  C = (C * D * A_PRECISION) / (Ann * n);
  const b = S_ + (D * A_PRECISION) / Ann;

  let y = D;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const yprev = y;
    y = (y * y + C) / (2n * y + b - D);
    const diff = y > yprev ? y - yprev : yprev - y;
    if (diff <= 1n) return y;
  }

  return y;
}

// ─── Rate scaling ─────────────────────────────────────────────

/**
 * Apply rate multipliers to raw balances.
 * rates[i] is a 1e18-precision multiplier (e.g. 1e18 for standard tokens,
 * higher for rebasing tokens like stETH/aToken).
 *
 * @param {bigint[]} balances
 * @param {bigint[]} rates  (length must match balances)
 * @returns {bigint[]}
 */
function toXp(balances: bigint[], rates: bigint[]) {
  return balances.map((b, i) => (b * rates[i]) / PRECISION);
}

function toBigIntArray(values: unknown) {
  if (!Array.isArray(values)) return null;
  const out: bigint[] = [];
  for (const value of values) {
    const normalized = toBigIntOrNull(value);
    if (normalized == null || normalized < 0n) return null;
    out.push(normalized);
  }
  return out;
}

function toPositiveBigInt(value: unknown) {
  const normalized = toBigIntOrNull(value);
  return normalized != null && normalized > 0n ? normalized : null;
}

function toNonNegativeBigInt(value: unknown) {
  const normalized = toBigIntOrNull(value);
  return normalized != null && normalized >= 0n ? normalized : null;
}

function hasValidCurveIndexes(length: number, tokenInIdx: number, tokenOutIdx: number) {
  return (
    Number.isInteger(tokenInIdx) &&
    Number.isInteger(tokenOutIdx) &&
    tokenInIdx >= 0 &&
    tokenOutIdx >= 0 &&
    tokenInIdx < length &&
    tokenOutIdx < length &&
    tokenInIdx !== tokenOutIdx
  );
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Compute output amount for a Curve swap.
 *
 * @param {bigint} amountIn    Amount of input token (in token decimals)
 * @param {Object} poolState   Normalized Curve pool state
 * @param {number} tokenInIdx  Index of input token in poolState.tokens
 * @param {number} tokenOutIdx Index of output token in poolState.tokens
 * @returns {bigint}           Output amount (after fees)
 */
export function getCurveAmountOut(amountIn: bigint, poolState: unknown, tokenInIdx: number, tokenOutIdx: number) {
  if (amountIn <= 0n) return 0n;

  const pool = asPoolState(poolState);
  const balances = toBigIntArray(pool.balances);
  const rates = toBigIntArray(pool.rates);
  const fee = toNonNegativeBigInt(pool.fee);
  const A = toPositiveBigInt(pool.A);
  if (!balances || !rates || fee == null || A == null) return 0n;
  if (balances.length < 2 || rates.length !== balances.length) return 0n;
  if (!hasValidCurveIndexes(balances.length, tokenInIdx, tokenOutIdx)) return 0n;
  if (balances.some((balance) => balance <= 0n) || rates.some((rate) => rate <= 0n)) return 0n;
  if (fee >= FEE_DENOMINATOR) return 0n;

  const xp = toXp(balances, rates);
  if (xp.some((balance) => balance <= 0n)) return 0n;
  const D = getD(xp, A);
  if (D <= 0n) return 0n;

  const x = xp[tokenInIdx] + (amountIn * rates[tokenInIdx]) / PRECISION;

  const y = getY(x, tokenInIdx, tokenOutIdx, xp, A, D);
  const dy = xp[tokenOutIdx] - y - 1n;

  if (dy <= 0n) return 0n;

  // Apply swap fee (fee is in 1e10 basis)
  const feeAmount = (dy * fee) / FEE_DENOMINATOR;
  const dyAfterFee = dy - feeAmount;
  if (dyAfterFee <= 0n) return 0n;

  // Convert back from xp scaling
  return (dyAfterFee * PRECISION) / rates[tokenOutIdx];
}

/**
 * Compute input amount required to receive a given output from a Curve swap.
 *
 * Uses iterative search (binary search on getCurveAmountOut) since inverting
 * StableSwap analytically is complex.
 *
 * @param {bigint} amountOut   Desired output amount
 * @param {Object} poolState   Normalized Curve pool state
 * @param {number} tokenInIdx  Index of input token
 * @param {number} tokenOutIdx Index of output token
 * @returns {bigint}           Required input amount (or 0n if infeasible)
 */
export function getCurveAmountIn(amountOut: bigint, poolState: unknown, tokenInIdx: number, tokenOutIdx: number) {
  if (amountOut <= 0n) return 0n;

  const balances = toBigIntArray(asPoolState(poolState).balances);
  if (!balances || !hasValidCurveIndexes(balances.length, tokenInIdx, tokenOutIdx)) return 0n;
  if (amountOut >= balances[tokenOutIdx]) return 0n;

  // Binary search: find smallest amountIn such that getCurveAmountOut >= amountOut
  let lo = 1n;
  let hi = amountOut * 10n; // initial upper bound

  // Expand upper bound if needed
  for (let i = 0; i < 50; i++) {
    const out = getCurveAmountOut(hi, poolState, tokenInIdx, tokenOutIdx);
    if (out >= amountOut) break;
    hi *= 2n;
  }

  if (getCurveAmountOut(hi, poolState, tokenInIdx, tokenOutIdx) < amountOut) {
    return 0n;
  }

  for (let i = 0; i < 64; i++) {
    if (lo >= hi) break;
    const mid = (lo + hi) / 2n;
    const out = getCurveAmountOut(mid, poolState, tokenInIdx, tokenOutIdx);
    if (out >= amountOut) {
      hi = mid;
    } else {
      lo = mid + 1n;
    }
  }

  return lo;
}

/**
 * Simulate a Curve swap given a unified pool state.
 *
 * Routing-compatible wrapper: determines token indices from the
 * pool state's token list and dispatches to getCurveAmountOut.
 *
 * @param {bigint}  amountIn    Input amount
 * @param {Object}  poolState   Normalized Curve pool state (from normalizer)
 * @param {number}  tokenInIdx  Input token index
 * @param {number}  tokenOutIdx Output token index
 * @returns {{ amountOut: bigint, gasEstimate: number }}
 */
export function simulateCurveSwap(amountIn: bigint, poolState: unknown, tokenInIdx = 0, tokenOutIdx = 1) {
  if (amountIn <= 0n) return { amountOut: 0n, gasEstimate: 0 };

  const amountOut = getCurveAmountOut(amountIn, poolState, tokenInIdx, tokenOutIdx);

  // Curve swaps: ~200k gas for stable pools
  return { amountOut, gasEstimate: 200_000 };
}

/**
 * Build a default rates array (all 1e18) for pools without rate multipliers.
 *
 * @param {number} n  Number of tokens
 * @returns {bigint[]}
 */
export function defaultRates(n: number) {
  return Array(n).fill(PRECISION);
}
