import os from "os";

/** Default values for all configuration. These are the values used when no env var or override is provided. */
export const DEFAULTS = {
  rpc: {
    polygonRpcUrls: [
      "https://polygon-rpc.com",
      "https://polygon-mainnet.public.blastapi.io",
      "https://1rpc.io/matic",
      "https://rpc.ankr.com/polygon",
    ],
    executionRpcUrl: "" as string, // required, no default
    gasEstimationRpcUrl: "" as string, // required, no default
    hyperRpcUrl: "https://polygon.rpc.hypersync.xyz",
    requestTimeoutMs: 8_000,
    batchWaitMs: 16,
    batchSize: 100,
  },
  hypersync: {
    url: "https://polygon.hypersync.xyz",
    httpReqTimeoutMs: 60_000,
    maxRetries: 5,
    retryBaseMs: 200,
    retryCeilingMs: 5_000,
    retryBackoffMs: 1_000,
    batchSize: 5_000,
    maxBlocksPerRequest: 1_000_000,
    maxAddressFilter: 25_000,
    maxFiltersPerRequest: 50,
    streamConcurrency: 10,
    streamBatchSize: 1_000,
    proactiveRateLimitSleepMs: 0,
  },
  gas: {
    pollIntervalMs: 2_000,
    bufferBps: 105,
    multiplier: 110,
    priorityFeeFloorGwei: 30,
    priorityFeeCeilingGwei: 500,
    maxBidMultiplier: 5,
    cacheTtlMs: 120_000,
    cacheSize: 2_048,
    defaultGasBufferBps: 105,
  },
  routing: {
    maxHops: 4,
    maxTotalPaths: 20_000,
    maxPathsToOptimize: 15,
    cycleRefreshIntervalMs: 120_000,
    liquidityFloorUsd: 5_000,
    workerCount: Math.max(1, os.cpus().length - 1),
    evalWorkerThreshold: 20,
    enumerationMaxPaths: 5_000,
    enumerationMax4HopPaths: 2_000,
  },
  execution: {
    minProfitWei: 1_000_000_000_000_000n, // 0.001 MATIC
    slippageBps: 50n, // 0.5%
    revertRiskBps: 500n, // 5% base
    flashLoanFeeBpsBalancer: 0n,
    flashLoanFeeBpsAaveV3: 5n,
    privateRelayUrls: [] as string[],
    dryRunBeforeSubmit: true,
    receiptTimeoutMs: 30_000,
    maxConcurrentExecutions: 1,
  },
  discovery: {
    refreshIntervalMs: 300_000,
    concurrency: 4,
  },
  watcher: {
    idleSleepMs: 1_000,
    enrichmentBackfillLookbackBlocks: 1_000,
    enrichmentMaxPools: 500,
  },
  predictiveCache: {
    enabled: false,
    maxPaths: 500,
    precomputeCount: 50,
    refreshIntervalMs: 100,
  },
  mempool: {
    enabled: true,
    websocketUrl: "" as string, // optional
    coalesceTtlMs: 100,
    largeSwapThresholdUsd: 10_000,
  },
  observability: {
    metricsPort: 9090,
    logLevel: "info" as const,
    tuiEnabled: false,
  },
  paths: {
    dataDir: "data",
    dbFile: "registry.db",
    perfJsonFile: "perf.json",
  },
} as const;
