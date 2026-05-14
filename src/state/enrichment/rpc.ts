/**
 * src/enrichment/rpc.ts — Shared viem public client with multi-RPC switching
 *
 * Provides:
 *   - publicClient: dynamic proxy that always routes to the best RPC endpoint
 *   - executeWithRpcRetry(): generic wrapper with per-endpoint switching
 *   - readContractWithRetry(): readContract wrapper with per-endpoint switching
 *   - throttledMap(): concurrency-limited async mapper for batch enrichment
 */

import { errorMessage } from "../../utils/errors.ts";
import {
  rpcManager,
  dynamicPublicClient,
  isEndpointCapabilityError,
  isRateLimitError,
  isAuthError,
  isRetryableError,
} from "../../utils/rpc_manager.ts";
import { RPC_MAX_RETRIES, RPC_BASE_DELAY_MS, RPC_MAX_DELAY_MS } from "../../config/index.ts";

// ─── Warn about demo endpoint ──────────────────────────────────
// Lazy-initialized to avoid circular module initialization deadlock.

let _demoWarned = false;
function _warnDemoEndpoint() {
  if (_demoWarned) return;
  _demoWarned = true;
  try {
    if (process.env.NODE_ENV !== "test" && (process.env.POLYGON_RPC || "").includes("/v2/demo")) {
      console.warn(
        "WARNING: Using Alchemy demo RPC endpoint — rate limits are extremely low.\n" +
          "         Set POLYGON_RPC in .env to a real endpoint for production use.",
      );
    }
  } catch {
    // Config not yet loaded — skip warning
  }
}

// ─── Public client ─────────────────────────────────────────────
// Re-export the dynamic proxy so existing callers don't need changes.

export const publicClient = dynamicPublicClient;

// ─── Retry helpers ─────────────────────────────────────────────

type RpcRetryEndpoint = {
  url: string;
  client: unknown;
};

type RpcRetryMessageFactory = (shortUrl: string, endpoint: RpcRetryEndpoint, attempt: number, reason?: string) => string;

type RpcRetryDelayMessageFactory = (shortUrl: string, delayMs: number, endpoint: RpcRetryEndpoint, attempt: number) => string;

type RpcRetryOptions = {
  retries?: number;
  method?: string;
  onRateLimitMessage?: RpcRetryMessageFactory | null;
  onRetryMessage?: RpcRetryDelayMessageFactory | null;
};

type ReadContractClient = {
  readContract: <T = unknown>(params: ReadContractWithRetryParams) => Promise<T>;
};

export type ReadContractWithRetryParams = Record<string, unknown>;

type MulticallClient = {
  multicall: <T = unknown[]>(params: MulticallWithRetryParams) => Promise<T>;
};

export type MulticallWithRetryParams = Record<string, unknown> & {
  allowFailure?: boolean;
  contracts?: readonly unknown[];
};

type MulticallFailureResult = {
  status?: unknown;
  error?: unknown;
};

