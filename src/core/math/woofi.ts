import { toBigInt } from "../utils/bigint.ts";
import { asRecord } from "../utils/errors.ts";

const ONE = 10n ** 18n;
const WOOFI_FEE_DENOMINATOR = 100_000n;

type WoofiPoolState = Record<string, unknown>;
type WoofiBaseState = Record<string, unknown>;

function tokenKey(token: unknown) {
  return typeof token === "string" ? token.toLowerCase() : "";
}

function getBaseState(poolState: unknown, token: unknown): WoofiBaseState | null {
  const key = tokenKey(token);
  const pool = asRecord(poolState);
  const states = asRecord(pool.baseTokenStates ?? pool.baseStates);
  const state = states[key];
  return state != null && typeof state === "object" ? (state as WoofiBaseState) : null;
}

function getQuoteToken(poolState: unknown) {
  const pool = asRecord(poolState);
  const tokens = Array.isArray(pool.tokens) ? pool.tokens : [];
  return tokenKey(pool.quoteToken ?? tokens[0]);
}

function hasPositiveSwapFactor(gamma: bigint, spread: bigint) {
  return gamma >= 0n && spread >= 0n && gamma + spread < ONE;
}

function calcQuoteAmountSellBase(baseState: WoofiBaseState, baseAmount: bigint, spreadOverride: bigint | null = null) {
  const price = toBigInt(baseState?.price);
  const coeff = toBigInt(baseState?.coeff);
  const spread = spreadOverride ?? toBigInt(baseState?.spread);
  const baseDec = toBigInt(baseState?.baseDec, 1n);
  const quoteDec = toBigInt(baseState?.quoteDec, 1n);
  const priceDec = toBigInt(baseState?.priceDec, 1n);
  const maxGamma = toBigInt(baseState?.maxGamma);
  const maxNotionalSwap = toBigInt(baseState?.maxNotionalSwap);

  if (baseAmount <= 0n || price <= 0n || baseDec <= 0n || quoteDec <= 0n || priceDec <= 0n) return 0n;
  if (baseState?.feasible === false || baseState?.woFeasible === false) return 0n;

  const notionalSwap = (baseAmount * price * quoteDec) / baseDec / priceDec;
  if (maxNotionalSwap > 0n && notionalSwap > maxNotionalSwap) return 0n;

  const gamma = (baseAmount * price * coeff) / priceDec / baseDec;
  if (maxGamma > 0n && gamma > maxGamma) return 0n;
  if (!hasPositiveSwapFactor(gamma, spread)) return 0n;

  return (((baseAmount * price * quoteDec) / priceDec) * (ONE - gamma - spread)) / ONE / baseDec;
}

function calcBaseAmountSellQuote(baseState: WoofiBaseState, quoteAmount: bigint, spreadOverride: bigint | null = null) {
  const price = toBigInt(baseState?.price);
  const coeff = toBigInt(baseState?.coeff);
  const spread = spreadOverride ?? toBigInt(baseState?.spread);
  const baseDec = toBigInt(baseState?.baseDec, 1n);
  const quoteDec = toBigInt(baseState?.quoteDec, 1n);
  const priceDec = toBigInt(baseState?.priceDec, 1n);
  const maxGamma = toBigInt(baseState?.maxGamma);
  const maxNotionalSwap = toBigInt(baseState?.maxNotionalSwap);

  if (quoteAmount <= 0n || price <= 0n || baseDec <= 0n || quoteDec <= 0n || priceDec <= 0n) return 0n;
  if (baseState?.feasible === false || baseState?.woFeasible === false) return 0n;
  if (maxNotionalSwap > 0n && quoteAmount > maxNotionalSwap) return 0n;

  const gamma = (quoteAmount * coeff) / quoteDec;
  if (maxGamma > 0n && gamma > maxGamma) return 0n;
  if (!hasPositiveSwapFactor(gamma, spread)) return 0n;

  return (((quoteAmount * baseDec * priceDec) / price) * (ONE - gamma - spread)) / ONE / quoteDec;
}

function applyWoofiFee(amount: bigint, feeRate: bigint) {
  if (amount <= 0n) return 0n;
  if (feeRate < 0n || feeRate >= WOOFI_FEE_DENOMINATOR) return 0n;
  return amount - (amount * feeRate) / WOOFI_FEE_DENOMINATOR;
}

