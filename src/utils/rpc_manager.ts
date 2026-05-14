/**
 * src/utils/rpc_manager.ts — Multi-endpoint RPC connection manager
 *
 * Maintains a pool of RPC endpoints sorted by health/latency.
 * Routes calls to the healthiest available endpoint.
 */

import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

import { FREE_RPC_URLS } from "../config/index.ts";
import { errorMessage } from "./errors.ts";

// ─── PublicClient proxy ──────────────────────────────────────
// Uses the shared multi-endpoint pool for general-purpose reads.
// Every property access is forwarded to the healthiest endpoint's
// viem client.  Module-level export so the rest of the codebase
// can use it as a drop-in replacement for a plain viem client.
export const dynamicPublicClient = new Proxy(
  { _rpcManager: null as RpcManager | null },
  {
    get(target, prop: string | symbol) {
      if (!target._rpcManager) {
        const { getRpcManagerInstance } = require_for_init();
        target._rpcManager = getRpcManagerInstance();
      }
      const method = normalizeRpcMethod(prop);
      if (prop === "transport" || prop === "chain" || prop === "key" || prop === "name") return undefined;
      if (prop === "account") return undefined;
      if (prop === "extend") return () => dynamicPublicClient;
      return async (...args: unknown[]) => {
        const manager = target._rpcManager!;
        const endpoint = manager.checkoutBestEndpoint(method);
        try {
          const client = endpoint.client;
          const result = await (client as any)[prop](...args);
          manager.markSuccess(endpoint.url, method);
          return result;
        } catch (err: unknown) {
          if (isEndpointCapabilityError(err)) {
            manager.markMethodUnavailable(endpoint.url, method);
          } else if (isRateLimitError(err)) {
            manager.markRateLimited(endpoint.url, err, method);
          } else {
            manager.markError(endpoint.url, method);
          }
          throw err;
        } finally {
          manager.releaseEndpoint(endpoint.url);
        }
      };
    },
  },
) as unknown as ReturnType<typeof createPublicClient>;

// ─── Types ────────────────────────────────────────────────────

/** Method names supported by the RPC manager */
type _RpcMethodKey =
  | "getBlockNumber"
  | "getBalance"
  | "getBlock"
  | "call"
  | "getLogs"
  | "getTransaction"
  | "getTransactionCount"
  | "getTransactionReceipt"
  | "waitForTransactionReceipt"
  | "estimateGas"
  | "sendRawTransaction"
  | "getFeeHistory"
  | "getChainId";

type LabeledCounter = {
  labels(label: string): { inc(): void };
};

type LabeledHistogram = {
  labels(label: string): { observe(value: number): void };
};

let _rpcMetrics: RpcMetricHandles | null = null;
let _rpcMetricsPromise: Promise<RpcMetricHandles | null> | null = null;

async function lazyMetrics() {
  if (_rpcMetrics) return _rpcMetrics;
  if (_rpcMetricsPromise) return _rpcMetricsPromise;

  _rpcMetricsPromise = import("./metrics.ts")
    .then((m) => {
      _rpcMetrics = {
        rpcErrors: m.rpcErrors,
        rpcSwitches: m.rpcSwitches,
        rpcLatencyMs: m.rpcLatencyMs,
      };
      return _rpcMetrics;
    })
    .catch(() => null)
    .finally(() => {
      _rpcMetricsPromise = null;
    });

  return _rpcMetricsPromise;
}

type RpcMetricHandles = {
  rpcErrors: LabeledCounter;
  rpcSwitches: LabeledCounter;
  rpcLatencyMs: LabeledHistogram;
};

// ─── Constants ────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 1_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 15_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_RPC_METHOD = "eth_call";

// ─── RpcEndpoint ──────────────────────────────────────────────

class RpcEndpoint {
  url: string;
  latencyMs: number;
  consecutiveErrors: number;
  rateLimitedUntil: number;
  errorCooldownUntil: number;
  methodUnavailableUntil: Map<string, number>;
  inFlight: number;
  _backoffMs: number;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  client: ReturnType<typeof createPublicClient>;