export async function executeWithRpcRetry<T, TClient = unknown>(
  fn: (client: TClient, endpoint: RpcRetryEndpoint, attempt: number) => Promise<T> | T,
  options: RpcRetryOptions = {},
): Promise<T> {
  const { retries = RPC_MAX_RETRIES, method = "unknown", onRateLimitMessage = null, onRetryMessage = null } = options;

  let lastError: unknown;
  const capabilityFailedUrls = new Set<string>();
  const maxAttempts = Math.max(1, rpcManager.endpoints.length + retries);
  const rpcMethod = String(method || "unknown");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const waitMs = rpcManager.msUntilAnyEndpointAvailable(rpcMethod);
    if (waitMs > 0) {
      const jitterMs = Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, waitMs + 50 + jitterMs));
    }

    if (rpcManager.areAllEndpointsMethodUnavailable(rpcMethod)) {
      throw new Error(`RPC method unsupported by all configured endpoints (${rpcManager.endpoints.length}) for ${rpcMethod}`);
    }

    const endpoint = rpcManager.checkoutBestEndpoint(rpcMethod);
    const client = endpoint.client;

    try {
      const result = await fn(client as TClient, endpoint, attempt);
      rpcManager.markSuccess(endpoint.url);
      return result;
    } catch (error) {
      lastError = error;

      if (isNoDataReadContractError(error)) {
        throw error;
      }

      if (isEndpointCapabilityError(error)) {
        capabilityFailedUrls.add(endpoint.url);
        rpcManager.markMethodUnavailable(endpoint.url, rpcMethod);
        if (attempt === 0 && onRateLimitMessage) {
          console.warn(onRateLimitMessage(rpcManagerShortUrl(endpoint.url), endpoint, attempt, "unsupported for contract reads"));
        }
        if (capabilityFailedUrls.size >= rpcManager.endpoints.length || rpcManager.areAllEndpointsMethodUnavailable(rpcMethod)) {
          throw new Error(
            `RPC method unsupported by all configured endpoints (${rpcManager.endpoints.length}) for ${rpcMethod}: ${errorMessage(error)}`,
          );
        }
        continue;
      }

      if (isRateLimitError(error)) {
        rpcManager.markRateLimited(endpoint.url, error, rpcMethod);
        if (attempt === 0 && onRateLimitMessage) {
          console.warn(onRateLimitMessage(rpcManagerShortUrl(endpoint.url), endpoint, attempt, "rate-limited"));
        }
        continue;
      }

      if (isAuthError(error)) {
        capabilityFailedUrls.add(endpoint.url);
        rpcManager.markMethodUnavailable(endpoint.url, rpcMethod);
        if (attempt === 0 && onRateLimitMessage) {
          console.warn(onRateLimitMessage(rpcManagerShortUrl(endpoint.url), endpoint, attempt, "auth-failed"));
        }
        if (capabilityFailedUrls.size >= rpcManager.endpoints.length || rpcManager.areAllEndpointsMethodUnavailable(rpcMethod)) {
          throw new Error(
            `RPC auth rejected by all configured endpoints (${rpcManager.endpoints.length}) for ${rpcMethod}: ${errorMessage(error)}`,
          );
        }
        continue;
      }

      if (!isRetryableError(error)) {
        throw error;
      }
      if (attempt === maxAttempts - 1) {
        rpcManager.markError(endpoint.url, rpcMethod);
        throw error;
      }

      rpcManager.markError(endpoint.url, rpcMethod);
      if (rpcManager.msUntilAnyEndpointAvailable(rpcMethod) === 0) {
        continue;
      }

      const delay = Math.min(RPC_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200, RPC_MAX_DELAY_MS);

      if (attempt === 0 && onRetryMessage) {
        console.warn(onRetryMessage(rpcManagerShortUrl(endpoint.url), Math.round(delay), endpoint, attempt));
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      rpcManager.releaseEndpoint(endpoint.url);
    }
  }

  throw lastError;
}

/**
 * Execute a viem readContract call with exponential backoff on retryable errors.
 *
 * On a 429 the current endpoint is marked as rate-limited and the next
 * best endpoint is tried immediately (up to RPC_MAX_RETRIES total attempts).
 *
 * @param {object} params  Same params as publicClient.readContract()
 * @returns The contract call result
 * @throws After RPC_MAX_RETRIES exhausted across all endpoints
 */
export async function readContractWithRetry<T = unknown>(params: ReadContractWithRetryParams): Promise<T> {
  return executeWithRpcRetry<T, ReadContractClient>((client) => client.readContract<T>(params), {
    method: "eth_call",
    onRateLimitMessage: (shortUrl, _endpoint, _attempt, reason = "rate-limited") =>
      `    RPC ${reason} on ${shortUrl}, switching endpoint...`,
    onRetryMessage: (shortUrl, delayMs) => `    RPC error on ${shortUrl}, retrying in ${delayMs}ms...`,
  });
}

/**
 * Execute a viem multicall with the same endpoint failover and retry policy as
 * readContractWithRetry().
 *
 * @param {object} params  Same params as publicClient.multicall()
 * @returns The multicall results
 */