export function getWoofiFeeRate(poolState: unknown, tokenIn: unknown, tokenOut: unknown) {
  const quoteToken = getQuoteToken(poolState);
  const inKey = tokenKey(tokenIn);
  const outKey = tokenKey(tokenOut);
  if (!quoteToken || !inKey || !outKey || inKey === outKey) return 0n;

  if (inKey === quoteToken) return toBigInt(getBaseState(poolState, outKey)?.feeRate);
  if (outKey === quoteToken) return toBigInt(getBaseState(poolState, inKey)?.feeRate);

  const inFee = toBigInt(getBaseState(poolState, inKey)?.feeRate);
  const outFee = toBigInt(getBaseState(poolState, outKey)?.feeRate);
  return inFee > outFee ? inFee : outFee;
}

export function getWoofiEdgeFeeBps(poolState: unknown, tokenIn: unknown, tokenOut: unknown) {
  const feeRate = getWoofiFeeRate(poolState, tokenIn, tokenOut);
  return Number(feeRate) / 10;
}

export function getWoofiAmountOut(poolState: unknown, amountIn: bigint, tokenIn: unknown, tokenOut: unknown) {
  const amount = toBigInt(amountIn);
  if (amount <= 0n) return 0n;

  const quoteToken = getQuoteToken(poolState);
  const inKey = tokenKey(tokenIn);
  const outKey = tokenKey(tokenOut);
  if (!quoteToken || !inKey || !outKey || inKey === outKey) return 0n;

  const pool = asRecord(poolState);
  const quoteReserve = toBigInt(pool.quoteReserve);

  if (outKey === quoteToken) {
    const baseState = getBaseState(poolState, inKey);
    if (!baseState) return 0n;
    const feeAdjustedBase = applyWoofiFee(amount, toBigInt(baseState.feeRate));
    const quoteOut = calcQuoteAmountSellBase(baseState, feeAdjustedBase);
    return quoteReserve > 0n && quoteOut <= quoteReserve ? quoteOut : 0n;
  }

  if (inKey === quoteToken) {
    const baseState = getBaseState(poolState, outKey);
    if (!baseState) return 0n;
    const feeAdjustedQuote = applyWoofiFee(amount, toBigInt(baseState.feeRate));
    const baseOut = calcBaseAmountSellQuote(baseState, feeAdjustedQuote);
    const baseReserve = toBigInt(baseState.reserve);
    return baseReserve > 0n && baseOut <= baseReserve ? baseOut : 0n;
  }

  const sellBaseState = getBaseState(poolState, inKey);
  const buyBaseState = getBaseState(poolState, outKey);
  if (!sellBaseState || !buyBaseState) return 0n;

  const sharedSpread = (() => {
    const left = toBigInt(sellBaseState.spread);
    const right = toBigInt(buyBaseState.spread);
    return (left > right ? left : right) / 2n;
  })();
  const feeAdjustedBase = applyWoofiFee(amount, getWoofiFeeRate(poolState, inKey, outKey));
  const quoteAmount = calcQuoteAmountSellBase(sellBaseState, feeAdjustedBase, sharedSpread);
  const baseOut = calcBaseAmountSellQuote(buyBaseState, quoteAmount, sharedSpread);
  const baseReserve = toBigInt(buyBaseState.reserve);

  return baseReserve > 0n && baseOut <= baseReserve ? baseOut : 0n;
}

export function simulateWoofiSwap(
  amountIn: bigint,
  poolState: unknown,
  tokenInIdx: number,
  tokenOutIdx: number,
): { amountOut: bigint; gasEstimate: number } {
  if (amountIn <= 0n) return { amountOut: 0n, gasEstimate: 0 };
  const pool = asRecord(poolState) as WoofiPoolState;
  const tokens = Array.isArray(pool.tokens) ? pool.tokens : [];
  const tokenIn = tokens[tokenInIdx];
  const tokenOut = tokens[tokenOutIdx];
  if (!tokenIn || !tokenOut) return { amountOut: 0n, gasEstimate: 0 };

  return {
    amountOut: getWoofiAmountOut(poolState, amountIn, tokenIn, tokenOut),
    gasEstimate: 150000,
  };
}