  constructor(url: string) {
    this.url = url;
    this.latencyMs = Infinity;
    this.consecutiveErrors = 0;
    this.rateLimitedUntil = 0;
    this.errorCooldownUntil = 0;
    this.methodUnavailableUntil = new Map();
    this.inFlight = 0;
    this._backoffMs = INITIAL_BACKOFF_MS;
    this._safetyTimer = null;

    this.client = createPublicClient({
      chain: polygon,
      transport: http(url, {
        timeout: 10_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: { multicall: true },
    });
  }

  isRateLimited() {
    return Date.now() < this.rateLimitedUntil;
  }

  isCoolingDown() {
    return Date.now() < this.errorCooldownUntil;
  }

  isMethodUnavailable(method: string) {
    const until = this.methodUnavailableUntil.get(method);
    return until != null && Date.now() < until;
  }

  markRateLimited(_error: unknown = null, method = DEFAULT_RPC_METHOD) {
    const cooldownMs = this._backoffMs;
    this.rateLimitedUntil = Date.now() + cooldownMs;
    this.errorCooldownUntil = Date.now() + Math.max(cooldownMs, 5_000);
    this._backoffMs = Math.min(Math.max(cooldownMs * 2, 1_000), 120_000);
    this.consecutiveErrors++;
    lazyMetrics().then((m) => {
      m?.rpcErrors.labels(`rate_limit:${method}`);
      m?.rpcLatencyMs.labels(method).observe(cooldownMs);
    });
  }

  markError(method = DEFAULT_RPC_METHOD) {
    const cooldownMs = this._backoffMs;
    this.errorCooldownUntil = Date.now() + cooldownMs;
    this._backoffMs = Math.min(Math.max(cooldownMs * 2, INITIAL_BACKOFF_MS), 120_000);
    this.consecutiveErrors++;
    lazyMetrics().then((m) => m?.rpcErrors.labels(`error:${method}`));
  }

  markSuccess(_method = DEFAULT_RPC_METHOD) {
    this.consecutiveErrors = 0;
    if (!this.isRateLimited() && !this.isCoolingDown()) {
      this._backoffMs = INITIAL_BACKOFF_MS;
      this.errorCooldownUntil = 0;
    }
  }

  isUnavailable() {
    return this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || this.isCoolingDown();
  }
}

// ─── RpcManager ──────────────────────────────────────────────

export class RpcManager {
  endpoints: RpcEndpoint[];
  _probeInterval: ReturnType<typeof setInterval> | null;
  _probePromise: Promise<void> | null;
  _nextIndex: number;

  constructor(urls: string[]) {
    if (!urls || urls.length === 0) {
      throw new Error("RpcManager: at least one RPC URL required");
    }
    this.endpoints = urls.map((u) => new RpcEndpoint(u));
    this._probeInterval = null;
    this._probePromise = null;
    this._nextIndex = 0;
  }

  getBestEndpoint(method = DEFAULT_RPC_METHOD) {
    const candidates = this._methodAvailableEndpoints(method);
    const healthy = candidates.filter((ep) => !ep.isRateLimited() && !ep.isCoolingDown());
    if (healthy.length > 0) {
      // Sort by latency + in-flight penalty to spread load
      healthy.sort((a, b) => {
        const scoreA = a.latencyMs + a.inFlight * 50;
        const scoreB = b.latencyMs + b.inFlight * 50;
        return scoreA - scoreB;
      });
      return this._roundRobinTieBreak(healthy);
    }

    // All healthy endpoints are cooling down. Use the one that recovers soonest.
    const cooling = candidates.filter((ep) => !ep.isRateLimited());
    if (cooling.length > 0) {
      cooling.sort((a, b) => a.errorCooldownUntil - b.errorCooldownUntil);
      return cooling[0];
    }

    // Everything is rate-limited. Pick the one that recovers first.
    candidates.sort((a, b) => a.rateLimitedUntil - b.rateLimitedUntil);
    return candidates[0];
  }

  _methodAvailableEndpoints(method: string) {
    return this.endpoints.filter((ep) => !ep.isMethodUnavailable(method));
  }

  _isEndpointFunctionallyDead(ep: RpcEndpoint, method: string) {
    if (ep.isMethodUnavailable(method)) return true;
    return false;
  }

  _selectEndpoint(method = DEFAULT_RPC_METHOD) {
    return this.getBestEndpoint(method);
  }

  _roundRobinTieBreak(candidates: RpcEndpoint[]) {
    if (candidates.length === 1) return candidates[0];
    const idx = this._nextIndex++ % candidates.length;
    return candidates[idx];
  }

  // Rate limit check
  msUntilAnyEndpointAvailable(method = DEFAULT_RPC_METHOD) {
    const now = Date.now();
    const allRecoveries = this.endpoints
      .map((ep) => Math.min(ep.rateLimitedUntil, ep.errorCooldownUntil, ep.methodUnavailableUntil.get(method) ?? 0))
      .filter((t) => t > now);
    if (allRecoveries.length > 0) {
      return Math.min(...allRecoveries) - now;
    }
    return 0;
  }

  checkoutBestEndpoint(method = DEFAULT_RPC_METHOD) {
    const ep = this.getBestEndpoint(method);
    if (!ep) {
      throw new Error(`No available RPC endpoint for method ${method}`);
    }
    ep.inFlight++;
    const safetyTimer = setTimeout(() => {
      ep.inFlight = Math.max(0, ep.inFlight - 1);
    }, 30_000);
    safetyTimer.unref();
    ep._safetyTimer = safetyTimer;
    return ep;
  }

  markRateLimited(url: string, error: unknown = null, method = DEFAULT_RPC_METHOD) {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) ep.markRateLimited(error, method);
  }

  markMethodUnavailable(url: string, method: string) {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) ep.methodUnavailableUntil.set(method, Date.now() + 60_000);
  }