export async function multicallWithRetry<T = unknown[]>(params: MulticallWithRetryParams): Promise<T> {
  return executeWithRpcRetry<T, MulticallClient>(
    async (client) => {
      const results = await client.multicall<T>(params);
      const batchFailure = multicallBatchTransportFailure(params, results);
      if (batchFailure) throw batchFailure;
      return results;
    },
    {
      method: "eth_call",
      onRateLimitMessage: (shortUrl, _endpoint, _attempt, reason = "rate-limited") =>
        `    RPC ${reason} on ${shortUrl} during multicall, switching endpoint...`,
      onRetryMessage: (shortUrl, delayMs) => `    RPC multicall error on ${shortUrl}, retrying in ${delayMs}ms...`,
    },
  );
}

function multicallBatchTransportFailure(params: MulticallWithRetryParams, results: unknown) {
  if (!params?.allowFailure || !Array.isArray(results)) return null;
  const expectedResults = Array.isArray(params.contracts) ? params.contracts.length : null;
  const failures = results.filter(isMulticallFailureResult);
  if (failures.length === 0) return null;

  const everyReturnedResultFailed = failures.length === results.length;
  const resultCountMismatch = expectedResults != null && results.length !== expectedResults;
  if (!everyReturnedResultFailed && !resultCountMismatch) return null;

  const retryableFailures = failures.filter(
    (result) => isRetryableError(result.error) || isEndpointCapabilityError(result.error) || isRateLimitError(result.error),
  );
  if (retryableFailures.length !== failures.length) return null;
  return retryableFailures[0]?.error ?? null;
}

function isMulticallFailureResult(result: unknown): result is MulticallFailureResult {
  return (
    result != null &&
    typeof result === "object" &&
    "status" in result &&
    (result as MulticallFailureResult).status === "failure" &&
    "error" in result &&
    (result as MulticallFailureResult).error != null
  );
}

/**
 * True for viem readContract failures where the address returned no calldata.
 *
 * This usually means one of:
 *   - the address is not a contract
 *   - the contract does not implement the requested selector
 *   - the pool was misclassified for its protocol family
 *
 * These are permanent data-quality issues, not transient RPC transport errors.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNoDataReadContractError(error: unknown) {
  const msg = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return msg.includes('returned no data ("0x")');
}

// ─── Concurrency limiter ───────────────────────────────────────

/**
 * Run an async function over an array with bounded concurrency.
 *
 * @param {T[]} items           Items to process
 * @param {(item: T, index: number) => Promise<R>} fn  Async worker
 * @param {number} concurrency  Max parallel workers (default 3)
 * @returns {Promise<R[]>}      Results in original order
 */
export async function throttledMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 3,
  timeoutMs?: number,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  async function worker() {
    while (nextIndex < items.length && !failed) {
      const i = nextIndex++;
      let result: R;
      if (timeoutMs != null && timeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          result = await Promise.race([
            fn(items[i], i),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`throttledMap item ${i} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        result = await fn(items[i], i);
      }
      results[i] = result;
    }
  }

  const workerCount = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), items.length));
  const workers = Array.from({ length: workerCount }, () =>
    worker().catch((err) => {
      failed = true;
      throw err;
    }),
  );
  try {
    await Promise.all(workers);
  } catch (err) {
    failed = true;
    throw new Error(`throttledMap: one or more workers failed: ${errorMessage(err)}`);
  }

  return results;
}

// ─── Helpers ───────────────────────────────────────────────────

function rpcManagerShortUrl(url: unknown) {
  const value = String(url ?? "");
  try {
    const u = new URL(value);
    return u.hostname;
  } catch {
    return value.slice(0, 40);
  }
}

export async function fetchBlockRollbackGuard(): Promise<Record<string, unknown> | null> {
  try {
    const endpoint = rpcManager.checkoutBestEndpoint("getBlock");
    try {
      const block = await endpoint.client.getBlock({ blockTag: "latest" });
      if (block && typeof block.number === "bigint" && block.hash && block.parentHash) {
        return {
          blockNumber: Number(block.number),
          hash: block.hash,
          firstBlockNumber: Number(block.number),
          firstParentHash: block.parentHash,
          timestamp: Number(block.timestamp),
        };
      }
    } finally {
      rpcManager.releaseEndpoint(endpoint.url);
    }
  } catch {}
  return null;
}
