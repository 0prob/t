
/**
 * src/profit/price_oracle.js — Token-to-MATIC price oracle
 *
 * Provides real-time exchange rates between tokens and the native MATIC token.
 * Used to convert gas costs (in MATIC wei) into the start-token's raw units
 * for accurate net-profit calculation in compute.js.
 *
 * Rate semantics
 * ──────────────
 * Every stored rate answers: "how many MATIC wei is ONE RAW TOKEN UNIT worth?"
 *
 *   token     decimals  1 full token   1 raw unit
 *   ─────────────────────────────────────────────
 *   WMATIC       18     ≈ 1 MATIC      = 1 wei MATIC        → rate = 1
 *   USDC          6     ≈ 1 MATIC      = 1e12 wei MATIC     → rate = 1e12
 *   USDT          6     ≈ 1 MATIC      = 1e12 wei MATIC     → rate = 1e12
 *   WETH         18     ≈ 2500 MATIC   = 2500 wei MATIC     → rate = 2500
 *   DAI          18     ≈ 1 MATIC      = 1 wei MATIC        → rate = 1
 *
 * Usage (compute.js):
 *   gasCostInStartTokenUnits = gasCostWei / rate(startToken)
 *
 * Example — USDC start-token, gasCostWei = 2e16 (≈ 0.02 MATIC at 50 gwei):
 *   gasCostInTokens = 2e16 / 1e12 = 20_000 USDC units = 0.02 USDC ✓
 */

import { logger } from "../utils/logger.ts";
import { getPoolTokens } from "../utils/pool_record.ts";
import type { RouteState } from "../routing/simulation_types.ts";

const RATE_SCALE = 10n ** 18n;

/** Q96 / Q192 constants for Uniswap V3 price decoding */
const Q192 = 2n ** 192n;

/**
 * Common anchor tokens on Polygon (Chain 137)
 */
export const TOKENS = {
  WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  USDC:   "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",  // USDC.e (bridged)
  USDC_N: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",  // USDC (native)
  USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
  WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
};