  markError(url: string, method = DEFAULT_RPC_METHOD) {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) ep.markError(method);
  }

  markSuccess(url: string, method = DEFAULT_RPC_METHOD) {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) ep.markSuccess(method);
  }

  releaseEndpoint(url: string) {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) {
      if (ep._safetyTimer) {
        clearTimeout(ep._safetyTimer);
        ep._safetyTimer = null;
      }
      ep.inFlight = Math.max(0, ep.inFlight - 1);
    }
  }

  areAllEndpointsMethodUnavailable(method = DEFAULT_RPC_METHOD) {
    if (this.endpoints.length === 0) return false;
    return this.endpoints.every((ep) => this._isEndpointFunctionallyDead(ep, method));
  }

  getBestEndpointForRetry(method = DEFAULT_RPC_METHOD) {
    return this.getBestEndpoint(method);
  }

  getBestClient(method = DEFAULT_RPC_METHOD) {
    return this.getBestEndpoint(method).client;
  }

  start() {
    if (this._probeInterval) return;
    this._probeInterval = setInterval(() => {
      for (const endpoint of this.endpoints) {
        this._probe(endpoint).catch(() => {});
      }
    }, PROBE_INTERVAL_MS);
    for (const endpoint of this.endpoints) {
      this._probe(endpoint).catch(() => {});
    }
  }

  stop() {
    if (this._probeInterval) {
      clearInterval(this._probeInterval);
      this._probeInterval = null;
    }
  }

  async _probe(endpoint: RpcEndpoint) {
    const start = Date.now();
    try {
      await Promise.race([
        endpoint.client.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS)),
      ]);
      endpoint.latencyMs = Date.now() - start;
      endpoint.markSuccess();
    } catch {
      endpoint.markError();
    }
  }
}

// ─── Module-level singleton ──────────────────────────────────
// The RpcManager is NOT created at module load time to avoid a
// circular initialization deadlock:
//   config/index.ts → runner.ts → rpc_manager.ts → config/index.ts
// Callers must call initRpcManager(urls) before first use.

let _rpcInstance: RpcManager | null = null;

