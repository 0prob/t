/**
 * src/state/normalizer.js — Unified pool state normalizer
 *
 * Converts protocol-specific raw pool state into a canonical format
 * that all routing, simulation, and profitability modules consume.
 *
 * Canonical shape:
 * {
 *   poolId:    string,    // lowercase pool address
 *   protocol:  string,    // e.g. "QUICKSWAP_V2", "UNISWAP_V3", "CURVE_STABLE", "BALANCER_WEIGHTED"
 *   token0:    string,    // lowercase address
 *   token1:    string,    // lowercase address (or more tokens via `tokens`)
 *   tokens:    string[],  // all tokens (length >= 2)
 *   fee:       bigint,    // protocol-specific fee representation
 *   timestamp: number,    // ms since epoch when state was fetched
 *
 *   // V2 fields (QUICKSWAP_V2, SUSHISWAP_V2)
 *   reserve0?:   bigint,
 *   reserve1?:   bigint,
 *
 *   // V3 fields (UNISWAP_V3, QUICKSWAP_V3, SUSHISWAP_V3)
 *   sqrtPriceX96?: bigint,
 *   tick?:          number,
 *   liquidity?:     bigint,
 *   tickSpacing?:   number,
 *   ticks?:         Map<number, { liquidityGross: bigint, liquidityNet: bigint }>,
 *   initialized?:   boolean,
 *
 *   // Curve fields
 *   balances?: bigint[],  // per-token balances in 1e18 precision
 *   rates?:    bigint[],  // rate multipliers (1e18 = 1.0)
 *   A?:        bigint,    // amplification coefficient
 *
 *   // Balancer fields
 *   weights?:  bigint[],  // normalized weights (sum = 1e18)
 *   swapFee?:  bigint,    // fee in 1e18 precision
 * }
 */

import { defaultRates } from "../math/curve.ts";
import { MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../math/tick_math.ts";
import {
  BALANCER_PROTOCOLS,
  CURVE_PROTOCOLS,
  DODO_PROTOCOLS,
  normalizeProtocolKey,
  V2_PROTOCOLS,
  V3_PROTOCOLS,
  WOOFI_PROTOCOLS,
} from "../protocols/classification.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";

const ONE = 10n ** 18n;
const DEFAULT_V2_FEE_NUMERATOR = 997n;
const DEFAULT_V2_FEE_DENOMINATOR = 1000n;

type StateRecord = Record<string, unknown>;
type BigIntLike = bigint | boolean | number | string;

function asStateRecord(value: unknown): StateRecord {
  return value != null && (typeof value === "object" || typeof value === "function") ? (value as StateRecord) : {};
}

function asStateRecordOrNull(value: unknown): StateRecord | null {
  return value != null && (typeof value === "object" || typeof value === "function") ? (value as StateRecord) : null;
}

function toBigIntStrict(value: unknown) {
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return BigInt(value as BigIntLike);
  }
  throw new Error(`invalid bigint value: ${String(value)}`);
}

function toBigIntOrFallback(value: unknown, fallback = 0n): bigint {
  if (value == null) return fallback;
  try {
    return toBigIntStrict(value);
  } catch {
    return fallback;
  }
}

