/**
 * src/config/index.ts — Centralized configuration
 *
 * Single source of truth for all environment variables, constants,
 * and tunable parameters. Every other module imports from here.
 *
 * Parameter resolution order (highest wins):
 *   1. Environment variables (UPPERCASE names)
 *   2. data/perf.json  (written by scripts/tune_performance.ts)
 *   3. Built-in defaults  (safe conservative values)
 *
 * Run `pnpm tune:performance` once after deployment to generate
 * data/perf.json with machine-optimal values.
 */

import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { computeResourceTunedRunParameters } from "../app/resource_tuning.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Paths ─────────────────────────────────────────────────────

/** Project root (two levels up from src/config/) */
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Runtime data directory (SQLite DB, snapshots, perf.json) */
export const DATA_DIR = path.join(PROJECT_ROOT, "data");

/** SQLite database path */
export const DB_PATH = path.join(DATA_DIR, "registry.db");

// ─── Auto-tuned parameter loader ──────────────────────────────
//
// Reads data/perf.json if it exists.  The file is produced by
// `pnpm tune:performance` and contains optimal values
// for the current machine.  Env vars always override these values.

function _loadPerfJson() {
  try {
    const p = path.join(DATA_DIR, "perf.json");
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")).params || {};
    }
  } catch {
    /* ignore parse errors */
  }
  return {};
}

const _perf = _loadPerfJson();

/**
 * Resolve a numeric parameter.
 * Priority: env var → perf.json → built-in default.
 *
 * @param {string} envKey   Environment variable name
 * @param {string} perfKey  Key inside perf.json params object
 * @param {number} def      Built-in default
 */
function _parseSafeNonNegativeConfigNumber(raw: unknown) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function _numFloat(envKey: string, perfKey: string, def: number): number {
  const raw = process.env[envKey];
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    console.warn(`[config] Invalid numeric env ${envKey}=${raw} — using fallback`);
  }
  if (_perf[perfKey] != null) {
    const n = Number(_perf[perfKey]);
    if (Number.isFinite(n) && n >= 0) return n;
    console.warn(`[config] Invalid numeric perf.json value for ${perfKey}=${_perf[perfKey]} — using fallback`);
  }
  return def;
}

function _bigint(envKey: string, perfKey: string, def: bigint): bigint {
  const raw = process.env[envKey];
  if (raw != null && raw !== "") {
    try {
      return BigInt(raw);
    } catch {
      console.warn(`[config] Invalid bigint env ${envKey}=${raw} — using fallback`);
    }
  }
  if (_perf[perfKey] != null) {
    try {
      return BigInt(_perf[perfKey]);
    } catch {
      console.warn(`[config] Invalid bigint perf.json value for ${perfKey}=${_perf[perfKey]} — using fallback`);
    }
  }
  return def;
}

function _num(envKey: string, perfKey: string, def: number): number {
  if (process.env[envKey] != null && process.env[envKey] !== "") {
    const n = _parseSafeNonNegativeConfigNumber(process.env[envKey]);
    if (n != null) return n;
    console.warn(`[config] Invalid numeric env ${envKey}=${process.env[envKey]} — using fallback`);
  }
  if (_perf[perfKey] != null) {
    const n = _parseSafeNonNegativeConfigNumber(_perf[perfKey]);
    if (n != null) return n;
    console.warn(`[config] Invalid numeric perf.json value for ${perfKey}=${_perf[perfKey]} — using fallback`);
  }
  return def;
}

function _port(envKey: string, perfKey: string, def: number): number {
  const value = _num(envKey, perfKey, def);
  if (value <= 65_535) return value;
  console.warn(`[config] Invalid port ${envKey}=${value} — using fallback ${def}`);
  return def;
}

function _addressList(envKey: string): string[] {
  const raw = process.env[envKey] || "";
  if (!raw) return [];
  const addresses: string[] = [];
  for (const entry of raw.split(",")) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    if (/^0x[0-9a-f]{40}$/.test(normalized)) {
      addresses.push(normalized);
      continue;
    }
    console.warn(`[config] Invalid address entry in ${envKey}=${entry.trim()} — ignoring`);
  }
  return addresses;
}

function _routingCycleMode(envKey: string, def: "all" | "triangular"): "all" | "triangular" {
  const raw = (process.env[envKey] || "").trim().toLowerCase();
  if (!raw) return def;
  if (raw === "all" || raw === "triangular") return raw;
  console.warn(`[config] Invalid routing cycle mode ${envKey}=${process.env[envKey]} — using fallback`);
  return def;
}

function _optionalBool(envKey: string): boolean | null {
  const raw = (process.env[envKey] || "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on", "enabled", "enable"].includes(raw)) return true;
  if (["0", "false", "no", "off", "disabled", "disable"].includes(raw)) return false;
  console.warn(`[config] Invalid boolean env ${envKey}=${process.env[envKey]} — using fallback`);
  return null;
}

