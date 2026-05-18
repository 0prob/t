/**
 * src/hypersync/client.js — HyperSync client factory
 *
 * Creates and exports a singleton HypersyncClient configured from
 * environment variables. Also re-exports commonly used enums.
 *
 * HyperSync 1.3.0 ships native bindings only for Darwin/Linux targets.
 * On unsupported runtimes (for example Android/Termux) the package throws
 * during module import. We catch that here so the rest of the repo can still
 * import cleanly and fail only when HyperSync operations are actually used.
 */

import { createRequire } from "module";
import {
  HYPERSYNC_URL,
  ENVIO_API_TOKEN,
  HYPERSYNC_HTTP_REQ_TIMEOUT_MS,
  HYPERSYNC_MAX_RETRIES,
  HYPERSYNC_RETRY_BACKOFF_MS,
  HYPERSYNC_RETRY_BASE_MS,
  HYPERSYNC_RETRY_CEILING_MS,
} from "../config/index.ts";

const require = createRequire(import.meta.url);

type HypersyncClientConfig = {
  url: string;
  apiToken: string;
  httpReqTimeoutMillis?: number;
  maxNumRetries?: number;
  retryBackoffMs?: number;
  retryBaseMs?: number;
  retryCeilingMs?: number;
  proactiveRateLimitSleep?: boolean;
};

type HypersyncError = Error & {
  cause?: unknown;
};

export type HyperSyncGetResponse<TLog = unknown> = {
  archiveHeight?: number | string | null;
  rollbackGuard?: Record<string, unknown> | null;
  nextBlock: number | string;
  data?: {
    logs?: TLog[];
  };
};

export type HypersyncStream<T> = {
  recv: () => Promise<HyperSyncGetResponse<T> | null>;
};

export type HypersyncClientRuntime = {
  getHeight: () => Promise<number>;
  getChainId: () => Promise<number>;
  get: <T = unknown>(query: unknown) => Promise<T>;
  getWithRateLimit: <T = unknown>(query: unknown) => Promise<T>;
  getEvents: <T = unknown>(query: unknown) => Promise<T>;
  collect: <T = unknown>(query: unknown, config: unknown) => Promise<T>;
  collectEvents: <T = unknown>(query: unknown, config: unknown) => Promise<T>;
  collectParquet: (path: string, query: unknown, config: unknown) => Promise<void>;
  streamHeight: <T = unknown>() => Promise<T>;
  stream: <T = unknown>(query: unknown, config: unknown) => Promise<HypersyncStream<T>>;
  streamEvents: <T = unknown>(query: unknown, config: unknown) => Promise<T>;
  rateLimitInfo: () => unknown;
  waitForRateLimit: () => Promise<void>;
};

export type HypersyncDecodedLogValue = {
  val?: unknown;
};

export type HypersyncDecodedLog = {
  indexed: HypersyncDecodedLogValue[];
  body: HypersyncDecodedLogValue[];
};

export type HypersyncDecoderRuntime = {
  decodeLogs: (logs: unknown[]) => Promise<HypersyncDecodedLog[]>;
};

type HypersyncDecoderConstructor = {
  new (): HypersyncDecoderRuntime;
  fromSignatures: (signatures: string[]) => HypersyncDecoderRuntime;
};

type HypersyncModuleLike = {
  HypersyncClient?: new (cfg: HypersyncClientConfig) => HypersyncClientRuntime;
  Decoder?: HypersyncDecoderConstructor;
  BlockField?: Record<string, unknown>;
  LogField?: Record<string, unknown>;
  JoinMode?: Record<string, unknown>;
} | null;

function createUnsupportedHypersyncError(cause: unknown) {
  const err = new Error(
    "HyperSync client is unavailable on this runtime. " +
      "The installed @envio-dev/hypersync-client@1.3.0 package does not ship a native binding for this platform.",
  ) as HypersyncError;
  err.name = "HyperSyncClientUnavailableError";
  err.cause = cause;
  return err;
}