export function getRpcManagerInstance(): RpcManager {
  if (!_rpcInstance) {
    const primary = (process.env.POLYGON_RPC || "").split(",").filter(Boolean);
    const extra = (process.env.POLYGON_RPC_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const urls = [...primary, ...extra, ...FREE_RPC_URLS];
    _rpcInstance = new RpcManager([...new Set(urls)]);
    if (process.env.NODE_ENV !== "test") _rpcInstance.start();
  }
  return _rpcInstance;
}

export function initRpcManager(urls: string[]): RpcManager {
  if (_rpcInstance) _rpcInstance.stop();
  _rpcInstance = new RpcManager(urls);
  if (process.env.NODE_ENV !== "test") _rpcInstance.start();
  return _rpcInstance;
}

// ─── Exports (lazy-initialized singleton) ─────────────────────
// The rpcManager variable is a Proxy that defers to the singleton.
// This means imports like `import { rpcManager } from "../rpc_manager.ts"`
// work immediately, but the actual RpcManager is created on first use.

function require_for_init() {
  return { getRpcManagerInstance };
}

// Re-export for callers that import `{ rpcManager }` directly.
// This is a lazy proxy that creates the singleton on first access.
export const rpcManager: RpcManager = new Proxy({} as RpcManager, {
  get(_, prop) {
    const inst = getRpcManagerInstance();
    const val = (inst as any)[prop];
    return typeof val === "function" ? val.bind(inst) : val;
  },
});

// ─── Normalization helpers ────────────────────────────────────

function normalizeRpcMethod(prop: string | symbol): string {
  if (typeof prop !== "string") return DEFAULT_RPC_METHOD;
  switch (prop) {
    case "getBlockNumber":
      return "eth_blockNumber";
    case "getBalance":
      return "eth_getBalance";
    case "getBlock":
      return "eth_getBlockByNumber";
    case "call":
      return "eth_call";
    case "getLogs":
      return "eth_getLogs";
    case "getTransaction":
      return "eth_getTransactionByHash";
    case "getTransactionCount":
      return "eth_getTransactionCount";
    case "getTransactionReceipt":
    case "waitForTransactionReceipt":
      return "eth_getTransactionReceipt";
    case "estimateGas":
      return "eth_estimateGas";
    case "sendRawTransaction":
      return "eth_sendRawTransaction";
    case "getFeeHistory":
      return "eth_feeHistory";
    case "getChainId":
      return "eth_chainId";
    default:
      return DEFAULT_RPC_METHOD;
  }
}

export function rpcManagerShortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url.slice(0, 30);
  }
}

// ─── Error classification ────────────────────────────────────

export function isRateLimitError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  const { status } = (err as Record<string, unknown>) || {};
  if (status === 429) return true;
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429");
}

export function isEndpointCapabilityError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("unsupported") ||
    msg.includes("not supported") ||
    msg.includes("method not found") ||
    msg.includes("-32601")
  );
}

export function isAuthError(err: unknown): boolean {
  const { status, statusCode } = (err as Record<string, unknown>) || {};
  const httpStatus = Number(status ?? statusCode);
  if (httpStatus === 401 || httpStatus === 403) return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("401") || msg.includes("403");
}

export function isRetryableError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (isEndpointCapabilityError(err)) return false;
  if (isAuthError(err)) return false;
  const msg = errorMessage(err).toLowerCase();
  // Check numeric HTTP status first (viem HttpRequestError.status, fetch Response.status)
  const { status, statusCode } = (err as Record<string, unknown>) || {};
  const httpStatus = Number(status ?? statusCode);
  if (Number.isInteger(httpStatus) && httpStatus >= 400) {
    return httpStatus >= 500; // only 5xx is retryable; 4xx (except 429 handled above) is not
  }
  return (
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    // HTTP 5xx status descriptions: only match multi-digit 50x patterns, not bare "5"
    /\b50[0-9]\b|\b5[0-9]{2}\b/.test(msg) ||
    msg.includes("-32000") ||
    msg.includes("header not found") ||
    msg.includes("missing trie node")
  );
}