function toNonNegativeInteger(value: unknown, fallback = 0) {
  if (value == null) return fallback;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function pow10ForDecimals(value: unknown) {
  const decimals = toNonNegativeInteger(value, 0);
  return decimals <= 38 ? 10n ** BigInt(decimals) : 1n;
}

function normalizeStateAddress(value: unknown, allowZero = false) {
  return normalizeEvmAddress(value, { allowZero });
}

function normalizeStateTokenList(tokens: unknown, allowZero = true) {
  if (!Array.isArray(tokens)) return [];
  return tokens.map((t) => normalizeStateAddress(t, allowZero)).filter((token): token is string => token != null);
}

function normalizeTokenDecimalsList(tokens: string[], meta: unknown = {}) {
  const metaRecord = asStateRecord(meta);

  // Build a case-normalized lookup map from tokenDecimalsByAddress.
  // Metadata keys may be checksummed (mixed-case) addresses written by external
  // tooling — always lowercase them before lookup to avoid silent misses.
  const rawByAddress = asStateRecordOrNull(metaRecord.tokenDecimalsByAddress ?? metaRecord.decimalsByAddress);
  const byAddress: Record<string, unknown> = {};
  if (rawByAddress) {
    for (const [k, v] of Object.entries(rawByAddress)) {
      byAddress[k.toLowerCase()] = v;
    }
  }

  const list = Array.isArray(metaRecord.tokenDecimals)
    ? metaRecord.tokenDecimals
    : Array.isArray(metaRecord.decimals)
      ? metaRecord.decimals
      : null;

  return tokens.map((token, index) => {
    // token is already lowercase from normalizeStateTokenList
    const raw =
      Object.keys(byAddress).length > 0
        ? byAddress[token] // token is lowercase, byAddress keys are lowercase
        : list?.[index];
    const decimals = Number(raw);
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
  });
}

function normalizeBigIntList(values: unknown, length: number) {
  if (!Array.isArray(values) || values.length !== length) return null;
  const out: bigint[] = [];
  for (const value of values) {
    try {
      out.push(toBigIntStrict(value));
    } catch {
      return null;
    }
  }
  return out;
}

export function resolveV2FeeDenominator(meta: unknown = {}, fallback: bigint = DEFAULT_V2_FEE_DENOMINATOR) {
  const metaRecord = asStateRecord(meta);
  const rawDenominator = metaRecord.feeDenominator ?? metaRecord.fee_denominator;
  if (rawDenominator == null) return fallback;

  try {
    const denominator = toBigIntStrict(rawDenominator);
    return denominator > 0n ? denominator : fallback;
  } catch {
    return fallback;
  }
}

export function resolveV2FeeNumerator(
  meta: unknown = {},
  fallback: bigint = DEFAULT_V2_FEE_NUMERATOR,
  denominator: bigint = resolveV2FeeDenominator(meta),
) {
  const metaRecord = asStateRecord(meta);
  const rawFee = metaRecord.feeNumerator ?? metaRecord.fee;
  if (rawFee == null) return fallback;

  try {
    const fee = toBigIntStrict(rawFee);
    return fee > 0n && fee < denominator ? fee : fallback;
  } catch {
    return fallback;
  }
}

export function resolveV3Fee(meta: unknown = {}, fallback: bigint = 3000n) {
  const rawFee = asStateRecord(meta).fee;
  if (rawFee == null) return fallback;

  try {
    const fee = toBigIntStrict(rawFee);
    return fee >= 0n ? fee : fallback;
  } catch {
    return fallback;
  }
}

function optionalNonNegativeBigInt(value: unknown) {
  if (value == null) return null;
  try {
    const normalized = toBigIntStrict(value);
    return normalized >= 0n ? normalized : null;
  } catch {
    return null;
  }
}

// ─── Normalizers ──────────────────────────────────────────────

/**
 * Normalize a V2 pool state.
 *
 * @param {string}   poolAddress  Lowercase pool address
 * @param {string}   protocol     Protocol key
 * @param {string[]} tokens       [token0, token1] lowercase
 * @param {Object}   rawState     From fetchV2PoolState()
 * @param {Object}   [meta]       Registry metadata (fee override, etc.)
 * @returns {Object}  Canonical pool state
 */
export function normalizeV2State(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  // V2 fee: default 997/1000 (0.3%). SushiSwap also 0.3%.
  // Some forks differ — use registry metadata if available.
  const metaRecord = asStateRecord(meta);
  const rawRecord = asStateRecord(rawState);
  const feeDenominator = resolveV2FeeDenominator(meta);
  const feeNumerator = resolveV2FeeNumerator(meta, DEFAULT_V2_FEE_NUMERATOR, feeDenominator);
  const poolId = normalizeStateAddress(poolAddress) ?? "";
  const protocolKey = normalizeProtocolKey(protocol);
  const normalizedTokens = normalizeStateTokenList(tokens);
  const tokenDecimals = normalizeTokenDecimalsList(normalizedTokens, meta);

  return {
    poolId,
    protocol: protocolKey,
    token0: (normalizedTokens[0] || "").toLowerCase(),
    token1: (normalizedTokens[1] || "").toLowerCase(),
    tokens: normalizedTokens,
    tokenDecimals,
    fee: feeNumerator, // 997 = 0.3% fee (out of 1000)
    feeDenominator,
    feeSource:
      metaRecord.feeNumerator != null || metaRecord.fee != null || metaRecord.feeDenominator != null || metaRecord.fee_denominator != null
        ? "metadata"
        : "default",
    reserve0: rawRecord.reserve0,
    reserve1: rawRecord.reserve1,
    blockTimestampLast: rawRecord.blockTimestampLast,
    timestamp: rawRecord.fetchedAt || Date.now(),
  };
}

/**
 * Normalize a V3 pool state.
 *
 * @param {string}   poolAddress  Lowercase pool address
 * @param {string}   protocol     Protocol key
 * @param {string[]} tokens       [token0, token1] lowercase
 * @param {Object}   rawState     From fetchV3PoolState()
 * @param {Object}   [meta]       Registry metadata
 * @returns {Object}  Canonical pool state
 */
export function normalizeV3State(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  const metaRecord = asStateRecord(meta);
  const rawRecord = asStateRecord(rawState);
  const poolId = normalizeStateAddress(poolAddress) ?? "";
  const protocolKey = normalizeProtocolKey(protocol);
  const normalizedTokens = normalizeStateTokenList(tokens);
  const tokenDecimals = normalizeTokenDecimalsList(normalizedTokens, meta);
  const isKyberElastic = rawRecord.isKyberElastic === true || metaRecord.isKyberElastic === true || protocolKey === "KYBERSWAP_ELASTIC";
  const isAlgebra = rawRecord.isAlgebra === true || metaRecord.isAlgebra === true || protocolKey === "QUICKSWAP_V3";
  const swapFeeBps = isKyberElastic
    ? (optionalNonNegativeBigInt(rawRecord.swapFeeBps) ??
      optionalNonNegativeBigInt(metaRecord.swapFeeBps) ??
      optionalNonNegativeBigInt(metaRecord.swapFeeUnits))
    : null;
  const fee =
    rawRecord.fee != null ? toBigIntStrict(rawRecord.fee) : isKyberElastic && swapFeeBps != null ? swapFeeBps * 100n : resolveV3Fee(meta);
  return {
    poolId,
    protocol: protocolKey,
    token0: (normalizedTokens[0] || "").toLowerCase(),
    token1: (normalizedTokens[1] || "").toLowerCase(),
    tokens: normalizedTokens,
    tokenDecimals,
    fee,
    ...(swapFeeBps != null ? { swapFeeBps } : {}),
    feeSource: rawRecord.fee != null ? "rpc" : metaRecord.fee != null || swapFeeBps != null ? "metadata" : "default",
    sqrtPriceX96: rawRecord.sqrtPriceX96,
    tick: rawRecord.tick,
    liquidity: rawRecord.liquidity,
    tickSpacing: rawRecord.tickSpacing,
    isAlgebra,
    isKyberElastic,
    hydrationMode: rawRecord.hydrationMode ?? metaRecord.hydrationMode,
    ticks: rawRecord.ticks || new Map(),
    tickVersion: rawRecord.tickVersion ?? 0,
    initialized: rawRecord.initialized !== false,
    timestamp: rawRecord.fetchedAt || Date.now(),
  };
}

/**
 * Normalize a Curve pool state.
 *
 * @param {string}   poolAddress  Lowercase pool address
 * @param {string}   protocol     Protocol key
 * @param {string[]} tokens       Token addresses
 * @param {Object}   rawState     From poll_curve.js
 * @param {Object}   [meta]       Registry metadata (A, fee, etc.)
 * @returns {Object}  Canonical pool state
 */
export function normalizeCurveState(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  const rawRecord = asStateRecord(rawState);
  const metaRecord = asStateRecord(meta);
  const poolId = normalizeStateAddress(poolAddress) ?? "";
  const protocolKey = normalizeProtocolKey(protocol);
  const normalizedTokens = normalizeStateTokenList(tokens);
  const n = normalizedTokens.length;
  const tokenDecimals = normalizeTokenDecimalsList(normalizedTokens, meta);
  const resolvedDecimals = tokenDecimals.map((d, i) => {
    if (d != null) return d;
    throw new Error(`normalizeCurveState: unknown token decimals for token ${normalizedTokens[i]} in pool ${poolId}`);
  }) as number[];
  const maxDecimals = Math.max(...resolvedDecimals, 18);
  const derivedRates: bigint[] | null = maxDecimals <= 59 ? resolvedDecimals.map((d) => 10n ** BigInt(18 + maxDecimals - d)) : null;

  const rates = normalizeBigIntList(rawRecord.rates, n) ?? derivedRates ?? defaultRates(n);
  const balances = normalizeBigIntList(rawRecord.balances, n) ?? [];
  const A_raw = rawRecord.A != null ? toBigIntOrFallback(rawRecord.A) : null;
  const A =
    A_raw != null
      ? A_raw
      : (() => {
          const metaA = toBigIntOrFallback(metaRecord.A);
          return metaA != null ? metaA : 100n * 100n;
        })();

  return {
    poolId,
    protocol: protocolKey,
    token0: (normalizedTokens[0] || "").toLowerCase(),
    token1: (normalizedTokens[1] || "").toLowerCase(),
    tokens: normalizedTokens,
    fee: rawRecord.fee != null ? toBigIntOrFallback(rawRecord.fee, 4_000_000n) : toBigIntOrFallback(metaRecord.fee, 4_000_000n), // default 0.04% in 1e10
    balances,
    rates,
    tokenDecimals,
    A,
    virtualPrice: toBigIntOrFallback(rawRecord.virtualPrice, 0n),
    timestamp: rawRecord.fetchedAt || Date.now(),
  };
}

/**
 * Normalize a Balancer pool state.
 *
 * @param {string}   poolAddress  Lowercase pool address
 * @param {string}   protocol     Protocol key
 * @param {string[]} tokens       Token addresses
 * @param {Object}   rawState     From poll_balancer.js
 * @param {Object}   [meta]       Registry metadata (weights, swapFee)
 * @returns {Object}  Canonical pool state
 */
export function normalizeBalancerState(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  const rawRecord = asStateRecord(rawState);
  const metaRecord = asStateRecord(meta);
  const poolId = normalizeStateAddress(poolAddress) ?? "";
  const protocolKey = normalizeProtocolKey(protocol);
  const normalizedTokens = normalizeStateTokenList(tokens);
  const poolType = rawRecord.poolType ?? metaRecord.poolType ?? metaRecord.pool_type ?? null;
  const isStable =
    rawRecord.isStable === true || rawRecord.amp != null || (typeof poolType === "string" && poolType.toLowerCase().includes("stable"));

  const weights = Array.isArray(rawRecord.weights)
    ? rawRecord.weights.map((value) => toBigIntOrFallback(value))
    : Array.isArray(metaRecord.weights)
      ? metaRecord.weights.map((value) => toBigIntOrFallback(value))
      : [];
  const swapFee = toBigIntOrFallback(rawRecord.swapFee ?? metaRecord.swapFee, 3_000_000_000_000_000n);
  const balances = Array.isArray(rawRecord.balances) ? rawRecord.balances.map((value) => toBigIntOrFallback(value)) : [];
  const scalingFactors = Array.isArray(rawRecord.scalingFactors)
    ? rawRecord.scalingFactors.map((value) => toBigIntOrFallback(value))
    : Array.isArray(metaRecord.scalingFactors)
      ? metaRecord.scalingFactors.map((value) => toBigIntOrFallback(value))
      : null; // defer to tokenDecimals derivation below
  const tokenDecimals = normalizeTokenDecimalsList(normalizedTokens, meta);

  // Fix #3: derive scalingFactors from tokenDecimals when not provided in state or metadata.
  // Balancer scalingFactor[i] = 10^(18 - decimals[i]) normalizes raw amounts to 18-decimal
  // precision for invariant math. Without this: stable pools fail validatePoolState (empty
  // scalingFactors vs. balances length), and weighted pools return 0 from simulateBalancerSwap.
  const resolvedScalingFactors: bigint[] =
    scalingFactors && scalingFactors.length === normalizedTokens.length
      ? scalingFactors
      : tokenDecimals.map((dec) => {
          if (dec == null) {
            throw new Error(`normalizeBalancerState: unknown token decimals for pool ${poolId}`);
          }
          const d = dec;
          return d <= 18 ? 10n ** BigInt(18 - d) : 1n;
        });

  return {
    poolId,
    balancerPoolId: rawRecord.poolId ?? metaRecord.poolId ?? metaRecord.pool_id ?? null,
    protocol: protocolKey,
    token0: (normalizedTokens[0] || "").toLowerCase(),
    token1: (normalizedTokens[1] || "").toLowerCase(),
    tokens: normalizedTokens,
    tokenDecimals,
    fee: swapFee,
    balances,
    weights,
    scalingFactors: resolvedScalingFactors,
    amp: rawRecord.amp != null ? toBigIntOrFallback(rawRecord.amp) : metaRecord.amp != null ? toBigIntOrFallback(metaRecord.amp) : null,
    ampPrecision:
      rawRecord.ampPrecision != null
        ? toBigIntOrFallback(rawRecord.ampPrecision, 1000n)
        : metaRecord.ampPrecision != null
          ? toBigIntOrFallback(metaRecord.ampPrecision, 1000n)
          : null,
    ampIsUpdating: Boolean(rawRecord.ampIsUpdating ?? metaRecord.ampIsUpdating ?? false),
    swapFee,
    swapFeeSource: rawRecord.swapFee != null ? "rpc" : metaRecord.swapFee != null ? "metadata" : "default",
    poolType,
    isStable,
    bptIndex: rawRecord.bptIndex ?? metaRecord.bptIndex ?? null,
    specialization: rawRecord.specialization ?? metaRecord.specialization ?? null,
    lastChangeBlock: rawRecord.lastChangeBlock != null ? Number(rawRecord.lastChangeBlock) : null,
    timestamp: rawRecord.fetchedAt || Date.now(),
  };
}

/**
 * Normalize a DODO V2 PMM pool state.
 */
export function normalizeDodoState(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  const rawRecord = asStateRecord(rawState);
  const metaRecord = asStateRecord(meta);
  const poolId = normalizeStateAddress(poolAddress) ?? "";
  const protocolKey = normalizeProtocolKey(protocol);
  const fallbackTokens = normalizeStateTokenList(tokens);
  const baseToken = normalizeStateAddress(rawRecord.baseToken ?? metaRecord.baseToken ?? fallbackTokens[0]);
  const quoteToken = normalizeStateAddress(rawRecord.quoteToken ?? metaRecord.quoteToken ?? fallbackTokens[1]);
  const normalizedTokens = baseToken && quoteToken ? [baseToken, quoteToken] : fallbackTokens;
  const tokenDecimals = normalizeTokenDecimalsList(normalizedTokens, meta);

  return {
    poolId,
    protocol: protocolKey,
    token0: (normalizedTokens[0] || "").toLowerCase(),
    token1: (normalizedTokens[1] || "").toLowerCase(),
    tokens: normalizedTokens,
    tokenDecimals,
    fee: toBigIntOrFallback(rawRecord.lpFeeRate) + toBigIntOrFallback(rawRecord.mtFeeRate),
    baseToken: baseToken ?? "",
    quoteToken: quoteToken ?? "",
    baseReserve: toBigIntOrFallback(rawRecord.baseReserve ?? rawRecord.B),
    quoteReserve: toBigIntOrFallback(rawRecord.quoteReserve ?? rawRecord.Q),
    baseTarget: toBigIntOrFallback(rawRecord.baseTarget ?? rawRecord.B0),
    quoteTarget: toBigIntOrFallback(rawRecord.quoteTarget ?? rawRecord.Q0),
    i: toBigIntOrFallback(rawRecord.i),
    k: toBigIntOrFallback(rawRecord.k ?? rawRecord.K),
    rState: Number(rawRecord.rState ?? rawRecord.R ?? 0),
    lpFeeRate: toBigIntOrFallback(rawRecord.lpFeeRate),
    mtFeeRate: toBigIntOrFallback(rawRecord.mtFeeRate),
    feeSource: rawRecord.feeSource ?? metaRecord.feeSource ?? null,
    poolType: metaRecord.poolType ?? metaRecord.pool_type ?? null,
    timestamp: rawRecord.fetchedAt || Date.now(),
  };
}

/**
 * Normalize a WOOFi WooPPV2 singleton state.
 */
export function normalizeWoofiState(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  const rawRecord = asStateRecord(rawState);
  const metaRecord = asStateRecord(meta);
  const poolId = normalizeStateAddress(poolAddress) ?? "";
  const protocolKey = normalizeProtocolKey(protocol);
  const fallbackTokens = normalizeStateTokenList(tokens);
  const quoteToken = normalizeStateAddress(rawRecord.quoteToken ?? metaRecord.quoteToken ?? fallbackTokens[0]);
  const rawBaseTokenStates = asStateRecordOrNull(rawRecord.baseTokenStates);
  const rawBaseStates = Array.isArray(rawRecord.baseStates)
    ? rawRecord.baseStates
    : rawBaseTokenStates
      ? Object.values(rawBaseTokenStates)
      : [];
  const baseStates = new Map<string, StateRecord>();
  const fallbackDecimals = normalizeTokenDecimalsList(fallbackTokens, meta);

  for (const entry of rawBaseStates) {
    const entryRecord = asStateRecord(entry);
    const token = normalizeStateAddress(entryRecord.token ?? entryRecord.baseToken);
    if (!token || token === quoteToken) continue;
    const fallbackIndex = fallbackTokens.indexOf(token);
    const baseDecimals = toNonNegativeInteger(entryRecord.baseDecimals ?? fallbackDecimals[fallbackIndex], 18);
    const quoteDecimals = toNonNegativeInteger(entryRecord.quoteDecimals ?? rawRecord.quoteDecimals ?? fallbackDecimals[0], 18);
    const priceDecimals = toNonNegativeInteger(entryRecord.priceDecimals, 8);
    baseStates.set(token, {
      token,
      reserve: toBigIntOrFallback(entryRecord.reserve),
      feeRate: toBigIntOrFallback(entryRecord.feeRate),
      maxGamma: toBigIntOrFallback(entryRecord.maxGamma),
      maxNotionalSwap: toBigIntOrFallback(entryRecord.maxNotionalSwap),
      price: toBigIntOrFallback(entryRecord.price),
      spread: toBigIntOrFallback(entryRecord.spread),
      coeff: toBigIntOrFallback(entryRecord.coeff),
      feasible: entryRecord.feasible !== false && entryRecord.woFeasible !== false,
      baseDecimals,
      quoteDecimals,
      priceDecimals,
      baseDec: toBigIntOrFallback(entryRecord.baseDec, pow10ForDecimals(baseDecimals)),
      quoteDec: toBigIntOrFallback(entryRecord.quoteDec, pow10ForDecimals(quoteDecimals)),
      priceDec: toBigIntOrFallback(entryRecord.priceDec, pow10ForDecimals(priceDecimals)),
    });
  }

  const normalizedTokens = quoteToken
    ? [
        quoteToken,
        ...fallbackTokens.filter((token) => token !== quoteToken && baseStates.has(token)),
        ...[...baseStates.keys()].filter((token) => !fallbackTokens.includes(token)),
      ]
    : fallbackTokens;
  const dedupedTokens = [...new Set(normalizedTokens)];

  // Build a token→decimals lookup from fallbackTokens so reordering doesn't
  // break decimal mapping when quote token isn't first in fallbackTokens.
  const fallbackDecimalByToken = new Map<string, number>();
  for (let i = 0; i < fallbackTokens.length; i++) {
    const t = fallbackTokens[i];
    const dec = fallbackDecimals[i];
    if (t && dec != null) fallbackDecimalByToken.set(t, dec);
  }
  const tokenDecimals = dedupedTokens.map((token) => {
    if (token === quoteToken) {
      const dec = Number(rawRecord.quoteDecimals ?? fallbackDecimalByToken.get(token) ?? 0);
      if (dec == null) throw new Error(`normalizeWoofiState: unknown quote decimals for pool ${poolId}`);
      return toNonNegativeInteger(rawRecord.quoteDecimals, dec);
    }
    const baseState = baseStates.get(token);
    if (baseState) {
      if (baseState.baseDecimals == null)
        throw new Error(`normalizeWoofiState: unknown base decimals for token ${token} in pool ${poolId}`);
      return toNonNegativeInteger(baseState.baseDecimals, fallbackDecimalByToken.get(token) ?? undefined);
    }
    const dec = fallbackDecimalByToken.get(token);
    if (dec == null) throw new Error(`normalizeWoofiState: unknown decimals for token ${token} in pool ${poolId}`);
    return dec as number;
  });
  const baseTokenStates: Record<string, StateRecord> = Object.fromEntries(baseStates.entries());
  const balances = dedupedTokens.map((token) =>
    token === quoteToken ? toBigIntOrFallback(rawRecord.quoteReserve) : toBigIntOrFallback(baseTokenStates[token]?.reserve),
  );

  const quoteDecimalsValue = rawRecord.quoteDecimals ?? tokenDecimals[0];
  if (quoteDecimalsValue == null) {
    throw new Error(`normalizeWoofiState: unknown quote decimals for pool ${poolId}`);
  }
  return {
    poolId,
    protocol: protocolKey,
    token0: (dedupedTokens[0] || "").toLowerCase(),
    token1: (dedupedTokens[1] || "").toLowerCase(),
    tokens: dedupedTokens,
    tokenDecimals,
    fee: dedupedTokens.slice(1).reduce((max, token) => {
      const feeRate = toBigIntOrFallback(baseTokenStates[token]?.feeRate);
      return feeRate > max ? feeRate : max;
    }, 0n),
    feeDenominator: 100_000n,
    quoteToken: quoteToken ?? "",
    quoteReserve: toBigIntOrFallback(rawRecord.quoteReserve),
    quoteFeeRate: toBigIntOrFallback(rawRecord.quoteFeeRate),
    quoteDecimals: toNonNegativeInteger(quoteDecimalsValue, 18),
    quoteDec: toBigIntOrFallback(rawRecord.quoteDec, pow10ForDecimals(quoteDecimalsValue)),
    wooracle: normalizeStateAddress(rawRecord.wooracle ?? metaRecord.wooracle),
    router: normalizeStateAddress(rawRecord.router ?? metaRecord.router),
    wooPP: normalizeStateAddress(rawRecord.wooPP ?? metaRecord.wooPP ?? poolId),
    baseTokenStates,
    balances,
    timestamp: rawRecord.fetchedAt || Date.now(),
  };
}

// ─── Protocol-aware dispatch ──────────────────────────────────

/**
 * Normalize a pool state into the canonical format.
 *
 * This is the primary entry point used by pollers and the arb loop.
 *
 * @param {string}   poolAddress  Lowercase pool address
 * @param {string}   protocol     Protocol key
 * @param {string[]} tokens       Token addresses
 * @param {Object}   rawState     Raw state from protocol-specific fetcher
 * @param {Object}   [meta]       Registry metadata
 * @returns {Object|null}  Canonical pool state, or null if protocol unknown
 */
export function normalizePoolState(poolAddress: unknown, protocol: unknown, tokens: unknown, rawState: unknown, meta: unknown = {}) {
  if (!rawState) return null;

  const addr = normalizeStateAddress(poolAddress);
  if (!addr) {
    console.warn(`[normalizer] Rejecting invalid pool address for protocol ${protocol}: ${String(poolAddress)}`);
    return null;
  }
  const protocolKey = normalizeProtocolKey(protocol);
  let normalized = null;

  if (V2_PROTOCOLS.has(protocolKey)) {
    normalized = normalizeV2State(addr, protocolKey, tokens, rawState, meta);
  } else if (V3_PROTOCOLS().has(protocolKey)) {
    normalized = normalizeV3State(addr, protocolKey, tokens, rawState, meta);
  } else if (CURVE_PROTOCOLS.has(protocolKey)) {
    normalized = normalizeCurveState(addr, protocolKey, tokens, rawState, meta);
  } else if (BALANCER_PROTOCOLS.has(protocolKey)) {
    normalized = normalizeBalancerState(addr, protocolKey, tokens, rawState, meta);
  } else if (DODO_PROTOCOLS.has(protocolKey)) {
    normalized = normalizeDodoState(addr, protocolKey, tokens, rawState, meta);
  } else if (WOOFI_PROTOCOLS.has(protocolKey)) {
    normalized = normalizeWoofiState(addr, protocolKey, tokens, rawState, meta);
  } else {
    console.warn(`[normalizer] Unknown protocol: ${protocol} for pool ${addr}`);
    return null;
  }

  const verdict = validatePoolState(normalized);
  if (!verdict.valid) {
    console.warn(`[normalizer] Rejecting invalid ${protocolKey} state for pool ${addr}: ${verdict.reason}`);
    return null;
  }

  return normalized;
}

/**
 * Validate that a canonical pool state has the fields required for simulation.
 *
 * @param {Object} state  Canonical pool state
 * @returns {{ valid: boolean, reason?: string }}
 */
type ValidationVerdict = { valid: boolean; reason?: string };

function validationBigInt(value: unknown): bigint | null {
  if (value == null) return null;
  try {
    return toBigIntStrict(value);
  } catch {
    return null;
  }
}

function validationBigIntArray(value: unknown): bigint[] | null {
  if (!Array.isArray(value)) return null;
  const values: bigint[] = [];
  for (const item of value) {
    const normalized = validationBigInt(item);
    if (normalized == null) return null;
    values.push(normalized);
  }
  return values;
}

function positiveBigInt(value: unknown) {
  const normalized = validationBigInt(value);
  return normalized != null && normalized > 0n;
}

function nonNegativeBigInt(value: unknown) {
  const normalized = validationBigInt(value);
  return normalized != null && normalized >= 0n;
}

export function validatePoolState(input: unknown): ValidationVerdict {
  const state = asStateRecordOrNull(input);
  if (!state) return { valid: false, reason: "null state" };

  const poolId = typeof state.poolId === "string" ? state.poolId : "";
  const protocol = typeof state.protocol === "string" ? state.protocol : "";
  const tokenValues = Array.isArray(state.tokens) ? state.tokens : [];
  if (!poolId) return { valid: false, reason: "missing poolId" };
  if (!protocol) return { valid: false, reason: "missing protocol" };
  if (tokenValues.length < 2) return { valid: false, reason: "fewer than 2 tokens" };
  if (normalizeStateAddress(poolId) !== poolId) return { valid: false, reason: "invalid poolId" };

  const tokens: string[] = [];
  const seenTokens = new Set<string>();
  for (const token of tokenValues) {
    const normalizedToken = normalizeStateAddress(token);
    if (normalizedToken == null || normalizedToken !== token) {
      return { valid: false, reason: `invalid token address: ${String(token)}` };
    }
    if (seenTokens.has(normalizedToken)) {
      return { valid: false, reason: `duplicate token: ${String(token)}` };
    }
    seenTokens.add(normalizedToken);
    tokens.push(normalizedToken);
  }

  if (!Number.isFinite(Number(state.timestamp)) || Number(state.timestamp) < 0) return { valid: false, reason: "invalid timestamp" };
  if (Number(state.timestamp) === 0) return { valid: false, reason: "state not yet hydrated" };

  if (V2_PROTOCOLS.has(protocol)) {
    if (tokens.length !== 2) return { valid: false, reason: "V2: token count must be exactly 2" };
    if (state.reserve0 == null || state.reserve1 == null) return { valid: false, reason: "V2: missing reserves" };
    if (!positiveBigInt(state.reserve0) || !positiveBigInt(state.reserve1)) return { valid: false, reason: "V2: zero reserves" };
    const feeDenominator = validationBigInt(state.feeDenominator) ?? DEFAULT_V2_FEE_DENOMINATOR;
    const fee = validationBigInt(state.fee);
    if (feeDenominator <= 0n || fee == null || fee <= 0n || fee >= feeDenominator) return { valid: false, reason: "V2: invalid fee" };
    if (state.token0 && state.token0 !== tokens[0]) return { valid: false, reason: "V2: token0 mismatch" };
    if (state.token1 && state.token1 !== tokens[1]) return { valid: false, reason: "V2: token1 mismatch" };
  } else if (V3_PROTOCOLS().has(protocol)) {
    if (tokens.length !== 2) return { valid: false, reason: "V3: token count must be exactly 2" };
    if (!state.initialized) return { valid: false, reason: "V3: not initialized" };
    const sqrtPriceX96 = validationBigInt(state.sqrtPriceX96);
    if (sqrtPriceX96 == null || sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO)
      return { valid: false, reason: "V3: zero sqrtPrice" };
    if (typeof state.tick !== "number" || !Number.isInteger(state.tick) || state.tick < MIN_TICK || state.tick > MAX_TICK)
      return { valid: false, reason: "V3: invalid tick" };
    const liquidity = validationBigInt(state.liquidity);
    if (liquidity == null || liquidity === 0n) return { valid: false, reason: "V3: zero liquidity" };
    const tickSpacing = typeof state.tickSpacing === "number" ? state.tickSpacing : null;
    if (state.tickSpacing != null && (tickSpacing == null || !Number.isInteger(tickSpacing) || tickSpacing <= 0)) {
      return { valid: false, reason: "V3: invalid tickSpacing" };
    }
    const fee = validationBigInt(state.fee);
    if (fee == null || fee < 0n || fee >= 1_000_000n) return { valid: false, reason: "V3: invalid fee" };
    if (state.token0 && state.token0 !== tokens[0]) return { valid: false, reason: "V3: token0 mismatch" };
    if (state.token1 && state.token1 !== tokens[1]) return { valid: false, reason: "V3: token1 mismatch" };
    if (state.ticks != null && !(state.ticks instanceof Map)) return { valid: false, reason: "V3: ticks must be a Map" };
    if (state.ticks instanceof Map) {
      for (const [tick, data] of state.ticks.entries()) {
        if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
          return { valid: false, reason: "V3: tick entry out of range" };
        }
        if (tickSpacing != null && tickSpacing > 0 && tick % tickSpacing !== 0) {
          return { valid: false, reason: `V3: tick ${tick} misaligned with spacing` };
        }
        const tickData = asStateRecordOrNull(data);
        const liquidityGross = validationBigInt(tickData?.liquidityGross);
        const liquidityNet = validationBigInt(tickData?.liquidityNet);
        if (liquidityGross == null || liquidityGross <= 0n) {
          return { valid: false, reason: `V3: invalid liquidityGross at tick ${tick}` };
        }
        if (liquidityNet == null) {
          return { valid: false, reason: `V3: missing liquidityNet at tick ${tick}` };
        }
        if (liquidityNet > liquidityGross || liquidityNet < -liquidityGross) {
          return { valid: false, reason: `V3: liquidityNet exceeds gross at tick ${tick}` };
        }
      }
    }
  } else if (CURVE_PROTOCOLS.has(protocol)) {
    const balances = validationBigIntArray(state.balances);
    if (!balances || balances.length < 2) return { valid: false, reason: "Curve: missing balances" };
    if (balances.length !== tokens.length) return { valid: false, reason: "Curve: token/balance length mismatch" };
    if (balances.some((balance) => balance <= 0n)) return { valid: false, reason: "Curve: zero balance" };
    if (!positiveBigInt(state.A)) return { valid: false, reason: "Curve: missing A" };
    const rates = validationBigIntArray(state.rates);
    if (!rates || rates.length !== balances.length) return { valid: false, reason: "Curve: invalid rates" };
    if (rates.some((rate) => rate <= 0n)) return { valid: false, reason: "Curve: non-positive rate" };
    const fee = validationBigInt(state.fee);
    if (fee == null || fee < 0n || fee >= 10n ** 10n) return { valid: false, reason: "Curve: invalid fee" };
  } else if (BALANCER_PROTOCOLS.has(protocol)) {
    const balances = validationBigIntArray(state.balances);
    if (!balances || balances.length < 2) return { valid: false, reason: "Balancer: missing balances" };
    if (balances.length !== tokens.length) return { valid: false, reason: "Balancer: token count mismatch" };
    if (balances.some((balance) => balance <= 0n)) return { valid: false, reason: "Balancer: zero balance" };
    const swapFee = validationBigInt(state.swapFee);
    if (swapFee == null || swapFee < 0n || swapFee >= ONE) return { valid: false, reason: "Balancer: invalid swapFee" };
    if (state.isStable === true) {
      if (!positiveBigInt(state.amp)) return { valid: false, reason: "Balancer stable: missing amp" };
      if (!positiveBigInt(state.ampPrecision)) return { valid: false, reason: "Balancer stable: invalid amp precision" };
      const scalingFactors = validationBigIntArray(state.scalingFactors);
      if (!scalingFactors || scalingFactors.length !== balances.length)
        return { valid: false, reason: "Balancer stable: scaling factor length mismatch" };
      if (scalingFactors.some((factor) => factor <= 0n)) return { valid: false, reason: "Balancer stable: non-positive scaling factor" };
    } else {
      const weights = validationBigIntArray(state.weights);
      if (!weights || weights.length < 2) return { valid: false, reason: "Balancer: missing weights" };
      if (balances.length !== weights.length) return { valid: false, reason: "Balancer: balances/weights length mismatch" };
      if (weights.some((weight) => weight <= 0n)) return { valid: false, reason: "Balancer: non-positive weight" };
      if (weights.reduce((sum, weight) => sum + weight, 0n) !== ONE) return { valid: false, reason: "Balancer: weights must sum to 1e18" };
    }
  } else if (DODO_PROTOCOLS.has(protocol)) {
    if (tokens.length !== 2) return { valid: false, reason: "DODO: token count must be exactly 2" };
    if (state.baseToken !== tokens[0] || state.quoteToken !== tokens[1]) return { valid: false, reason: "DODO: base/quote token mismatch" };
    if (state.baseReserve == null || state.quoteReserve == null) return { valid: false, reason: "DODO: missing reserves" };
    if (!positiveBigInt(state.baseReserve) || !positiveBigInt(state.quoteReserve)) return { valid: false, reason: "DODO: zero reserves" };
    if (state.baseTarget == null || state.quoteTarget == null) return { valid: false, reason: "DODO: missing targets" };
    if (!positiveBigInt(state.baseTarget) || !positiveBigInt(state.quoteTarget)) return { valid: false, reason: "DODO: zero targets" };
    if (!positiveBigInt(state.i)) return { valid: false, reason: "DODO: invalid oracle price" };
    const k = validationBigInt(state.k);
    if (k == null || k < 0n || k > ONE) return { valid: false, reason: "DODO: invalid k" };
    if (typeof state.rState !== "number" || !Number.isInteger(state.rState) || state.rState < 0 || state.rState > 2)
      return { valid: false, reason: "DODO: invalid R state" };
    const lpFeeRate = validationBigInt(state.lpFeeRate);
    const mtFeeRate = validationBigInt(state.mtFeeRate);
    if (lpFeeRate == null || mtFeeRate == null) return { valid: false, reason: "DODO: missing fee rates" };
    if (lpFeeRate < 0n || mtFeeRate < 0n || lpFeeRate + mtFeeRate >= ONE) return { valid: false, reason: "DODO: invalid fee rates" };
  } else if (WOOFI_PROTOCOLS.has(protocol)) {
    if (tokens.length < 2) return { valid: false, reason: "WOOFi: token count must be at least 2" };
    if (state.quoteToken !== tokens[0]) return { valid: false, reason: "WOOFi: quote token must be token0" };
    if (!positiveBigInt(state.quoteReserve)) return { valid: false, reason: "WOOFi: invalid quote reserve" };
    const balances = validationBigIntArray(state.balances);
    if (!balances || balances.length !== tokens.length) return { valid: false, reason: "WOOFi: token/balance length mismatch" };
    if (balances.some((balance) => balance <= 0n)) return { valid: false, reason: "WOOFi: zero balance" };
    const baseTokenStates = asStateRecordOrNull(state.baseTokenStates);
    if (!baseTokenStates) return { valid: false, reason: "WOOFi: missing base token states" };
    for (const token of tokens.slice(1)) {
      const base = asStateRecordOrNull(baseTokenStates[token]);
      if (!base) return { valid: false, reason: `WOOFi: missing base state for ${token}` };
      if (!positiveBigInt(base.reserve)) return { valid: false, reason: `WOOFi: invalid reserve for ${token}` };
      if (!positiveBigInt(base.price)) return { valid: false, reason: `WOOFi: invalid price for ${token}` };
      if (base.feasible === false) return { valid: false, reason: `WOOFi: infeasible oracle for ${token}` };
      const spread = validationBigInt(base.spread);
      if (spread == null || spread < 0n || spread >= ONE) return { valid: false, reason: `WOOFi: invalid spread for ${token}` };
      if (!nonNegativeBigInt(base.coeff)) return { valid: false, reason: `WOOFi: invalid coeff for ${token}` };
      const feeRate = validationBigInt(base.feeRate);
      if (feeRate == null || feeRate < 0n || feeRate >= 100_000n) return { valid: false, reason: `WOOFi: invalid fee rate for ${token}` };
      if (!nonNegativeBigInt(base.maxGamma)) return { valid: false, reason: `WOOFi: invalid maxGamma for ${token}` };
      if (!positiveBigInt(base.maxNotionalSwap)) return { valid: false, reason: `WOOFi: invalid maxNotionalSwap for ${token}` };
      if (!positiveBigInt(base.baseDec) || !positiveBigInt(base.quoteDec) || !positiveBigInt(base.priceDec))
        return { valid: false, reason: `WOOFi: invalid decimals for ${token}` };
    }
  }

  return { valid: true };
}

// ─── Protocol sets export ─────────────────────────────────────

export { V2_PROTOCOLS, CURVE_PROTOCOLS, BALANCER_PROTOCOLS, DODO_PROTOCOLS, WOOFI_PROTOCOLS };
export { V3_PROTOCOLS };