function createHypersyncConfigError(message: string, cause?: unknown) {
  const err = new Error(`HyperSync client configuration failed: ${message}`) as HypersyncError;
  err.name = "HyperSyncClientConfigError";
  if (cause !== undefined) err.cause = cause;
  return err;
}

function normalizeOptionalClientInteger(name: keyof HypersyncClientConfig, value: unknown, options: { allowZero?: boolean } = {}) {
  if (value == null) return undefined;
  const numeric = Number(value);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isSafeInteger(numeric) || numeric < minimum) {
    throw createHypersyncConfigError(`${name} must be a ${options.allowZero ? "non-negative" : "positive"} safe integer.`);
  }
  return numeric;
}

let hypersync: HypersyncModuleLike = null;
let hypersyncImportError: Error | null = null;

try {
  hypersync = require("@envio-dev/hypersync-client") as HypersyncModuleLike;
} catch (err) {
  hypersyncImportError = createUnsupportedHypersyncError(err);
}

function throwUnsupportedHypersync(error = hypersyncImportError): never {
  throw error ?? createUnsupportedHypersyncError(new Error("unknown HyperSync client initialization failure"));
}

export function normalizeHypersyncClientConfig(rawConfig: HypersyncClientConfig) {
  const url = String(rawConfig?.url ?? "").trim();
  const apiToken = String(rawConfig?.apiToken ?? "").trim();
  if (!url) {
    throw createHypersyncConfigError("HYPERSYNC_URL must be a non-empty URL.");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported protocol ${parsed.protocol}`);
    }
  } catch (err) {
    throw createHypersyncConfigError(`HYPERSYNC_URL is not a valid HTTP(S) URL: ${url}`, err);
  }
  const httpReqTimeoutMillis = normalizeOptionalClientInteger("httpReqTimeoutMillis", rawConfig?.httpReqTimeoutMillis);
  const maxNumRetries = normalizeOptionalClientInteger("maxNumRetries", rawConfig?.maxNumRetries, { allowZero: true });
  const retryBackoffMs = normalizeOptionalClientInteger("retryBackoffMs", rawConfig?.retryBackoffMs);
  const retryBaseMs = normalizeOptionalClientInteger("retryBaseMs", rawConfig?.retryBaseMs);
  const retryCeilingMs = normalizeOptionalClientInteger("retryCeilingMs", rawConfig?.retryCeilingMs);

  let proactiveRateLimitSleep = rawConfig?.proactiveRateLimitSleep;
  if (proactiveRateLimitSleep !== undefined && typeof proactiveRateLimitSleep !== "boolean") {
     throw createHypersyncConfigError("proactiveRateLimitSleep must be a boolean.");
  }

  if (retryBaseMs != null && retryCeilingMs != null && retryCeilingMs < retryBaseMs) {
    throw createHypersyncConfigError("retryCeilingMs must be >= retryBaseMs.");
  }

  return {
    url,
    apiToken,
    ...(httpReqTimeoutMillis != null ? { httpReqTimeoutMillis } : {}),
    ...(maxNumRetries != null ? { maxNumRetries } : {}),
    ...(retryBackoffMs != null ? { retryBackoffMs } : {}),
    ...(retryBaseMs != null ? { retryBaseMs } : {}),
    ...(retryCeilingMs != null ? { retryCeilingMs } : {}),
    ...(proactiveRateLimitSleep !== undefined ? { proactiveRateLimitSleep } : {}),
  };
}

export function createUnavailableHypersyncClient(error: unknown): HypersyncClientRuntime {
  const unavailableError = error instanceof Error ? error : createUnsupportedHypersyncError(error);
  return {
    getHeight: async () => throwUnsupportedHypersync(unavailableError),
    getChainId: async () => throwUnsupportedHypersync(unavailableError),
    get: async () => throwUnsupportedHypersync(unavailableError),
    getWithRateLimit: async () => throwUnsupportedHypersync(unavailableError),
    getEvents: async () => throwUnsupportedHypersync(unavailableError),
    collect: async () => throwUnsupportedHypersync(unavailableError),
    collectEvents: async () => throwUnsupportedHypersync(unavailableError),
    collectParquet: async () => throwUnsupportedHypersync(unavailableError),
    streamHeight: async () => throwUnsupportedHypersync(unavailableError),
    stream: async () => throwUnsupportedHypersync(unavailableError),
    streamEvents: async () => throwUnsupportedHypersync(unavailableError),
    rateLimitInfo: () => throwUnsupportedHypersync(unavailableError),
    waitForRateLimit: async () => throwUnsupportedHypersync(unavailableError),
  };
}

export function createHypersyncClient(
  hypersyncModule: HypersyncModuleLike,
  rawConfig: HypersyncClientConfig,
  importError: unknown = hypersyncImportError,
): HypersyncClientRuntime {
  const HypersyncClientImpl = hypersyncModule?.HypersyncClient ?? null;
  if (!HypersyncClientImpl) {
    return createUnavailableHypersyncClient(importError ?? createUnsupportedHypersyncError("missing HypersyncClient export"));
  }
  try {
    return new HypersyncClientImpl(normalizeHypersyncClientConfig(rawConfig));
  } catch (err) {
    return createUnavailableHypersyncClient(createHypersyncConfigError(String((err as { message?: string })?.message ?? err), err));
  }
}

class UnsupportedDecoder implements HypersyncDecoderRuntime {
  static fromSignatures() {
    return new UnsupportedDecoder();
  }

  async decodeLogs(): Promise<HypersyncDecodedLog[]> {
    return throwUnsupportedHypersync();
  }
}

const fallbackBlockField = {
  Number: "Number",
  Timestamp: "Timestamp",
};

const fallbackLogField = {
  Address: "Address",
  Data: "Data",
  Topic0: "Topic0",
  Topic1: "Topic1",
  Topic2: "Topic2",
  Topic3: "Topic3",
  BlockNumber: "BlockNumber",
  BlockHash: "BlockHash",
  TransactionHash: "TransactionHash",
  LogIndex: "LogIndex",
  TransactionIndex: "TransactionIndex",
  Removed: "Removed",
};

const fallbackJoinMode = {
  Default: 0,
  JoinAll: 1,
  JoinNothing: 2,
};

const DecoderImpl: HypersyncDecoderConstructor = hypersync?.Decoder ?? UnsupportedDecoder;

export const BlockField = hypersync?.BlockField ?? fallbackBlockField;
export const LogField = hypersync?.LogField ?? fallbackLogField;
export const JoinMode = hypersync?.JoinMode ?? fallbackJoinMode;
export const Decoder = DecoderImpl;

let _clientInitialized = false;
let _client: ReturnType<typeof createHypersyncClient> | null = null;

function _initClient() {
  if (_clientInitialized) return;
  _clientInitialized = true;
  _client = createHypersyncClient(
    hypersync,
    {
      url: HYPERSYNC_URL,
      apiToken: ENVIO_API_TOKEN || "",
      httpReqTimeoutMillis: HYPERSYNC_HTTP_REQ_TIMEOUT_MS,
      maxNumRetries: HYPERSYNC_MAX_RETRIES,
      retryBackoffMs: HYPERSYNC_RETRY_BACKOFF_MS,
      retryBaseMs: HYPERSYNC_RETRY_BASE_MS,
      retryCeilingMs: HYPERSYNC_RETRY_CEILING_MS,
      proactiveRateLimitSleep: true,
    },
    hypersyncImportError,
  );
}

export const client = new Proxy({} as ReturnType<typeof createHypersyncClient>, {
  get(_, prop) {
    _initClient();
    const val = (_client as any)[prop];
    return typeof val === "function" ? val.bind(_client) : val;
  },
}) as ReturnType<typeof createHypersyncClient>;
