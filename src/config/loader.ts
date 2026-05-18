import { ZodError } from "zod";
import { AppConfigSchema, type AppConfig } from "./schema.ts";
import { DEFAULTS } from "./defaults.ts";

/** Optional perf.json overrides */
interface PerfJsonShape {
  params?: Record<string, unknown>;
}

/** Map env var name -> nested config path. Used to translate flat env vars to nested config. */
const ENV_TO_PATH: Record<string, [keyof AppConfig, string]> = {
  POLYGON_RPC_URLS: ["rpc", "polygonRpcUrls"],
  POLYGON_RPC: ["rpc", "polygonRpcUrls"], // alias - single value will be wrapped in array
  EXECUTION_RPC: ["rpc", "executionRpcUrl"],
  GAS_ESTIMATION_RPC: ["rpc", "gasEstimationRpcUrl"],
  HYPERRPC_URL: ["rpc", "hyperRpcUrl"],
  CONFIG_JSON_RPC_TIMEOUT_MS: ["rpc", "requestTimeoutMs"],

  HYPERSYNC_URL: ["hypersync", "url"],
  HYPERSYNC_HTTP_REQ_TIMEOUT_MS: ["hypersync", "httpReqTimeoutMs"],
  HYPERSYNC_MAX_RETRIES: ["hypersync", "maxRetries"],
  HYPERSYNC_BATCH_SIZE: ["hypersync", "batchSize"],
  HYPERSYNC_MAX_BLOCKS_PER_REQUEST: ["hypersync", "maxBlocksPerRequest"],
  HYPERSYNC_MAX_ADDRESS_FILTER: ["hypersync", "maxAddressFilter"],
  HYPERSYNC_PROACTIVE_RATE_LIMIT_SLEEP_MS: ["hypersync", "proactiveRateLimitSleepMs"],

  GAS_POLL_INTERVAL_MS: ["gas", "pollIntervalMs"],
  GAS_BUFFER_BPS: ["gas", "bufferBps"],
  GAS_MULTIPLIER: ["gas", "multiplier"],
  POLYGON_PRIORITY_FEE_FLOOR_GWEI: ["gas", "priorityFeeFloorGwei"],
  POLYGON_PRIORITY_FEE_CEILING_GWEI: ["gas", "priorityFeeCeilingGwei"],
  POLYGON_MAX_BID_MULTIPLIER: ["gas", "maxBidMultiplier"],

  ROUTING_MAX_HOPS: ["routing", "maxHops"],
  MAX_TOTAL_PATHS: ["routing", "maxTotalPaths"],
  MAX_PATHS_TO_OPTIMIZE: ["routing", "maxPathsToOptimize"],
  CYCLE_REFRESH_INTERVAL_MS: ["routing", "cycleRefreshIntervalMs"],
  LIQUIDITY_FLOOR_USD: ["routing", "liquidityFloorUsd"],
  WORKER_COUNT: ["routing", "workerCount"],
  EVAL_WORKER_THRESHOLD: ["routing", "evalWorkerThreshold"],

  MIN_PROFIT_WEI: ["execution", "minProfitWei"],
  SLIPPAGE_BPS: ["execution", "slippageBps"],
  REVERT_RISK_BPS: ["execution", "revertRiskBps"],
  FLASH_LOAN_FEE_BPS: ["execution", "flashLoanFeeBpsBalancer"],
  PRIVATE_RELAY_URLS: ["execution", "privateRelayUrls"],
  DRY_RUN_BEFORE_SUBMIT: ["execution", "dryRunBeforeSubmit"],
  EXECUTOR_ADDRESS: ["execution", "executorAddress"],
  PRIVATE_KEY: ["execution", "privateKey"],

  PREDICTIVE_CACHE_ENABLED: ["predictiveCache", "enabled"],
  PREDICTIVE_CACHE_MAX_PATHS: ["predictiveCache", "maxPaths"],

  MEMPOOL_ENABLED: ["mempool", "enabled"],
  MEMPOOL_WEBSOCKET_URL: ["mempool", "websocketUrl"],
  MEMPOOL_LARGE_SWAP_THRESHOLD_USD: ["mempool", "largeSwapThresholdUsd"],

  METRICS_PORT: ["observability", "metricsPort"],
  LOG_LEVEL: ["observability", "logLevel"],
  TUI: ["observability", "tuiEnabled"],

  ENVIO_API_TOKEN: ["envioApiToken" as keyof AppConfig, ""],
};

/** Deep merge defaults with overrides. Override wins where present. */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (Array.isArray(base)) return (override ?? base) as T;
  if (typeof base !== "object" || base === null) return (override ?? base) as T;
  const out = { ...(base as object) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined) continue;
    const current = (base as Record<string, unknown>)[k];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      out[k] = deepMerge(current, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Build raw config object from env vars by mapping each known env var to its nested path */
function envToOverrides(env: NodeJS.ProcessEnv): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [envKey, mapping] of Object.entries(ENV_TO_PATH)) {
    const value = env[envKey];
    if (value == null || value === "") continue;
    const [section, field] = mapping;
    if (section === ("envioApiToken" as keyof AppConfig)) {
      // Top-level field
      (overrides as Record<string, unknown>).envioApiToken = value;
      continue;
    }
    const sectionStr = section as string;
    if (!overrides[sectionStr]) overrides[sectionStr] = {};
    overrides[sectionStr][field] = value;
  }
  return overrides;
}

/** Load and validate configuration */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const overrides = envToOverrides(env);
  const merged = deepMerge(DEFAULTS as unknown as AppConfig, overrides as unknown as Partial<AppConfig>);
  try {
    return AppConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Configuration validation failed:\n${issues}`);
    }
    throw err;
  }
}

/** Load config or throw a friendly error and exit */
export function loadConfigOrDie(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return loadConfig(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n${message}\n\n`);
    process.exit(1);
  }
}