function _bool(envKey: string, def: boolean): boolean {
  return _optionalBool(envKey) ?? def;
}

// ─── HyperSync ─────────────────────────────────────────────────

function withEnvioToken(rawUrl: string, token: string) {
  if (!rawUrl || !token) return rawUrl;

  try {
    const url = new URL(rawUrl);
    const isHostedHypersync =
      url.protocol.startsWith("http") && (url.hostname.endsWith(".hypersync.xyz") || url.hostname === "hypersync.xyz");

    if (!isHostedHypersync) return rawUrl;
    if (url.username || url.password) return rawUrl;
    if (url.searchParams.has("api_key") || url.searchParams.has("apiKey") || url.searchParams.has("token")) {
      return rawUrl;
    }

    return `${url.protocol}//${encodeURIComponent(token)}@${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl;
  }
}

// Direct HyperSync streaming endpoint — used by the StateWatcher native client.
// Uses its own binary protocol, not standard JSON-RPC.
export const HYPERSYNC_URL = process.env.HYPERSYNC_URL || "https://polygon.hypersync.xyz";

export const ENVIO_API_TOKEN = process.env.ENVIO_API_TOKEN || "";

/** Prometheus metrics server port. Use 0 for an ephemeral local port. */
export const METRICS_PORT = _port("METRICS_PORT", "METRICS_PORT", 9090);

/** Enable V3-family protocols: Uniswap V3, SushiSwap V3, QuickSwap V3, Kyber Elastic. */
export const ENABLE_V3_PROTOCOLS = _bool("ENABLE_V3_PROTOCOLS", true);

/** Native HyperSync HTTP timeout in milliseconds. */
export const HYPERSYNC_HTTP_REQ_TIMEOUT_MS = _num("HYPERSYNC_HTTP_REQ_TIMEOUT_MS", "HYPERSYNC_HTTP_REQ_TIMEOUT_MS", 30_000);

/** Native HyperSync request retry count. */
export const HYPERSYNC_MAX_RETRIES = _num("HYPERSYNC_MAX_RETRIES", "HYPERSYNC_MAX_RETRIES", 6);

/** Native HyperSync retry backoff increment in milliseconds. */
export const HYPERSYNC_RETRY_BACKOFF_MS = _num("HYPERSYNC_RETRY_BACKOFF_MS", "HYPERSYNC_RETRY_BACKOFF_MS", 500);

/** Native HyperSync initial retry delay in milliseconds. */
export const HYPERSYNC_RETRY_BASE_MS = _num("HYPERSYNC_RETRY_BASE_MS", "HYPERSYNC_RETRY_BASE_MS", 200);

/** Native HyperSync retry delay ceiling in milliseconds. */
export const HYPERSYNC_RETRY_CEILING_MS = _num("HYPERSYNC_RETRY_CEILING_MS", "HYPERSYNC_RETRY_CEILING_MS", 5_000);

// HyperRPC JSON-RPC endpoint — used exclusively for multicall token metadata
// hydration so batch reads don't compete with hot-path RPC scoring.
// Hosted *.rpc.hypersync.xyz endpoints automatically inherit ENVIO_API_TOKEN.
// Local/custom endpoints are left untouched.
export const HYPERRPC_URL = withEnvioToken(process.env.HYPERRPC_URL || "https://polygon.rpc.hypersync.xyz", ENVIO_API_TOKEN);

if (!ENVIO_API_TOKEN) {
  console.warn(
    "WARNING: ENVIO_API_TOKEN not set. HyperSync streaming (StateWatcher) will reject requests.\n" +
      "         Set ENVIO_API_TOKEN in .env.",
  );
}

/** Max number of logs to fetch in a single HyperSync batch */
export const HYPERSYNC_BATCH_SIZE = _num("HYPERSYNC_BATCH_SIZE", "HYPERSYNC_BATCH_SIZE", 5000);

/**
 * Max number of blocks a single historical HyperSync `get()` page may scan.
 * Bounding block span keeps sparse backfills within HyperSync's query-time budget.
 */
export const HYPERSYNC_MAX_BLOCKS_PER_REQUEST = _num("HYPERSYNC_MAX_BLOCKS_PER_REQUEST", "HYPERSYNC_MAX_BLOCKS_PER_REQUEST", 1_000_000);

/** Max number of addresses to include in a HyperSync filter before falling back to topic-only */
export const HYPERSYNC_MAX_ADDRESS_FILTER = _num("HYPERSYNC_MAX_ADDRESS_FILTER", "HYPERSYNC_MAX_ADDRESS_FILTER", 1000);

/**
 * Max number of log filters to include in a single watcher `get()` request.
 * Splitting large watchlists across multiple requests avoids HyperSync payload
 * limits once the bot tracks many pools.
 */
export const HYPERSYNC_MAX_FILTERS_PER_REQUEST = _num("HYPERSYNC_MAX_FILTERS_PER_REQUEST", "HYPERSYNC_MAX_FILTERS_PER_REQUEST", 8);

/** Idle sleep between caught-up HyperSync watcher polls. Tune to 250-500ms only with CPU/API telemetry. */
export const HYPERSYNC_WATCHER_IDLE_SLEEP_MS = _num("HYPERSYNC_WATCHER_IDLE_SLEEP_MS", "HYPERSYNC_WATCHER_IDLE_SLEEP_MS", 1_000);

/** Recent-block window for targeted HyperSync backfills of newly admitted pools. */
export const HYPERSYNC_TARGETED_BACKFILL_LOOKBACK_BLOCKS = _num(
  "HYPERSYNC_TARGETED_BACKFILL_LOOKBACK_BLOCKS",
  "HYPERSYNC_TARGETED_BACKFILL_LOOKBACK_BLOCKS",
  64,
);

/** Max newly discovered pools to include in one targeted HyperSync backfill. */
export const HYPERSYNC_TARGETED_BACKFILL_MAX_POOLS = _num(
  "HYPERSYNC_TARGETED_BACKFILL_MAX_POOLS",
  "HYPERSYNC_TARGETED_BACKFILL_MAX_POOLS",
  64,
);

// ─── Discovery ─────────────────────────────────────────────────

/** Interval between background pool discovery runs (ms) */
export const DISCOVERY_INTERVAL_MS = _num("DISCOVERY_INTERVAL_MS", "DISCOVERY_INTERVAL_MS", 30 * 60 * 1000);

/** Max number of protocol discovery scans to run concurrently */
export const DISCOVERY_PROTOCOL_CONCURRENCY = _num("DISCOVERY_PROTOCOL_CONCURRENCY", "DISCOVERY_PROTOCOL_CONCURRENCY", 3);

// ─── RPC ───────────────────────────────────────────────────────

function _dedupeRpcUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// Parse POLYGON_RPC_URLS once; used both as POLYGON_RPC fallback and pool seed.
const _envRpcUrls = _dedupeRpcUrls(
  (process.env.POLYGON_RPC_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Primary RPC used for execution (sendTx, nonce, gas estimates) and any call
 * that needs a single authoritative endpoint.
 *
 * Priority: POLYGON_RPC env → first POLYGON_RPC_URLS entry → Alchemy demo
 *           (rate-limited, for dev only).
 */
export const POLYGON_RPC = process.env.POLYGON_RPC || _envRpcUrls[0] || "https://polygon-mainnet.g.alchemy.com/v2/demo";

// ─── Gas Price Defaults ─────────────────────────────────────────

/** Default gas price: 30 gwei (in wei) */
export const DEFAULT_GAS_PRICE_WEI = 30n * 10n ** 9n;

/** Default gas price in gwei (for readability) */
export const DEFAULT_GAS_PRICE_GWEI = 30;

/** Gwei to wei multiplier */
export const GWEI = 10n ** 9n;

/**
 * Pool of Polygon RPC endpoints managed by the latency-based RPC manager.
 *
 * Priority order (highest first):
 *   1. POLYGON_RPC      — paid/private endpoint if explicitly configured
 *   2. POLYGON_RPC_URLS — comma-separated env override
 *   3. Built-in free public endpoints (fallback)
 *
 * The manager probes all endpoints every 15 s and routes to the healthiest one.
 */
const _defaultFreeRpcs = [
  "https://poly.api.pocket.network", // Pocket Network
  "https://polygon-bor-rpc.publicnode.com", // PublicNode
  "https://polygon-rpc.com", // Official Polygon public RPC
  "https://polygon.llarpc.com", // LlamaNodes public
  "https://polygon-public.nodies.app", // Nodies
  "https://polygon.api.onfinality.io/public", // OnFinality
  "https://tenderly.rpc.polygon.community", // Tenderly community RPC
];

const _paidRpc = process.env.POLYGON_RPC && !process.env.POLYGON_RPC.includes("/v2/demo") ? [process.env.POLYGON_RPC] : [];

const _publicRpcUrls = _envRpcUrls.length ? [..._envRpcUrls, ..._defaultFreeRpcs] : _defaultFreeRpcs;

const _allUrls = [..._paidRpc, ..._publicRpcUrls];

export const FREE_RPC_URLS = [...new Set(_allUrls)];

// ─── Private Mempool ───────────────────────────────────────────

/**
 * URL of the private mempool endpoint.
 *   Alchemy:  https://polygon-mainnet.g.alchemy.com/v2/<KEY>
 *   Custom:   any endpoint accepting eth_sendRawTransaction
 */
export const PRIVATE_MEMPOOL_URL = process.env.PRIVATE_MEMPOOL_URL || "";

/**
 * RPC method to use with PRIVATE_MEMPOOL_URL.
 *   "eth_sendPrivateTransaction" — Alchemy / QuickNode private tx
 *   "eth_sendBundle"             — bundle-capable private relay
 *   "eth_sendRawTransaction"     — standard submission (default if unset)
 */
export const PRIVATE_MEMPOOL_METHOD = process.env.PRIVATE_MEMPOOL_METHOD || "eth_sendRawTransaction";

/**
 * Dedicated Polygon private mempool endpoint. Keep this separate from the
 * generic PRIVATE_MEMPOOL_URL so provider-specific rollout does not affect
 * other private relay paths.
 */
export const POLYGON_PRIVATE_MEMPOOL_URL = process.env.POLYGON_PRIVATE_MEMPOOL_URL || "";

/**
 * RPC method used by the Polygon private mempool endpoint. Default assumes
 * a drop-in eth_sendRawTransaction-style interface.
 */
export const POLYGON_PRIVATE_MEMPOOL_METHOD = process.env.POLYGON_PRIVATE_MEMPOOL_METHOD || "eth_sendRawTransaction";

/**
 * Optional auth header for Polygon private mempool access. Example:
 *   "Authorization"
 *   "x-api-key"
 */
export const POLYGON_PRIVATE_MEMPOOL_AUTH_HEADER = process.env.POLYGON_PRIVATE_MEMPOOL_AUTH_HEADER || "";

/**
 * Optional auth token/value paired with POLYGON_PRIVATE_MEMPOOL_AUTH_HEADER.
 */
export const POLYGON_PRIVATE_MEMPOOL_AUTH_TOKEN = process.env.POLYGON_PRIVATE_MEMPOOL_AUTH_TOKEN || "";

// ─── Profit / Execution Constants (centralized) ────────────────

/** Slippage tolerance applied to simulated output in basis points. */
export const CONFIG_DEFAULT_SLIPPAGE_BPS = BigInt(_num("SLIPPAGE_BPS", "SLIPPAGE_BPS", 50));

/** Revert risk penalty in basis points (5% = 500 bps). */
export const CONFIG_DEFAULT_REVERT_RISK_BPS = BigInt(_num("REVERT_RISK_BPS", "REVERT_RISK_BPS", 500));

/** Minimum net profit threshold in MATIC wei (≈ $0.001 at current MATIC prices). */
export const CONFIG_DEFAULT_MIN_PROFIT_WEI = _bigint("MIN_PROFIT_WEI", "MIN_PROFIT_WEI", 1000000000000000n);

/** Gas buffer multiplier in basis points (105 = 5% buffer). */
export const CONFIG_DEFAULT_GAS_BUFFER_BPS = _num("GAS_BUFFER_BPS", "GAS_BUFFER_BPS", 105);

/** Gas multiplier applied to raw estimate (1.1 = 10% buffer). */
export const CONFIG_DEFAULT_GAS_MULTIPLIER = _num("GAS_MULTIPLIER", "GAS_MULTIPLIER", 110) / 100;

/** Flash loan fee in basis points (0 for most Polygon deployments). */
export const CONFIG_DEFAULT_FLASH_LOAN_FEE_BPS = _bigint("FLASH_LOAN_FEE_BPS", "FLASH_LOAN_FEE_BPS", 0n);

/** JSON-RPC timeout for HFT submission (milliseconds). */
export const CONFIG_JSON_RPC_TIMEOUT_MS = _num("JSON_RPC_TIMEOUT_MS", "JSON_RPC_TIMEOUT_MS", 3_000);

/** EMA alpha for gas adjustment feedback (0.5 for fast adaptation). */
export const CONFIG_GAS_ADJUSTMENT_ALPHA = _numFloat("GAS_ADJUSTMENT_ALPHA", "GAS_ADJUSTMENT_ALPHA", 0.5);

// ─── Probing ────────────────────────────────────────────────────

/**
 * Minimum probe amount per token, keyed by decimals.
 * Used by assessment.ts to ensure the probe amount is meaningful
 * for the token's decimal precision.
 */
export const PROBE_BY_DECIMALS: Record<number, bigint> = {
  6: 1_000_000n, // $1.00 USDC (6 dec)
  18: 1_000_000_000_000_000_000n, // 1e18 raw (18 dec, e.g. WETH/WMATIC)
  8: 1_000_000_000n, // 1e9 raw (8 dec, e.g. WBTC)
};

/** Fallback probe amount when decimals are unknown (18-dec equivalent). */
export const DEFAULT_PROBE_AMOUNT = PROBE_BY_DECIMALS[18];

function _redactUrlForConfigLog(raw: string) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<invalid-url>";
  }
}

export function validatePolygonWsRpcUrl(rawValue: string | undefined | null) {
  const raw = (rawValue || "").trim();
  if (!raw) return { url: "", reason: "missing" };
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return { url: "", reason: "URL must use ws:// or wss://" };
    }
    if (url.hostname === "polygon-mainnet.g.alchemy.com" && !/^\/v2\/[^/]+$/.test(url.pathname)) {
      return { url: "", reason: "Alchemy URLs must include /v2/<key>" };
    }
    return { url: raw, reason: "" };
  } catch {
    return { url: "", reason: "ignoring" };
  }
}

function _polygonWsRpcUrl() {
  const raw = (process.env.POLYGON_WS_RPC_URL || process.env.PENDING_TX_WS_URL || "").trim();
  const validation = validatePolygonWsRpcUrl(raw);
  if (validation.url) return validation.url;
  if (raw) {
    console.warn(`[config] Invalid Polygon WebSocket RPC URL ${_redactUrlForConfigLog(raw)} — ${validation.reason}`);
  }
  return "";
}

/**
 * Dedicated WebSocket RPC endpoint for low-latency pending transaction and
 * new-block subscriptions. Keep this separate from POLYGON_RPC because the
 * subscription connection is long-lived and should not affect execution RPC
 * health scoring.
 */
export const POLYGON_WS_RPC_URL = _polygonWsRpcUrl();

/** Enable pending transaction + block subscriptions when a valid POLYGON_WS_RPC_URL is set. */
export const PENDING_TX_WATCHER_ENABLED = Boolean(POLYGON_WS_RPC_URL) && _bool("PENDING_TX_WATCHER_ENABLED", true);

/** Coalescing TTL for state refreshes triggered by pending txs or blocks. */
export const PENDING_STATE_REFRESH_TTL_MS = _num("PENDING_STATE_REFRESH_TTL_MS", "PENDING_STATE_REFRESH_TTL_MS", 100);

/** Max touched pools to refresh in one pending-state batch. */
export const PENDING_STATE_REFRESH_BATCH_SIZE = _num("PENDING_STATE_REFRESH_BATCH_SIZE", "PENDING_STATE_REFRESH_BATCH_SIZE", 32);

/** Max pending transaction hashes to fetch per watcher callback. */
export const PENDING_TX_FETCH_BATCH_SIZE = _num("PENDING_TX_FETCH_BATCH_SIZE", "PENDING_TX_FETCH_BATCH_SIZE", 24);

/** Max parallel getTransaction calls per pending watcher callback. */
export const PENDING_TX_FETCH_CONCURRENCY = _num("PENDING_TX_FETCH_CONCURRENCY", "PENDING_TX_FETCH_CONCURRENCY", 4);

// ─── RPC Retry / Rate-Limit ───────────────────────────────────

/** Max retry attempts for a single RPC call on 429/5xx */
export const RPC_MAX_RETRIES = 5;

/** Base delay before first retry (ms); doubles each attempt */
export const RPC_BASE_DELAY_MS = 500;

/** Ceiling for backoff delay (ms) */
export const RPC_MAX_DELAY_MS = 30_000;

// ─── Concurrency (auto-tuned) ─────────────────────────────────

/**
 * Max concurrent RPC enrichment calls (Balancer getPoolTokens, Curve get_coins).
 * Auto-tuned from RPC latency; higher = faster enrichment but more rate-limit risk.
 */
export const ENRICH_CONCURRENCY = _num("ENRICH_CONCURRENCY", "ENRICH_CONCURRENCY", 6);

/**
 * Max concurrent getReserves() calls during V2 state polling.
 * Higher than ENRICH_CONCURRENCY because V2 calls are cheaper.
 */
export const V2_POLL_CONCURRENCY = _num("V2_POLL_CONCURRENCY", "V2_POLL_CONCURRENCY", 10);

/**
 * Number of V2 getReserves() calls to pack into one Multicall3 request.
 * This keeps discovery hydration bounded when V2 coverage is large.
 */
export const V2_RESERVES_MULTICALL_CHUNK_SIZE = _num("V2_RESERVES_MULTICALL_CHUNK_SIZE", "V2_RESERVES_MULTICALL_CHUNK_SIZE", 128);

/**
 * Max concurrent slot0 / liquidity calls during V3 state polling.
 */
export const V3_POLL_CONCURRENCY = _num("V3_POLL_CONCURRENCY", "V3_POLL_CONCURRENCY", 3);

/**
 * Number of V3 tickBitmap() calls packed into one Multicall3 request.
 * Lower this to reduce per-request RPC payload size/memory spikes; raise only
 * when the RPC endpoint handles large multicalls reliably.
 */
export const V3_BITMAP_MULTICALL_CHUNK_SIZE = _num("V3_BITMAP_MULTICALL_CHUNK_SIZE", "V3_BITMAP_MULTICALL_CHUNK_SIZE", 128);

/**
 * Number of V3 ticks() calls packed into one Multicall3 request.
 * This is the heaviest V3 hydration batch knob: lower values reduce RPC
 * response size and heap pressure at the cost of more network round trips.
 */
export const V3_TICKS_MULTICALL_CHUNK_SIZE = _num("V3_TICKS_MULTICALL_CHUNK_SIZE", "V3_TICKS_MULTICALL_CHUNK_SIZE", 200);

/** V3 warmup state rows buffered before each registry persistence write. */
export const WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE = _num(
  "WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE",
  "WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE",
  25,
);

// ─── Worker threads (auto-tuned) ─────────────────────────────

/**
 * Number of persistent worker threads in the simulation pool.
 * Default: (CPU cores − 1), leaving one core for the main thread.
 */
export const WORKER_COUNT = _num("WORKER_COUNT", "WORKER_COUNT", Math.max(1, os.cpus().length - 1));

/**
 * Minimum path count before offloading to worker threads.
 * Below this threshold, IPC serialisation overhead exceeds the benefit.
 */
export const EVAL_WORKER_THRESHOLD = _num("EVAL_WORKER_THRESHOLD", "EVAL_WORKER_THRESHOLD", 20);

// ─── Routing / cycle enumeration (auto-tuned) ────────────────

/**
 * Hard cap on the number of candidate arbitrage paths kept in memory.
 * Auto-tuned from available heap.
 */
export const MAX_TOTAL_PATHS = _num("MAX_TOTAL_PATHS", "MAX_TOTAL_PATHS", 20_000);

/**
 * How many of the top simulation candidates to run ternary-search optimisation on.
 * Auto-tuned from math throughput to stay within ~100ms.
 */
export const MAX_PATHS_TO_OPTIMIZE = _num("MAX_PATHS_TO_OPTIMIZE", "MAX_PATHS_TO_OPTIMIZE", 15);

// ─── Predictive Cache (Shadow State) ─────────────────────────

/**
 * Enable predictive state cache for ultra-low latency execution.
 * Pre-computes top-N paths in background, updates only affected paths on new blocks.
 */
export const ENABLE_PREDICTIVE_CACHE = _bool("ENABLE_PREDICTIVE_CACHE", false);

/**
 * Max paths to track in predictive cache shadow state.
 */
export const PREDICTIVE_CACHE_MAX_PATHS = _num("PREDICTIVE_CACHE_MAX_PATHS", "PREDICTIVE_CACHE_MAX_PATHS", 500);

/**
 * Top N paths to always keep pre-computed in background.
 */
export const PREDICTIVE_CACHE_PRECOMPUTE_N = _num("PREDICTIVE_CACHE_PRECOMPUTE_N", "PREDICTIVE_CACHE_PRECOMPUTE_N", 50);

/**
 * Background pre-computation refresh interval in milliseconds.
 */
export const PREDICTIVE_CACHE_REFRESH_MS = _num("PREDICTIVE_CACHE_REFRESH_MS", "PREDICTIVE_CACHE_REFRESH_MS", 100);

/**
 * Staleness threshold in milliseconds before path is marked stale.
 */
export const PREDICTIVE_CACHE_STALENESS_MS = _num("PREDICTIVE_CACHE_STALENESS_MS", "PREDICTIVE_CACHE_STALENESS_MS", 5000);

/**
 * Maximum number of hub-pair pools to fetch synchronously during startup warmup.
 * Remaining pools are deferred to watcher-driven admission to bound cold-start latency.
 */
export const MAX_SYNC_WARMUP_POOLS = _num("MAX_SYNC_WARMUP_POOLS", "MAX_SYNC_WARMUP_POOLS", 800);

/**
 * Maximum number of V3 pools to fully hydrate during synchronous startup warmup.
 * Additional selected V3 pools still warm up, but fall back to nearby-word
 * hydration instead of being deferred out of the sync warmup set.
 */
export const MAX_SYNC_WARMUP_V3_POOLS = _num(
  "MAX_SYNC_WARMUP_V3_POOLS",
  "MAX_SYNC_WARMUP_V3_POOLS",
  Math.min(48, Math.max(16, Math.floor(MAX_SYNC_WARMUP_POOLS * 0.1))),
);

/**
 * Secondary startup warmup budget for pools that touch at least one hub token.
 * This widens token coverage while still capping cold-start latency.
 */
export const MAX_SYNC_WARMUP_ONE_HUB_POOLS = _num("MAX_SYNC_WARMUP_ONE_HUB_POOLS", "MAX_SYNC_WARMUP_ONE_HUB_POOLS", 400);

/**
 * Secondary startup warmup budget specifically for one-hub V3 pools.
 * Defaults to 0 because large V3 catalogs can otherwise make every restart
 * spend synchronous warmup on a long tail better handled by deferred hydration.
 */
export const MAX_SYNC_WARMUP_ONE_HUB_V3_POOLS = _num("MAX_SYNC_WARMUP_ONE_HUB_V3_POOLS", "MAX_SYNC_WARMUP_ONE_HUB_V3_POOLS", 0);

/**
 * Number of bitmap words on each side of the active tick to hydrate for
 * staged V3 admission when full tick hydration would be too expensive.
 */
export const V3_NEARBY_WORD_RADIUS = _num("V3_NEARBY_WORD_RADIUS", "V3_NEARBY_WORD_RADIUS", 2);

/**
 * Background sweeper budget for active pools that still lack routable state
 * after startup and have not emitted watcher events yet.
 */
export const QUIET_POOL_SWEEP_BATCH_SIZE = _num("QUIET_POOL_SWEEP_BATCH_SIZE", "QUIET_POOL_SWEEP_BATCH_SIZE", 24);

/** Pending missing-state backlog size that enables larger quiet-pool catch-up sweeps. */
export const QUIET_POOL_SWEEP_CATCHUP_THRESHOLD = _num("QUIET_POOL_SWEEP_CATCHUP_THRESHOLD", "QUIET_POOL_SWEEP_CATCHUP_THRESHOLD", 10_000);

/** Larger bounded sweep size used only while quiet-pool missing-state backlog is high. */
export const QUIET_POOL_SWEEP_CATCHUP_BATCH_SIZE = _num(
  "QUIET_POOL_SWEEP_CATCHUP_BATCH_SIZE",
  "QUIET_POOL_SWEEP_CATCHUP_BATCH_SIZE",
  Math.max(QUIET_POOL_SWEEP_BATCH_SIZE, QUIET_POOL_SWEEP_BATCH_SIZE * 10),
);

/**
 * Resource-aware caps computed from live CPU, memory, load, and thermal sensors.
 * Explicit env/perf values are treated as requested maxima; this plan may only
 * reduce them to preserve CPU headroom, keep CPU package temperature below 80C,
 * and decompose long peak workloads into smaller bounded units.
 */
export function getResourceTunedRunParameters() {
  return computeResourceTunedRunParameters({
    workerCount: WORKER_COUNT,
    enrichConcurrency: ENRICH_CONCURRENCY,
    v2PollConcurrency: V2_POLL_CONCURRENCY,
    v3PollConcurrency: V3_POLL_CONCURRENCY,
    maxPathsToOptimize: MAX_PATHS_TO_OPTIMIZE,
    maxExecutionBatch: 3,
    quietPoolSweepBatchSize: QUIET_POOL_SWEEP_BATCH_SIZE,
    quietPoolSweepCatchupBatchSize: QUIET_POOL_SWEEP_CATCHUP_BATCH_SIZE,
    maxTotalPaths: MAX_TOTAL_PATHS,
  });
}

export const RESOURCE_TUNED_RUN_PARAMETERS = getResourceTunedRunParameters();

/** Minimum delay between quiet-pool sweep passes (ms). */
export const QUIET_POOL_SWEEP_INTERVAL_MS = _num("QUIET_POOL_SWEEP_INTERVAL_MS", "QUIET_POOL_SWEEP_INTERVAL_MS", 60_000);

/** Maximum number of V3-family pools to hydrate in one legacy poller pass. */
export const V3_POLL_MAX_POOLS = _num("V3_POLL_MAX_POOLS", "V3_POLL_MAX_POOLS", 750);

/** Max age of per-pool state allowed for execution-triggered route revalidation (ms). */
export const ROUTE_STATE_MAX_AGE_MS = _num("ROUTE_STATE_MAX_AGE_MS", "ROUTE_STATE_MAX_AGE_MS", 10_000);

/** Max timestamp skew allowed across pools in one route before execution (ms). */
export const ROUTE_STATE_MAX_SKEW_MS = _num("ROUTE_STATE_MAX_SKEW_MS", "ROUTE_STATE_MAX_SKEW_MS", 3_000);

/**
 * How often to rebuild the full cycle cache (ms).
 * The HyperSync watcher keeps state fresh; this only needs to run when
 * new pools are discovered.  Default: 2 minutes (was 10 minutes).
 */
export const CYCLE_REFRESH_INTERVAL_MS = _num("CYCLE_REFRESH_INTERVAL_MS", "CYCLE_REFRESH_INTERVAL_MS", 2 * 60 * 1000);

/** Number of high-liquidity extra start tokens to include in selective 4-hop enumeration. */
export const SELECTIVE_4HOP_TOKEN_LIMIT = _num("SELECTIVE_4HOP_TOKEN_LIMIT", "SELECTIVE_4HOP_TOKEN_LIMIT", 6);

/** Number of liquidity-ranked pivot tokens to use for full-graph route generation. */
export const DYNAMIC_PIVOT_TOKEN_LIMIT = _num(
  "DYNAMIC_PIVOT_TOKEN_LIMIT",
  "DYNAMIC_PIVOT_TOKEN_LIMIT",
  Math.max(8, SELECTIVE_4HOP_TOKEN_LIMIT * 2),
);

/** Optional persistent cache file for precomputed route cycles. */
export const ROUTE_CYCLE_CACHE_FILE = process.env.ROUTE_CYCLE_CACHE_FILE || "graphify-out/cache/route_cycles.json";

/** Max age for the persistent route-cycle cache before forcing re-enumeration. */
export const ROUTE_CYCLE_CACHE_MAX_AGE_MS = _num("ROUTE_CYCLE_CACHE_MAX_AGE_MS", "ROUTE_CYCLE_CACHE_MAX_AGE_MS", 6 * 60 * 60 * 1000);

/** Path budget reserved for selective 4-hop exploration beyond the core hub graph. */
export const SELECTIVE_4HOP_PATH_BUDGET = _num(
  "SELECTIVE_4HOP_PATH_BUDGET",
  "SELECTIVE_4HOP_PATH_BUDGET",
  Math.max(800, Math.floor(MAX_TOTAL_PATHS * 0.2)),
);

/** Max selective 4-hop paths kept per token. */
export const SELECTIVE_4HOP_MAX_PATHS_PER_TOKEN = _num("SELECTIVE_4HOP_MAX_PATHS_PER_TOKEN", "SELECTIVE_4HOP_MAX_PATHS_PER_TOKEN", 1_500);

/**
 * Maximum routing hop count considered during bounded path search.
 * Keep the default at 4: extended 5+ hop DFS is opt-in because it is CPU-heavy
 * during the mandatory post-warmup route refresh.
 */
const CONFIGURED_ROUTING_MAX_HOPS = Math.max(2, Math.floor(_num("ROUTING_MAX_HOPS", "ROUTING_MAX_HOPS", 4)));

export const ROUTING_MAX_HOPS = CONFIGURED_ROUTING_MAX_HOPS;

/**
 * Minimum routing hop count considered during bounded path search.
 * Collapses to ROUTING_MAX_HOPS when env/perf values are inverted so a
 * misconfigured lower bound cannot raise the configured max-hop resource cap.
 */
export const ROUTING_MIN_HOPS = Math.min(ROUTING_MAX_HOPS, Math.max(2, Math.floor(_num("ROUTING_MIN_HOPS", "ROUTING_MIN_HOPS", 2))));

/**
 * Route search mode.
 *   "all"         — scan 2-hop, 3-hop, and selected 4-hop routes
 *   "triangular"  — scan only 3-hop triangular routes
 */
export const ROUTING_CYCLE_MODE = _routingCycleMode("ROUTING_CYCLE_MODE", "all");

/**
 * Minimum pool liquidity in MATIC wei to include a pool in route enumeration.
 * Pools below this threshold are pruned to avoid low-liquidity false positives.
 * Default: ~$5,000 USD (7,143 MATIC * 10^18 wei at ~$0.70/MATIC).
 * Set to 0 to disable liquidity filtering.
 */
export const MIN_LIQUIDITY_WMATIC = _bigint("MIN_LIQUIDITY_WMATIC", "MIN_LIQUIDITY_WMATIC", 7_143n * 10n ** 18n);

/** Optional env-driven hub-token extensions. */
export const EXTRA_POLYGON_HUB_TOKENS = _addressList("EXTRA_POLYGON_HUB_TOKENS");
export const EXTRA_HUB_4_TOKENS = _addressList("EXTRA_HUB_4_TOKENS");

// ─── Runtime ───────────────────────────────────────────────────

/** Default poll interval for legacy polling (sec) */
export const DEFAULT_POLL_INTERVAL_SEC = _num("DEFAULT_POLL_INTERVAL_SEC", "DEFAULT_POLL_INTERVAL_SEC", 30);

/** Max consecutive errors before giving up on a run pass */
export const MAX_CONSECUTIVE_ERRORS = _num("MAX_CONSECUTIVE_ERRORS", "MAX_CONSECUTIVE_ERRORS", 5);

// ─── Gas oracle (auto-tuned) ─────────────────────────────────

/**
 * How often the background Gas Oracle polls for new fee data (ms).
 * Auto-tuned from RPC latency.  Faster networks can afford more frequent polls.
 */
export const GAS_POLL_INTERVAL_MS = _num("GAS_POLL_INTERVAL_MS", "GAS_POLL_INTERVAL_MS", 5_000);