type PoolMetaLike = {
  tokens?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

type TokenMetaLike = {
  decimals?: unknown;
};

export type PriceOracleRegistry = {
  getPoolMeta: (poolAddress: string) => PoolMetaLike | null | undefined;
  getTokenMeta?: (tokenAddress: string) => TokenMetaLike | null | undefined;
};

/**
 * Fallback decimals for well-known Polygon tokens.
 * Used when the registry hasn't yet indexed a token's metadata.
 */
const KNOWN_DECIMALS = new Map([
  [TOKENS.WMATIC, 18],
  [TOKENS.USDC,   6],
  [TOKENS.USDC_N, 6],
  [TOKENS.USDT,   6],
  [TOKENS.WETH,   18],
  [TOKENS.DAI,    18],
  [TOKENS.WBTC,   8],
]);

const PIVOT_TOKENS = [
  TOKENS.USDC_N,
  TOKENS.USDC,
  TOKENS.USDT,
  TOKENS.DAI,
  TOKENS.WETH,
  TOKENS.WBTC,
];

type PoolQuote = {
  base: string;
  quote: string;
  scaledRate: bigint;
  updatedAt: number;
};

type PairQuote = {
  scaledRate: bigint;
  updatedAt: number;
};

export class PriceOracle {
  private _cache: ReadonlyMap<string, RouteState>;
  private _registry: PriceOracleRegistry;
  private _updatedAt: number;
  private _updatedAtByToken: Map<string, number>;
  private _poolMeta: Map<string, PoolMetaLike>;
  private _poolQuotes: Map<string, PoolQuote[]>;
  private _pairQuoteSources: Map<string, Map<string, Map<string, PairQuote>>>;
  private _pairQuotes: Map<string, Map<string, PairQuote>>;
  private _rates: Map<string, bigint>;

  constructor(stateCache: ReadonlyMap<string, RouteState>, registry: PriceOracleRegistry) {
    this._cache    = stateCache;
    this._registry = registry;
    this._updatedAt = 0;
    this._updatedAtByToken = new Map();
    this._poolMeta = new Map();
    this._poolQuotes = new Map();
    this._pairQuoteSources = new Map();
    this._pairQuotes = new Map();
    this._rates = new Map();
    this._setDefaults();
  }

  _setDefaults() {
    // Fallback rates used before live pool data is available.
    // Semantics: rate = MATIC_wei per 1 raw token unit (smallest on-chain unit).
    //
    //   token     dec   formula                              rate
    //   ───────────────────────────────────────────────────────────────────
    //   WMATIC     18   1 wei WMATIC = 1 wei MATIC           → 1
    //   USDC        6   1 USDC ≈ 1 MATIC; 1 unit = 1e-6     → 1e18/1e6 = 1e12
    //   USDC_N      6   same as USDC                         → 1e12
    //   USDT        6   same as USDC                         → 1e12
    //   WETH       18   1 ETH ≈ 2500 MATIC; 1 wei = 1e-18   → 2500e18/1e18 = 2500
    //   DAI        18   1 DAI ≈ 1 MATIC; 1 wei = 1e-18      → 1e18/1e18 = 1
    //   WBTC        8   1 BTC ≈ 60,000 MATIC; 1 sat = 1e-8  → 60000e18/1e8 = 6e14
    //
    // Fix #4: WBTC was 600_000 (6e5) — off by 1e9. Gas cost in WBTC appeared as
    // ~1 billion sats, causing all WBTC-start candidates to fail profitability.
    // The correct value is 60_000 * 1e18 / 1e8 = 6e14 = 600_000_000_000_000.
    //
    // These are conservative estimates. update() replaces them with live prices.
    this._rates.set(TOKENS.WMATIC, 1n);
    this._rates.set(TOKENS.USDC,   1_000_000_000_000n);  // 1e12
    this._rates.set(TOKENS.USDC_N, 1_000_000_000_000n);  // 1e12
    this._rates.set(TOKENS.USDT,   1_000_000_000_000n);  // 1e12
    this._rates.set(TOKENS.WETH,   2_500n);               // 1 wei WETH ≈ 2500 wei MATIC
    this._rates.set(TOKENS.DAI,    1n);                   // 1 wei DAI  ≈ 1 wei MATIC
    this._rates.set(TOKENS.WBTC,   600_000_000_000_000n); // 6e14: 1 sat ≈ 6e14 wei MATIC
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Update rates from live pool state.
   *
   * Scans the state cache for WMATIC/-adjacent pairs and derives
   * decimal-adjusted prices. Prefers V2 pools (lower state complexity);
   * updates only improve on previous rate (never zeroes it out).
   */
  update(changedPools?: Iterable<string>) {
    const now = Date.now();
    let updatedCount = 0;
    let inspectedCount = 0;
    const nextRates = new Map<string, bigint>();
    const nextUpdatedAtByToken = new Map<string, number>();

    if (!changedPools) {
      this._poolQuotes.clear();
      this._clearPairQuoteIndexes();
    }

    // WMATIC is always 1:1 with MATIC (rate = 1)
    nextRates.set(TOKENS.WMATIC, 1n);
    nextUpdatedAtByToken.set(TOKENS.WMATIC, now);

    const entries = changedPools
      ? [...changedPools].map((addr) => [addr.toLowerCase(), this._cache.get(addr.toLowerCase())] as const)
      : this._cache.entries();

    for (const [addr, state] of entries) {
      if (!state) {
        this._replacePoolQuotes(addr, []);
        continue;
      }
      let pool = this._poolMeta.get(addr);
      if (!pool) {
        const registryPool = this._registry.getPoolMeta(addr);
        if (registryPool) {
          pool = registryPool;
          this._poolMeta.set(addr, pool);
        }
      }
      if (!pool) {
        this._replacePoolQuotes(addr, []);
        continue;
      }

      const tokens = getPoolTokens(pool);
      if (!tokens || tokens.length !== 2) {
        this._replacePoolQuotes(addr, []);
        continue;
      }
      inspectedCount++;

      const t0 = tokens[0].toLowerCase();
      const t1 = tokens[1].toLowerCase();
      const isWmatic0 = t0 === TOKENS.WMATIC;
      const isWmatic1 = t1 === TOKENS.WMATIC;
      const quote01 = this._deriveQuoteRateScaled(state, true);
      const quote10 = this._deriveQuoteRateScaled(state, false);
      const stateUpdatedAt = this._getStateUpdatedAt(state, now);
      this._replacePoolQuotes(addr, [
        { base: t0, quote: t1, scaledRate: quote01, updatedAt: stateUpdatedAt },
        { base: t1, quote: t0, scaledRate: quote10, updatedAt: stateUpdatedAt },
      ]);

      if (isWmatic0) {
        const rate = this._scaledRateToWei(quote10);
        if (rate > 0n) {
          this._storeRateCandidate(nextRates, nextUpdatedAtByToken, t1, rate, stateUpdatedAt);
          updatedCount++;
        }
        continue;
      }
      if (isWmatic1) {
        const rate = this._scaledRateToWei(quote01);
        if (rate > 0n) {
          this._storeRateCandidate(nextRates, nextUpdatedAtByToken, t0, rate, stateUpdatedAt);
          updatedCount++;
        }
      }
    }

    const preferredPivotOrder = new Map(PIVOT_TOKENS.map((token, index) => [token, index]));

    for (const [token, quotes] of this._pairQuotes.entries()) {
      if (token === TOKENS.WMATIC) continue;

      let bestDerived = 0n;
      let bestUpdatedAt = 0;
      const candidatePivots = [...quotes.keys()].sort((a, b) => {
        const aOrder = preferredPivotOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = preferredPivotOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.localeCompare(b);
      });

      for (const pivot of candidatePivots) {
        const quoteToPivot = quotes.get(pivot);
        const pivotRate = nextRates.get(pivot) ?? this._rates.get(pivot) ?? 0n;
        const pivotUpdatedAt = nextUpdatedAtByToken.get(pivot) ?? this._updatedAtByToken.get(pivot) ?? 0;
        if (!quoteToPivot || quoteToPivot.scaledRate <= 0n || pivotRate <= 0n || pivotUpdatedAt <= 0) continue;

        const derived = this._pivotQuoteToWei(quoteToPivot.scaledRate, pivotRate);
        if (derived <= 0n) continue;

        const derivedUpdatedAt = Math.min(quoteToPivot.updatedAt, pivotUpdatedAt);
        if (
          derivedUpdatedAt > bestUpdatedAt ||
          (derivedUpdatedAt === bestUpdatedAt && (bestDerived === 0n || derived < bestDerived))
        ) {
          bestDerived = derived;
          bestUpdatedAt = derivedUpdatedAt;
        }
      }

      if (bestDerived > 0n && bestUpdatedAt > 0) {
        nextRates.set(token, bestDerived);
        nextUpdatedAtByToken.set(token, bestUpdatedAt);
        updatedCount++;
      }
    }

    for (const [token, rate] of this._rates.entries()) {
      if (nextRates.has(token) || rate <= 0n) continue;
      nextRates.set(token, rate);
    }
    for (const [token, updatedAt] of this._updatedAtByToken.entries()) {
      if (nextUpdatedAtByToken.has(token) || updatedAt <= 0) continue;
      nextUpdatedAtByToken.set(token, updatedAt);
    }

    this._rates = nextRates;
    this._updatedAtByToken = nextUpdatedAtByToken;

    this._updatedAt = this._maxUpdatedAt(nextUpdatedAtByToken, now, updatedCount > 0 || !changedPools || inspectedCount > 0);
    if (updatedCount > 0) {
      logger.debug(`[price_oracle] Updated ${updatedCount} rates from state cache`);
    }

    return updatedCount;
  }

  /**
   * Get the rate for a token address.
   *
   * @param {string} tokenAddress  Lowercase token address
   * @returns {bigint}  MATIC wei per 1 raw token unit (0 if unknown)
   */
  getRate(tokenAddress: string) {
    return this._rates.get(tokenAddress.toLowerCase()) ?? 0n;
  }

  getFreshRate(tokenAddress: string, maxAgeMs = 30_000) {
    const key = tokenAddress.toLowerCase();
    const updatedAt = this._updatedAtByToken.get(key) ?? 0;
    if (updatedAt <= 0 || Date.now() - updatedAt > maxAgeMs) {
      return 0n;
    }
    return this._rates.get(key) ?? 0n;
  }

  /**
   * Get the best available rate: fresh if within maxAgeMs, otherwise
   * fall back to any cached rate within staleFallbackMs. This prevents
   * transient oracle gaps from blocking execution while still rejecting
   * tokens with no history at all.
   */
  getFreshWithStaleFallback(tokenAddress: string, maxAgeMs = 30_000, staleFallbackMs = 300_000) {
    const key = tokenAddress.toLowerCase();
    const freshRate = this.getFreshRate(tokenAddress, maxAgeMs);
    if (freshRate > 0n) return freshRate;
    // Fall back to any cached rate within the stale window
    const updatedAt = this._updatedAtByToken.get(key) ?? 0;
    if (updatedAt > 0 && Date.now() - updatedAt <= staleFallbackMs) {
      return this._rates.get(key) ?? 0n;
    }
    return 0n;
  }

  isFresh(maxAgeMs = 30_000) {
    return this._updatedAt > 0 && Date.now() - this._updatedAt <= maxAgeMs;
  }

  /**
   * Convert an amount of token (in raw units) to MATIC wei.
   *
   * @param {string} tokenAddress
   * @param {bigint} amount  Raw token units (e.g. USDC in 1e-6 units)
   * @returns {bigint}  MATIC wei equivalent
   */
  toMatic(tokenAddress: string, amount: bigint) {
    const rate = this.getRate(tokenAddress);
    if (rate === 0n || amount === 0n) return 0n;
    return amount * rate;
  }

  /**
   * Convert a MATIC wei amount to raw token units.
   *
   * Used by compute.js to convert gas costs into start-token units.
   *
   * @param {string} tokenAddress
   * @param {bigint} maticWei
   * @returns {bigint}  Raw token units (floor division)
   */
  fromMatic(tokenAddress: string, maticWei: bigint) {
    const rate = this.getRate(tokenAddress);
    if (rate === 0n || maticWei === 0n) {
      if (maticWei > 0n) {
        console.warn(`[price_oracle] Zero rate for ${tokenAddress} — cannot convert ${maticWei} wei MATIC to token units`);
      }
      return 0n;
    }
    return maticWei / rate;
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Resolve token decimals.
   * Checks: known fallback table → registry token_meta.
   *
   * @param {string} tokenAddress  Lowercase address
   * @returns {number|null}
   */
  _getDecimals(tokenAddress: string) {
    if (KNOWN_DECIMALS.has(tokenAddress)) {
      return KNOWN_DECIMALS.get(tokenAddress);
    }
    const meta = this._registry.getTokenMeta?.(tokenAddress);
    const decimals = Number(meta?.decimals);
    if (Number.isSafeInteger(decimals) && decimals >= 0) return decimals;
    return null;
  }

  /**
   * Derive rate from a pool state snapshot.
   *
   * Rate = "how many MATIC wei is 1 raw unit of `otherToken` worth?"
   *
   * For a WMATIC/Token pool:
   *   V2:  rateRaw = r_wmatic / r_token   (raw reserves ratio)
   *   V3:  rateRaw derived from sqrtPriceX96
   *
   * Then adjust for decimal difference:
   *   If WMATIC is token0 and Token is token1 (18 dec each):
   *     1 raw token unit = r0/r1 raw WMATIC units = r0/r1 wei MATIC  → no decimal adjustment needed
   *   If WMATIC is token0 (18 dec) and Token is token1 (6 dec, USDC):
   *     Reserves in raw units: r0 (wei) and r1 (1e-6 USDC)
   *     1 raw USDC unit = r0 / r1 raw WMATIC units = r0/r1 wei MATIC
   *     Example: r0 = 500k * 1e18, r1 = 500k * 1e6
   *       1 USDC unit = (500k * 1e18) / (500k * 1e6) = 1e12 wei MATIC ✓
   *   No separate decimal adjustment is needed — the raw reserve ratio
   *   already captures the decimal difference because r0 and r1 are
   *   stored in their respective token's raw units.
   *
   * @param {Object}  state        Canonical pool state
   * @param {boolean} isWmatic0    True if WMATIC is token0
   * @param {number}  _otherDec    Decimals of the other token (unused — for docs)
   * @returns {bigint}  Rate or 0n if not derivable
   */
  _clearPairQuoteIndexes() {
    this._pairQuoteSources.clear();
    this._pairQuotes.clear();
  }

  _replacePoolQuotes(poolAddress: string, quotes: PoolQuote[]) {
    this._removePoolPairQuotes(poolAddress);
    if (quotes.length === 0) return;
    this._poolQuotes.set(poolAddress, quotes);
    for (const quote of quotes) this._addPoolPairQuote(poolAddress, quote);
  }

  _removePoolPairQuotes(poolAddress: string) {
    const previousQuotes = this._poolQuotes.get(poolAddress);
    if (!previousQuotes) return;
    this._poolQuotes.delete(poolAddress);
    for (const quote of previousQuotes) {
      const baseKey = quote.base.toLowerCase();
      const quoteKey = quote.quote.toLowerCase();
      const poolQuotes = this._pairQuoteSources.get(baseKey)?.get(quoteKey);
      poolQuotes?.delete(poolAddress);
      this._recomputeBestPairQuote(baseKey, quoteKey);
    }
  }

  _addPoolPairQuote(poolAddress: string, quote: PoolQuote) {
    if (quote.scaledRate <= 0n || quote.updatedAt <= 0) return;
    const baseKey = quote.base.toLowerCase();
    const quoteKey = quote.quote.toLowerCase();
    let quotesByQuote = this._pairQuoteSources.get(baseKey);
    if (!quotesByQuote) {
      quotesByQuote = new Map();
      this._pairQuoteSources.set(baseKey, quotesByQuote);
    }
    let quotesByPool = quotesByQuote.get(quoteKey);
    if (!quotesByPool) {
      quotesByPool = new Map();
      quotesByQuote.set(quoteKey, quotesByPool);
    }
    quotesByPool.set(poolAddress, { scaledRate: quote.scaledRate, updatedAt: quote.updatedAt });
    this._recomputeBestPairQuote(baseKey, quoteKey);
  }

  _recomputeBestPairQuote(baseKey: string, quoteKey: string) {
    const quotesByQuote = this._pairQuoteSources.get(baseKey);
    const quotesByPool = quotesByQuote?.get(quoteKey);
    let best: PairQuote | null = null;
    if (quotesByPool) {
      for (const quote of quotesByPool.values()) {
        if (
          !best ||
          quote.updatedAt > best.updatedAt ||
          (quote.updatedAt === best.updatedAt && quote.scaledRate < best.scaledRate)
        ) {
          best = quote;
        }
      }
    }

    if (best) {
      let pairQuotes = this._pairQuotes.get(baseKey);
      if (!pairQuotes) {
        pairQuotes = new Map();
        this._pairQuotes.set(baseKey, pairQuotes);
      }
      pairQuotes.set(quoteKey, { scaledRate: best.scaledRate, updatedAt: best.updatedAt });
      return;
    }

    quotesByQuote?.delete(quoteKey);
    if (quotesByQuote?.size === 0) this._pairQuoteSources.delete(baseKey);
    const pairQuotes = this._pairQuotes.get(baseKey);
    pairQuotes?.delete(quoteKey);
    if (pairQuotes?.size === 0) this._pairQuotes.delete(baseKey);
  }

  _storePairQuote(pairQuotes: Map<string, Map<string, PairQuote>>, quote: PoolQuote) {
    if (quote.scaledRate <= 0n || quote.updatedAt <= 0) return;
    const baseKey = quote.base.toLowerCase();
    const quoteKey = quote.quote.toLowerCase();
    if (!pairQuotes.has(baseKey)) pairQuotes.set(baseKey, new Map());
    const quotes = pairQuotes.get(baseKey)!;
    const existing = quotes.get(quoteKey);
    if (
      !existing ||
      quote.updatedAt > existing.updatedAt ||
      (quote.updatedAt === existing.updatedAt && quote.scaledRate < existing.scaledRate)
    ) {
      quotes.set(quoteKey, {
        scaledRate: quote.scaledRate,
        updatedAt: quote.updatedAt,
      });
    }
  }

  _storeRateCandidate(
    rates: Map<string, bigint>,
    updatedAtByToken: Map<string, number>,
    tokenAddress: string,
    rate: bigint,
    updatedAt: number,
  ) {
    if (rate <= 0n || updatedAt <= 0) return;
    const key = tokenAddress.toLowerCase();
    const existingRate = rates.get(key);
    const existingUpdatedAt = updatedAtByToken.get(key) ?? 0;
    if (
      existingRate == null ||
      updatedAt > existingUpdatedAt ||
      (updatedAt === existingUpdatedAt && rate < existingRate)
    ) {
      rates.set(key, rate);
      updatedAtByToken.set(key, updatedAt);
    }
  }

  _scaledRateToWei(rateScaled: bigint) {
    if (rateScaled <= 0n) return 0n;
    const floored = rateScaled / RATE_SCALE;
    return floored > 0n ? floored : 1n;
  }

  _pivotQuoteToWei(quoteToPivotScaled: bigint, pivotRateWei: bigint) {
    if (quoteToPivotScaled <= 0n || pivotRateWei <= 0n) return 0n;
    const floored = (quoteToPivotScaled * pivotRateWei) / RATE_SCALE;
    return floored > 0n ? floored : 1n;
  }

  _getStateUpdatedAt(state: RouteState, fallbackNow: number) {
    const ts = Number(state?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts : fallbackNow;
  }

  _maxUpdatedAt(updatedAtByToken: Map<string, number>, fallbackNow: number, touched: boolean) {
    let maxUpdatedAt = 0;
    for (const updatedAt of updatedAtByToken.values()) {
      if (updatedAt > maxUpdatedAt) maxUpdatedAt = updatedAt;
    }
    if (maxUpdatedAt > 0) return maxUpdatedAt;
    return touched ? fallbackNow : this._updatedAt;
  }

  _stateBigInt(state: RouteState, key: string) {
    const value = state[key];
    if (value == null) return null;
    if (typeof value === "bigint") return value;
    if (typeof value === "number" || typeof value === "string") {
      try {
        return BigInt(value);
      } catch {
        return null;
      }
    }
    return null;
  }

  _deriveQuoteRateScaled(state: RouteState, token0AsBase: boolean) {
    try {
      // ── Uniswap V2 ──────────────────────────────────────────
      const r0 = this._stateBigInt(state, "reserve0");
      const r1 = this._stateBigInt(state, "reserve1");
      if (r0 != null && r1 != null) {
        if (r0 === 0n || r1 === 0n) return 0n;

        return token0AsBase
          ? (r1 * RATE_SCALE) / r0
          : (r0 * RATE_SCALE) / r1;
      }

      // ── Uniswap V3 ──────────────────────────────────────────
      // sqrtPriceX96 encodes: sqrt(rawToken1 / rawToken0) * 2^96
      // priceX192 = rawToken1 / rawToken0  (as a Q192 fixed-point integer)
      const sqrtP = this._stateBigInt(state, "sqrtPriceX96");
      if (sqrtP != null) {
        if (sqrtP === 0n) return 0n;
        const priceX192 = sqrtP * sqrtP; // = (token1/token0) * 2^192

        return token0AsBase
          ? (priceX192 * RATE_SCALE) / Q192
          : (Q192 * RATE_SCALE) / priceX192;
      }
    } catch {
      return 0n;
    }
    return 0n;
  }
}
