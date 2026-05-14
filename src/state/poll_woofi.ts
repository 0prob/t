/**
 * WOOFi WooPPV2 state poller.
 *
 * WOOFi is a singleton pool with one quote token and many base tokens. Swaps
 * mutate per-token reserves and oracle-posted prices, so refresh the complete
 * singleton state whenever the pool changes.
 */

import { ENRICH_CONCURRENCY } from "../config/index.ts";
import { WOOFI_PROTOCOLS, normalizeProtocolKey } from "../protocols/classification.ts";
import { fetchWoofiPoolState } from "./woofi.ts";
import { normalizeWoofiState } from "./normalizer.ts";
import { metadataWithTokenDecimals } from "./pool_metadata.ts";
import { parsePoolTokens } from "./pool_record.ts";
import {
  asBatchResult,
  TimedPoller,
  type ProtocolPoolRecord,
  type RouteState,
  type RouteStateCache,
  type StatePollerOptions,
  type TokenDecimalsRegistry,
} from "./poller_base.ts";
import { throttledMap } from "../state/enrichment/rpc.ts";

export async function fetchAndNormalizeWoofiPool(
  pool: ProtocolPoolRecord,
  options: { tokenDecimals?: Map<string, number> | null } = {},
): Promise<{ addr: string; normalized: RouteState }> {
  const addr = pool.pool_address.toLowerCase();
  const fallbackTokens = parsePoolTokens(pool.tokens);
  const rawState = await fetchWoofiPoolState(addr, { tokens: fallbackTokens, tokenDecimals: options.tokenDecimals });
  const tokens = Array.isArray(rawState.tokens) && rawState.tokens.length >= 2 ? rawState.tokens : fallbackTokens;
  const metadata = metadataWithTokenDecimals(pool, tokens, options.tokenDecimals);
  const normalized = normalizeWoofiState(addr, pool.protocol, tokens, rawState, metadata) as RouteState;

  return { addr, normalized };
}

export class PollWoofi extends TimedPoller {
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

    const pools = this._registry.getActivePoolsMeta().filter((p) => WOOFI_PROTOCOLS.has(normalizeProtocolKey(p.protocol)));

    if (pools.length === 0) {
      return { updated: 0, failed: 0, durationMs: Date.now() - t0 };
    }

    const results = await throttledMap(
      pools,
      async (pool) => {
        try {
          const tokens = parsePoolTokens(pool.tokens);
          const tokenDecimals = this._registry.getTokenDecimals(tokens);
          const { addr, normalized } = await fetchAndNormalizeWoofiPool(pool, { tokenDecimals });
          return asBatchResult<RouteState>(addr, normalized);
        } catch (err) {
          const addr = pool.pool_address.toLowerCase();
          return asBatchResult<RouteState>(addr, null, err);
        }
      },
      this._concurrency,
    );

    const { updated, failed } = this._storeBatchResults("poll_woofi", this._cache, results, ({ addr, normalized }) => {
      const tokenCount = Array.isArray(normalized.tokens) ? normalized.tokens.length : 0;
      return `[poll_woofi] ${addr} tokens=${tokenCount}`;
    });

    return this._completePass("poll_woofi", t0, updated, failed);
  }

  start(intervalMs = 15_000) {
    this._startLoop("poll_woofi", intervalMs, () => this.poll());
  }
}
