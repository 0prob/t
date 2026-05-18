/**
 * src/state/poll_curve.js — Curve pool balances + virtual price poller
 *
 * Fetches on-chain state for Curve pools:
 *   - balances[] via get_balances() or balances(i)
 *   - virtual_price() for LP token pricing
 *   - A() amplification coefficient
 *   - fee() swap fee
 *
 * Normalizes into the canonical state format and writes to a shared cache.
 *
 * Usage:
 *   import { PollCurve } from "./poll_curve.js";
 *   const poller = new PollCurve(registry, stateCache);
 *   await poller.poll();
 *   poller.start(30_000);
 */

import { readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { normalizeCurveState } from "./normalizer.ts";
import { ENRICH_CONCURRENCY } from "../config/index.ts";
import { parsePoolTokens } from "./pool_record.ts";
import { metadataWithTokenDecimals } from "./pool_metadata.ts";
import {
  asBatchResult,
  TimedPoller,
  type ProtocolPoolRecord,
  type RouteState,
  type RouteStateCache,
  type StatePollerOptions,
  type TokenDecimalsRegistry,
} from "./poller_base.ts";
import { CURVE_PROTOCOLS, normalizeProtocolKey } from "../protocols/classification.ts";

type CurveNumberish = string | number | bigint | boolean;
type CurveBalanceList = ArrayLike<CurveNumberish>;

// ─── ABI fragments ────────────────────────────────────────────

const GET_BALANCES_ABI = [
  {
    name: "get_balances",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[8]" }],
  },
];

const GET_BALANCES_DYN_ABI = [
  {
    name: "get_balances",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
];

// Individual balance query with int128 index (standard Curve stableswap)
const BALANCE_INT128_ABI = () => [
  {
    name: "balances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "i", type: "int128" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Individual balance query with uint256 index (Curve crypto / tricrypto)
const BALANCE_UINT256_ABI = () => [
  {
    name: "balances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Stableswap-ng stored_balances(uint256)
const STORED_BALANCES_ABI = () => [
  {
    name: "stored_balances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "arg0", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const VIRTUAL_PRICE_ABI = [
  {
    name: "get_virtual_price",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const A_ABI = [
  {
    name: "A",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const FEE_ABI = [
  {
    name: "fee",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

type CurveRawStateArgs = {
  balances: bigint[];
  A: bigint;
  fee: bigint;
  virtualPrice: bigint;
  fetchedAt?: number;
};

export function buildCurveRawState({ balances, A, fee, virtualPrice, fetchedAt = Date.now() }: CurveRawStateArgs) {
  return {
    balances,
    A, // Already in A_PRECISION (scaled by 100 in caller)
    fee, // in 1e10
    virtualPrice,
    fetchedAt,
  };
}

// ─── Fetch helpers ────────────────────────────────────────────

/**
 * Fetch Curve pool state for a single pool.
 *
 * @param {string}   poolAddress  Pool contract address
 * @param {number}   nCoins       Number of coins in the pool
 * @returns {Promise<Object>}     Raw Curve state
 */
export async function fetchCurvePoolState(poolAddress: string, nCoins: number) {
  const PRECISION = 10n ** 18n;

  // Try get_balances() variants in parallel, then per-index fallbacks.
  // Parallel race avoids sequential 10s transport timeouts when a method
  // is not supported — the failing calls reject quickly (no-data = no retry)
  // while the working call wins the race.
  let balances: bigint[] = [];
  try {
    const raw = await Promise.any([
      readContractWithRetry<CurveBalanceList>({
        address: poolAddress,
        abi: GET_BALANCES_ABI,
        functionName: "get_balances",
      }).then((r) =>
        Array.from(r as ArrayLike<string | number | bigint | boolean>)
          .slice(0, nCoins)
          .map((value) => BigInt(value)),
      ),
      readContractWithRetry<unknown[]>({
        address: poolAddress,
        abi: GET_BALANCES_DYN_ABI,
        functionName: "get_balances",
      }).then((r) =>
        Array.from(r as ArrayLike<string | number | bigint | boolean>)
          .slice(0, nCoins)
          .map((value) => BigInt(value)),
      ),
    ]);
    balances = raw;
  } catch {
    // All get_balances() variants failed — try per-index balance functions.
    // These are tried sequentially since each call fails quickly (no-data =
    // no retry after Fix #2), and only 2-4 tokens need fetching.
    const fallbackAbis = [BALANCE_INT128_ABI, BALANCE_UINT256_ABI, STORED_BALANCES_ABI];
    for (const makeAbi of fallbackAbis) {
      if (balances.length > 0) break;
      const candidate: bigint[] = [];
      let allOk = true;
      for (let i = 0; i < nCoins; i++) {
        try {
          const b = await readContractWithRetry<CurveNumberish>({
            address: poolAddress,
            abi: makeAbi(),
            functionName: makeAbi()[0].name,
            args: [i],
          });
          candidate.push(BigInt(b));
        } catch {
          allOk = false;
          break;
        }
      }
      if (allOk && candidate.length === nCoins) balances = candidate;
    }
    if (balances.length === 0) {
      throw new Error(`Failed to fetch balances for Curve pool ${poolAddress} via all supported methods`);
    }
  }

  // Fetch A, fee, virtual_price in parallel
  const [AResult, feeResult, virtualPriceResult] = await Promise.allSettled([
    readContractWithRetry<CurveNumberish>({ address: poolAddress, abi: A_ABI, functionName: "A" }),
    readContractWithRetry<CurveNumberish>({ address: poolAddress, abi: FEE_ABI, functionName: "fee" }),
    readContractWithRetry<CurveNumberish>({ address: poolAddress, abi: VIRTUAL_PRICE_ABI, functionName: "get_virtual_price" }),
  ]);

  const A_raw = AResult.status === "fulfilled" ? BigInt(AResult.value) : 100n;
  // Some Curve v2 pools already return A with A_PRECISION (x100) applied.
  // Heuristic: if A > 1e6, assume already scaled (A_PRECISION-ed).
  // Otherwise multiply by 100 to match internal A_PRECISION format.
  const A = A_raw > 1_000_000n ? A_raw : A_raw * 100n;
  const fee = feeResult.status === "fulfilled" ? BigInt(feeResult.value) : 4_000_000n;
  const virtualPrice = virtualPriceResult.status === "fulfilled" ? BigInt(virtualPriceResult.value) : PRECISION;

  return buildCurveRawState({
    balances,
    A,
    fee,
    virtualPrice,
  });
}

export { metadataWithTokenDecimals };

export async function fetchAndNormalizeCurvePool(
  pool: ProtocolPoolRecord,
  options: { tokenDecimals?: Map<string, number> | null } = {},
): Promise<{ addr: string; normalized: RouteState }> {
  const addr = pool.pool_address.toLowerCase();
  const tokens = parsePoolTokens(pool.tokens);
  const nCoins = tokens.length || 2;

  const rawState = await fetchCurvePoolState(addr, nCoins);
  const metadata = metadataWithTokenDecimals(pool, tokens, options.tokenDecimals);
  const normalized = normalizeCurveState(addr, pool.protocol, tokens, rawState, metadata) as RouteState;

  return { addr, normalized };
}

// ─── Poller class ─────────────────────────────────────────────

export class PollCurve extends TimedPoller {
  private _registry: TokenDecimalsRegistry;
  private _cache: RouteStateCache;
  private _concurrency: number;

  constructor(registry: TokenDecimalsRegistry, stateCache: RouteStateCache, options: StatePollerOptions = {}) {
    super(options);
    this._registry = registry;
    this._cache = stateCache;
    this._concurrency = options.concurrency ?? ENRICH_CONCURRENCY;
  }

  async poll() {
    const t0 = Date.now();

    const pools = this._registry.getActivePoolsMeta().filter((p) => CURVE_PROTOCOLS.has(normalizeProtocolKey(p.protocol)));

    if (pools.length === 0) {
      return { updated: 0, failed: 0, durationMs: Date.now() - t0 };
    }

    const results = await throttledMap(
      pools,
      async (pool) => {
        try {
          const tokens = parsePoolTokens(pool.tokens);
          const tokenDecimals = this._registry.getTokenDecimals(tokens);
          const { addr, normalized } = await fetchAndNormalizeCurvePool(pool, { tokenDecimals });
          return asBatchResult<RouteState>(addr, normalized);
        } catch (err: unknown) {
          const addr = pool.pool_address.toLowerCase();
          return asBatchResult<RouteState>(addr, null, err);
        }
      },
      this._concurrency,
      120_000, // timeout per pool to prevent stuck concurrency slots
    );

    const { updated, failed } = this._storeBatchResults("poll_curve", this._cache, results, ({ addr, normalized }) => {
      return `[poll_curve] ${addr} A=${normalized.A} balances=${normalized.balances}`;
    });

    return this._completePass("poll_curve", t0, updated, failed);
  }

  start(intervalMs = 30_000) {
    this._startLoop("poll_curve", intervalMs, () => this.poll());
  }
}
