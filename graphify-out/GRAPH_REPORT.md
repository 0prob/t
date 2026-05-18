# Graph Report - t  (2026-05-16)

## Corpus Check
- 183 files · ~156,294 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2675 nodes · 5807 edges · 117 communities (101 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 50 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `56e36f38`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 99|Community 99]]
- [[_COMMUNITY_Community 100|Community 100]]
- [[_COMMUNITY_Community 101|Community 101]]
- [[_COMMUNITY_Community 102|Community 102]]
- [[_COMMUNITY_Community 103|Community 103]]
- [[_COMMUNITY_Community 105|Community 105]]
- [[_COMMUNITY_Community 106|Community 106]]
- [[_COMMUNITY_Community 107|Community 107]]
- [[_COMMUNITY_Community 108|Community 108]]
- [[_COMMUNITY_Community 109|Community 109]]

## God Nodes (most connected - your core abstractions)
1. `RegistryService` - 62 edges
2. `normalizeEvmAddress()` - 57 edges
3. `normalizeProtocolKey()` - 40 edges
4. `RegistryPoolStore` - 34 edges
5. `PriceOracle` - 30 edges
6. `throttledMap()` - 29 edges
7. `toBigIntOrNull()` - 29 edges
8. `toBigInt()` - 26 edges
9. `PredictiveStateCache` - 25 edges
10. `readContractWithRetry()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `mergeCandidateBatch()` --calls--> `routeKeyFromEdges()`  [INFERRED]
  src/arb/search.ts → src/routing/finder.ts
- `normalisePoolAddress()` --calls--> `normalizeEvmAddress()`  [INFERRED]
  src/routing/route_cache.ts → src/utils/identity.ts
- `collectChunkPoolState()` --calls--> `normalizeEvmAddress()`  [INFERRED]
  src/routing/worker_pool.ts → src/utils/identity.ts
- `dedupeAffectedRoutes()` --calls--> `routeKeyFromEdges()`  [INFERRED]
  src/arb/route_revalidation.ts → src/routing/finder.ts
- `resolveSwapTokenIndexes()` --calls--> `normalizeAddress()`  [INFERRED]
  src/routing/swap_indices.ts → src/db/registry_codec.ts

## Communities (117 total, 16 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (64): CONFIG_DEFAULT_MIN_PROFIT_WEI, CONFIG_DEFAULT_SLIPPAGE_BPS, BALANCER_VAULT_SWAP_ABI, CURVE_EXCHANGE_INT128_ABI, CURVE_EXCHANGE_INT128_RECEIVER_ABI, CURVE_EXCHANGE_UINT256_ABI, CURVE_EXCHANGE_UINT256_USE_ETH_ABI, DODO_SELL_BASE_ABI (+56 more)

### Community 1 - "Community 1"
Cohesion: 0.03
Nodes (77): BootModeDeps, BotTelemetryLike, CandidateLike, CounterMetric, createDefaultPriceOracle(), createReorgRecoveryCoordinator(), createRunnerWatcherAdapters(), createTopologyService() (+69 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (43): arbsFound, candidateOptimizedCount, candidateProfitableCount, candidateProfitableYield, candidateShortlistSize, classifyEndpointType(), classifyWatcherHaltReason(), Counter (+35 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (91): BIGINT_ARRAY_FIELDS, BIGINT_SCALAR_FIELDS, isRecord(), JsonRecord, lowerCaseAddressList(), mapArbHistoryRow(), mapPoolMetaRow(), mapPoolRow() (+83 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (29): V3_BITMAP_MULTICALL_CHUNK_SIZE, V3_TICKS_MULTICALL_CHUNK_SIZE, fetchKyberInitializedTickWindow(), fetchKyberTickData(), fetchPoolCore(), fetchTickBitmap(), fetchTickBitmapWindow(), fetchTickBitmapWordRange() (+21 more)

### Community 6 - "Community 6"
Cohesion: 0.08
Nodes (38): logAttemptStage(), stageFromBuiltTx(), AccountLike, adaptiveReceiptTimeoutMs(), asTxHash(), classifySubmissionError(), clearTrackedReceipt(), DryRunResult (+30 more)

### Community 7 - "Community 7"
Cohesion: 0.11
Nodes (47): ACTIVITY_BY_EVENT, activityDetailForLog(), activityLabelForLog(), appendOperatorLog(), augmentQuietPoolHydrationAlignment(), buildHub4HydrationAlignment(), cleanText(), coreHubCooldownDetailForProtocol() (+39 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (44): ArbActivityTrackerOptions, CONSOLE_LEVELS, ConsoleMethod, createArbActivityTracker(), createCurrentFeeSnapshotReader(), createInitialBotState(), createOperatorLogger(), CurrentFeeSnapshotReaderDeps (+36 more)

### Community 9 - "Community 9"
Cohesion: 0.05
Nodes (38): _allUrls, _bool(), CONFIGURED_ROUTING_MAX_HOPS, CYCLE_REFRESH_INTERVAL_MS, DATA_DIR, _dedupeRpcUrls(), _defaultFreeRpcs, __dirname (+30 more)

### Community 10 - "Community 10"
Cohesion: 0.14
Nodes (29): compareHyperSyncLogs(), hyperSyncLogIdentityKey(), HyperSyncRawLog, NormalizedHyperSyncLogMeta, normalizeHyperSyncLogInteger(), normalizeHyperSyncLogMeta(), topicArrayFromHyperSyncLog(), compareRollbackGuards() (+21 more)

### Community 11 - "Community 11"
Cohesion: 0.1
Nodes (22): HYPERRPC_URL, ALGEBRA_GLOBAL_STATE_ABI, fetchV3PoolCoreSnapshots(), hyperRpcStateClient, requireStateMulticallClient(), stateHydratorLogger, StateMulticallClient, StateMulticallContract (+14 more)

### Community 12 - "Community 12"
Cohesion: 0.09
Nodes (26): buildTransferTx(), BigIntInput, bufferedGasLimit(), capGasFeesToBudget(), clampBigInt(), clearGasEstimateCache(), FeeSnapshot, gasEstimateCache (+18 more)

### Community 13 - "Community 13"
Cohesion: 0.08
Nodes (33): addPoolsForPackedV3Paths(), addPoolsForTokenPath(), buildPoolTokenPairIndex(), createPendingTxStateWatcher(), createPoolTokenPairIndexCache(), extractEncodedAddresses(), extractEncodedAddressesInOrder(), isV3FamilyProtocol() (+25 more)

### Community 14 - "Community 14"
Cohesion: 0.08
Nodes (31): HYPERSYNC_BATCH_SIZE, HYPERSYNC_MAX_ADDRESS_FILTER, HYPERSYNC_MAX_BLOCKS_PER_REQUEST, HYPERSYNC_MAX_FILTERS_PER_REQUEST, buildHyperSyncLogQuery(), DEFAULT_HYPERSYNC_BLOCK_FIELDS, DEFAULT_HYPERSYNC_LOG_FIELDS, fieldKey() (+23 more)

### Community 15 - "Community 15"
Cohesion: 0.1
Nodes (33): assertDecodedLogsAligned(), buildDiscoveryScanQuery(), decodeDiscoveryLogs(), discoverCurveRemovals(), discoverPools(), DiscoverPoolsDeps, discoverPoolsWithDeps(), discoverProtocol() (+25 more)

### Community 17 - "Community 17"
Cohesion: 0.2
Nodes (31): defaultRates(), asStateRecord(), asStateRecordOrNull(), BigIntLike, nonNegativeBigInt(), normalizeBalancerState(), normalizeBigIntList(), normalizeCurveState() (+23 more)

### Community 18 - "Community 18"
Cohesion: 0.18
Nodes (15): getBalancerTokens(), normalizeAddressList(), getCurveTokens(), decode(), enrichTokens(), decode(), enrichTokens(), createRpcTokenProtocol() (+7 more)

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (27): compareDeferredHydrationCohortPriority(), compareDeferredHydrationPriority(), countTokenMatches(), hubClassBreakdown(), hubClassYieldBreakdown(), hydrationYield(), LoggerFn, LogLevel (+19 more)

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (28): ENRICH_CONCURRENCY, CURVE_PROTOCOLS, A_ABI, buildCurveRawState(), CurveBalanceList, CurveNumberish, CurveRawStateArgs, FEE_ABI (+20 more)

### Community 21 - "Community 21"
Cohesion: 0.18
Nodes (16): roiForCandidate(), applySlippage(), computeProfit(), flashLoanFeeInTokenUnits(), gasCostWei(), invalidAssessment(), isProfitable(), ProfitAssessment (+8 more)

### Community 22 - "Community 22"
Cohesion: 0.11
Nodes (29): CONFIG_JSON_RPC_TIMEOUT_MS, FREE_RPC_URLS, BundleOptions, FAST_PUBLIC_RPCS, isAlreadyKnownSubmission(), jsonRpc(), JsonRpcErrorPayload, JsonRpcHeaders (+21 more)

### Community 23 - "Community 23"
Cohesion: 0.09
Nodes (21): booleanOption(), buildChunkStateObject(), buildStateDelta(), collectChunkPoolAddresses(), collectChunkPoolState(), estimateEnumerationTokenWork(), getStateVersion(), importIdx (+13 more)

### Community 25 - "Community 25"
Cohesion: 0.16
Nodes (26): annotatePath(), anyNonPositiveBigInt(), compareByPathLogWeight(), dodoLogWeight(), edgeSpotLogWeight(), finalizeTopPaths(), find2HopPaths(), find3HopPaths() (+18 more)

### Community 26 - "Community 26"
Cohesion: 0.23
Nodes (14): getSqrtRatioAtTick(), getTickAtSqrtRatio(), getTickAtSqrtRatioInRange(), normaliseTickSearchBounds(), asPoolState(), asTickData(), getSortedTicks(), nextInitializedTickOptimized() (+6 more)

### Community 27 - "Community 27"
Cohesion: 0.07
Nodes (27): dependencies, @envio-dev/hypersync-client, pino, tsx, viem, devDependencies, eslint, eslint-config-prettier (+19 more)

### Community 28 - "Community 28"
Cohesion: 0.1
Nodes (26): HYPERSYNC_HTTP_REQ_TIMEOUT_MS, HYPERSYNC_MAX_RETRIES, HYPERSYNC_RETRY_BACKOFF_MS, HYPERSYNC_RETRY_BASE_MS, HYPERSYNC_RETRY_CEILING_MS, createHypersyncClient(), createHypersyncConfigError(), createUnavailableHypersyncClient() (+18 more)

### Community 29 - "Community 29"
Cohesion: 0.05
Nodes (56): seedNewPoolsIntoStateCache(), CachedPoolFee, CachedTokenMeta, RegistryAssetCache, AssetDatabase, assetStmt(), batchUpsertTokenMeta(), getAllTokenAddresses() (+48 more)

### Community 30 - "Community 30"
Cohesion: 0.09
Nodes (19): ArbPathLike, EdgeLookupGraph, PersistentRouteCycleCache, SerializedPathLike, EvaluationResult, SerializedEnumeratedPath, SerializedEvaluationEdge, SerializedEvaluationPath (+11 more)

### Community 31 - "Community 31"
Cohesion: 0.14
Nodes (16): HYPERSYNC_TARGETED_BACKFILL_LOOKBACK_BLOCKS, HYPERSYNC_TARGETED_BACKFILL_MAX_POOLS, client, enqueueWatcherEnrichment(), EnqueueWatcherEnrichmentOptions, enrichmentErrorMessage(), EpochWatcherEnrichmentTask, normalizeEnrichmentAddress() (+8 more)

### Community 32 - "Community 32"
Cohesion: 0.09
Nodes (26): createHeartbeatController(), createWatcherConfigurator(), configureWatcherCallbacks(), createArbScheduler(), createShutdownHandler(), LoggerFn, LogLevel, ShutdownReason (+18 more)

### Community 33 - "Community 33"
Cohesion: 0.09
Nodes (25): createQuietPoolSweepCoordinator(), createDiscoveryRefreshCoordinator(), createRunnerHydrationAdapters(), FetchAndCacheOptions, LoggerFn, LogLevel, PoolState, RunnerHydrationAdaptersDeps (+17 more)

### Community 34 - "Community 34"
Cohesion: 0.1
Nodes (21): executeWithRpcRetry(), MulticallClient, MulticallFailureResult, MulticallWithRetryParams, ReadContractClient, rpcManagerShortUrl(), RpcRetryDelayMessageFactory, RpcRetryEndpoint (+13 more)

### Community 35 - "Community 35"
Cohesion: 0.06
Nodes (35): createOpportunityRouteCacheAdapters(), RunnerEnv, createRunnerApp(), ProcessSignalRegistrar, RunnerAppDeps, WatcherCallbackTargetLike, createBootModeCoordinator(), createPassRunner() (+27 more)

### Community 36 - "Community 36"
Cohesion: 0.08
Nodes (29): ExecutionQuarantine, buildRunnerOpportunityEngineConfig(), createRunnerOpportunityEngine(), createRunnerOpportunityEngineWithPredictiveCache(), FeeSnapshot, LoggerFn, refreshCandidateBeforeExecution(), RunnerOpportunityEngineDeps (+21 more)

### Community 37 - "Community 37"
Cohesion: 0.09
Nodes (19): CHAINLINK_ABI, KNOWN_DECIMALS, PairQuote, PIVOT_TOKENS, PoolMetaLike, PoolQuote, PriceOracleRegistry, TokenMetaLike (+11 more)

### Community 38 - "Community 38"
Cohesion: 0.09
Nodes (26): HYPERSYNC_WATCHER_IDLE_SLEEP_MS, calculateAdaptiveSleepMs(), waitForWatcherHeightAdvance(), WaitForWatcherHeightAdvanceOptions, handleWatcherPollResponse(), WatcherLoopLogger, WatcherLoopRegistry, WatcherLoopRunnerLogger (+18 more)

### Community 39 - "Community 39"
Cohesion: 0.12
Nodes (15): V2_RESERVES_MULTICALL_CHUNK_SIZE, StateReadBlockTag, V2_GET_RESERVES_ABI, fetchMultipleV2States(), fetchMultipleV2StatesWithDeps(), V2FetchOptions, V2MulticallResult, V2Numberish (+7 more)

### Community 40 - "Community 40"
Cohesion: 0.05
Nodes (55): PROTOCOL_ROUTERS, ROUTER_REQUIRED_PROTOCOLS, V3_SWAP_PROTOCOLS(), BALANCER_PROTOCOLS, CURVE_CRYPTO_PROTOCOLS, CURVE_STABLE_PROTOCOLS, DODO_PROTOCOLS, isSwapExecutionProtocol() (+47 more)

### Community 41 - "Community 41"
Cohesion: 0.12
Nodes (11): CachedAssessment, CachedEntry, CachedPath, CachedResult, hasValidPoolEdges(), normalisePoolAddress(), normalizedRoutePools(), profitFromAssessment() (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.12
Nodes (6): buildEnumerationChunks(), buildEvaluationChunks(), isUsableSlot(), serialisedPathKey(), summariseEvaluationChunks(), WorkerPool

### Community 43 - "Community 43"
Cohesion: 0.13
Nodes (22): createWatcherProtocolHandlers(), allowsObservedDodoWatcherState(), allowsObservedUnroutableWatcherState(), allowsZeroLiquidityWatcherState(), cloneWatcherState(), commitWatcherState(), errorMessage(), errorValidationReason() (+14 more)

### Community 44 - "Community 44"
Cohesion: 0.11
Nodes (22): ExecutableCandidate, createExecutionCoordinator(), createOpportunityEngine(), OpportunityEngineDeps, CandidatePipelineResult, collectRoutePoolRecordsForRefresh(), createArbSearcher(), FeeSnapshot (+14 more)

### Community 45 - "Community 45"
Cohesion: 0.11
Nodes (17): profitMarginBps(), RouteResultLike, CandidateRefreshContext, CandidateRefreshResult, ExecutionClientConfig, ExecutionCoordinatorDeps, ExecutionSubmitOptions, ExecutionSubmitResult (+9 more)

### Community 46 - "Community 46"
Cohesion: 0.14
Nodes (21): CycleEnumerationOptions, CycleGraph, DEFAULTS, enumerateCycles(), enumerateCyclesDual(), enumerateCyclesForToken(), normalizePathBudget(), normalizeTokenSet() (+13 more)

### Community 48 - "Community 48"
Cohesion: 0.14
Nodes (18): deriveOnChainMinProfit(), AssessmentConfig, assessmentNetProfit(), AssessmentOptimizationOptions, assessRouteResult(), CandidateEntry, compareAssessmentProfit(), getAssessmentOptimizationOptions() (+10 more)

### Community 49 - "Community 49"
Cohesion: 0.17
Nodes (19): computeFee(), computeGasAdjustedProfit(), computePoolPriceQuote(), computePrice(), computeSlippageBps(), computeSpotPriceScaled(), computeSqrtPrice(), computeVirtualAmountOutAfterFees() (+11 more)

### Community 50 - "Community 50"
Cohesion: 0.11
Nodes (22): WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE, V3FetchOptions, V3StateMap, EFFECTIVE_WARMUP_V3_PROGRESS_PERSIST_BATCH_SIZE, EMPTY_PROTOCOL_STATS, FetchAndCacheOptions, FetchLogContext, hasBigIntLikeValue() (+14 more)

### Community 51 - "Community 51"
Cohesion: 0.18
Nodes (19): defaultStartTui(), age(), fmt(), fmtDur(), fmtProgress(), fmtWei(), latestEvent(), latestMatch() (+11 more)

### Community 52 - "Community 52"
Cohesion: 0.18
Nodes (14): protocol, protocol, createCurveListedFactoryProtocol(), CurveListedFactoryOptions, decodedBodyValue(), decodedEventName(), DecodedRawLog, decodedValue() (+6 more)

### Community 53 - "Community 53"
Cohesion: 0.16
Nodes (22): errorMessage(), fetchAndNormalizeBalancerPool(), fetchBalancerPoolState(), fetchBalancerStableState(), GET_AMPLIFICATION_PARAMETER_ABI, GET_BPT_INDEX_ABI, GET_NORMALIZED_WEIGHTS_ABI, GET_POOL_ID_ABI (+14 more)

### Community 54 - "Community 54"
Cohesion: 0.11
Nodes (23): metadataWithRegistryTokenDecimals(), V3PoolState, canCommit(), DEFAULT_WATCHER_REFRESHERS, refreshBalancerWatcherPool(), refreshCurveWatcherPool(), refreshDodoWatcherPool(), refreshNormalizedWatcherPool() (+15 more)

### Community 55 - "Community 55"
Cohesion: 0.12
Nodes (24): gasCostInTokenUnits(), CandidateAssessmentSummary, CandidateAssessmentWorkResult, evaluateCandidatePipeline(), recordAssessmentReject(), CandidateEntryLike, CandidatePathLike, CandidateResultLike (+16 more)

### Community 56 - "Community 56"
Cohesion: 0.11
Nodes (16): RouteStateCache, CORE_STATE_KEYS, mergeStateIntoCache(), PendingEnrichmentMap, RegistryCacheSource, RegistryPoolRecord, reloadCacheFromRegistry(), WatcherAddressFilter (+8 more)

### Community 57 - "Community 57"
Cohesion: 0.18
Nodes (12): isAlgebraPool(), metadataFee(), PollUniv3, parsePoolMetadata(), asPoolObject(), getPoolMetadata(), getPoolTokens(), metadataCache (+4 more)

### Community 58 - "Community 58"
Cohesion: 0.16
Nodes (18): fetchBlockRollbackGuard(), DEFAULT_POLYGON_TOKEN_CANDIDATES, discoverWoofiPool(), hasLiveWoofiBase(), parseConfiguredTokens(), readWoofiAddress(), registryTokenCandidates(), requireWoofiRegistry() (+10 more)

### Community 59 - "Community 59"
Cohesion: 0.14
Nodes (3): getRpcManagerInstance(), initRpcManager(), RpcManager

### Community 60 - "Community 60"
Cohesion: 0.15
Nodes (19): multicallWithRetry(), CurveFactoryPool, CurveFactoryRegistry, CurveTokenMetadataRegistry, DiscoverCurveFactoryOptions, discoverCurveListedFactory(), discoverFactoryIndexesToScan(), discoverStartIndex() (+11 more)

### Community 61 - "Community 61"
Cohesion: 0.14
Nodes (17): buildWatcherAddressFilter(), extendWatcherAddressFilter(), ExtendWatcherAddressFilterResult, updateWatcherAddressFilter(), WatcherAddressFilter, WatcherAddressFilterUpdate, normalizeWatchedAddresses(), initializeWatcherStart() (+9 more)

### Community 62 - "Community 62"
Cohesion: 0.12
Nodes (39): absDiff(), asPoolState(), BalancerPoolState, calculateBalancerStableInvariant(), exp(), getBalancerAmountIn(), getBalancerAmountOut(), getBalancerStableAmountOut() (+31 more)

### Community 63 - "Community 63"
Cohesion: 0.15
Nodes (22): EVAL_WORKER_THRESHOLD, simulateDodoSwap(), EvaluatedRoute, EvaluatePathsOptions, RouteOptimizationOptions, RouteSimulationResult, RouteState, SimulationEdge (+14 more)

### Community 64 - "Community 64"
Cohesion: 0.16
Nodes (11): resolveWatcherPollError(), ResolveWatcherPollErrorOptions, WatcherPollErrorResolution, WatcherPollErrorTracker, WatcherPollRecoveryMeta, classifyWatcherPollError(), watcherErrorBackoffMeta(), watcherErrorBackoffMs() (+3 more)

### Community 65 - "Community 65"
Cohesion: 0.2
Nodes (17): computeResourceTunedRunParameters(), cpuHeadroomConcurrency(), detectMaxCpuTemperatureC(), detectSystemResources(), detectThermalState(), memoryPressure(), nonNegativeFinite(), normalizeThermalMilliC() (+9 more)

### Community 66 - "Community 66"
Cohesion: 0.12
Nodes (20): createWatcherLogHandler(), WatcherLogDecoder, WatcherLogHandler, WatcherLogHandlerOptions, WatcherLogHandlerRegistry, WatcherLogHandlerStateAdapters, WATCHER_SIGNATURES, createWatcherRefreshAdapters() (+12 more)

### Community 67 - "Community 67"
Cohesion: 0.2
Nodes (17): readContractWithRetry(), ERC20_DECIMALS_ABI, fetchMultipleWoofiStates(), fetchOracleState(), fetchTokenInfo(), fetchWoofiBaseState(), fetchWoofiPoolState(), pow10() (+9 more)

### Community 68 - "Community 68"
Cohesion: 0.2
Nodes (11): DODO_DPP, DODO_DSP, DODO_DVM, createPairCreatedProtocol(), createUniV3PoolProtocol(), FULLY_SUPPORTED_CAPABILITIES, buildProtocols(), CURVE_POOL_REMOVED (+3 more)

### Community 69 - "Community 69"
Cohesion: 0.15
Nodes (7): createExecutionClient(), createExecutionReadClient(), EXECUTION_RPC_URL, GAS_ESTIMATION_RPC_URL, POLYGON_RPC_URL, POLYGON_RPC_URLS, ExecutorClient

### Community 70 - "Community 70"
Cohesion: 0.18
Nodes (14): assertWatcherStateField(), isWatcherTickState(), toMutableWatcherState(), WatcherProtocolHandlerDeps, DecodedWatcherLog, DecodedWatcherLogValue, MutableWatcherState, V3WatcherTickState (+6 more)

### Community 71 - "Community 71"
Cohesion: 0.17
Nodes (16): BigIntish, DODO_DIRECT_FEE_ABI, DODO_TOKEN_ABI, DodoFeeRates, DodoFetchResult, DodoPoolState, DodoStateMap, fetchDodoFeeRates() (+8 more)

### Community 73 - "Community 73"
Cohesion: 0.48
Nodes (6): normaliseRouteSegment(), requireRouteAddress(), routeExecutionCacheKey(), routeIdentityFromEdges(), routeIdentityFromSerializedPath(), serialiseEvaluationPath()

### Community 74 - "Community 74"
Cohesion: 0.11
Nodes (6): throttledMap(), PollBalancer, PollCurve, PollDodo, PollWoofi, fetchMultipleV3States()

### Community 75 - "Community 75"
Cohesion: 0.2
Nodes (9): isRunning(), runWatcherLoop(), isRollbackGuardMismatchError(), watcherShardRetryDelayMs(), pollWatcherOnce(), PollWatcherOnceOptions, WatcherPollGetter, WatcherPollingLogger (+1 more)

### Community 76 - "Community 76"
Cohesion: 0.21
Nodes (14): ArbHistoryOptions, ArbResultInput, ArbStatsByHopRow, ArbStatsTotalsRow, getArbHistory(), getArbStats(), HistoryDatabase, historyStmt() (+6 more)

### Community 77 - "Community 77"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, esModuleInterop, module, moduleResolution, noEmit, noUnusedLocals, noUnusedParameters (+5 more)

### Community 78 - "Community 78"
Cohesion: 0.18
Nodes (3): clearPendingWatcherEnrichment(), watcherFilterMode(), StateWatcher

### Community 79 - "Community 79"
Cohesion: 0.2
Nodes (5): RegistryHistoryStore, ColumnInfo, hasColumn(), initRegistrySchema(), SQLInputValue

### Community 81 - "Community 81"
Cohesion: 0.25
Nodes (13): clampNextBlockToExclusiveTarget(), fetchAllLogs(), fetchAllLogsWithClient(), HyperSyncPageResult, HyperSyncPaginationOptions, HyperSyncPaginationProgress, isTerminalBoundedCursor(), pageLogsFromResponse() (+5 more)

### Community 82 - "Community 82"
Cohesion: 0.11
Nodes (13): createDecimalAwarePoolStateFetchers(), createRegistryReadAccess(), createRouteFreshnessReader(), createPricingService(), PriceOracleLike, PricingServiceDeps, TokenMetaLike, createRunnerMarketDataAdapters() (+5 more)

### Community 83 - "Community 83"
Cohesion: 0.53
Nodes (10): divRoundingUp(), mulDiv(), mulDivRoundingUp(), getAmount0Delta(), getAmount1Delta(), getNextSqrtPriceFromAmount0RoundingUp(), getNextSqrtPriceFromAmount1RoundingDown(), getNextSqrtPriceFromInput() (+2 more)

### Community 85 - "Community 85"
Cohesion: 0.17
Nodes (7): createRpcClient(), RpcClient, SniperResult, SUBMISSION_METHOD, SubmissionError, SubmissionResult, TransactionSniper

### Community 86 - "Community 86"
Cohesion: 0.32
Nodes (12): asPoolState(), CurvePoolState, getCurveAmountIn(), getCurveAmountOut(), getD(), getY(), hasValidCurveIndexes(), simulateCurveSwap() (+4 more)

### Community 87 - "Community 87"
Cohesion: 0.15
Nodes (10): paths, profitable, rehydrateAndStoreState(), response, retained, serialised, workerStateMap, WorkerErrorResponse (+2 more)

### Community 88 - "Community 88"
Cohesion: 0.2
Nodes (9): AttemptEndpointResult, AttemptLogEntry, attemptLogger, AttemptOutcome, AttemptStage, nextAttemptId(), redactPrivateKey(), setAttemptLogSink() (+1 more)

### Community 89 - "Community 89"
Cohesion: 0.24
Nodes (9): CONFIG_DEFAULT_GAS_BUFFER_BPS, createGasEstimationClient(), estimateGas(), estimateGas(), getGasClient(), simulateCall(), dryRun(), getRevertReason() (+1 more)

### Community 92 - "Community 92"
Cohesion: 0.2
Nodes (10): BotTelemetryDeps, CandidateMetricsUpdate, CounterMetric, createBotTelemetry(), ObserverMetric, PassErrorStateUpdate, PassStateUpdate, BotActivityProgress (+2 more)

### Community 94 - "Community 94"
Cohesion: 0.24
Nodes (5): PoolMetaMap, RegistryMetaCache, RegistryPoolMeta, RegistryStatementFactory, loadPoolMetaCache()

### Community 96 - "Community 96"
Cohesion: 0.29
Nodes (10): decodedBigInt(), decodedValue(), ensureV3Fee(), isTickRecord(), normalizeWatcherTicks(), tickEntriesFrom(), toTickBigInt(), updateTickState() (+2 more)

### Community 97 - "Community 97"
Cohesion: 0.2
Nodes (8): BalanceAllowance, ERC20_BALANCE_ABI, ERC20_META_ABI, fetchBalanceAndAllowance(), multicall(), MulticallCall, MulticallResult, TokenMetadata

### Community 98 - "Community 98"
Cohesion: 0.15
Nodes (17): BalancerPoolTokensResult, BalancerReadContract, GET_POOL_TOKENS_ABI, CurveReadContract, GET_COINS_ABI, normalizeCurveTokenList(), isNoDataReadContractError(), ReadContractWithRetryParams (+9 more)

### Community 99 - "Community 99"
Cohesion: 0.23
Nodes (3): ensureHttps(), lazyMetrics(), RpcEndpoint

### Community 100 - "Community 100"
Cohesion: 0.28
Nodes (8): buildDiscoveredPoolBatch(), compareDiscoveryOrder(), DiscoveredPoolCandidate, DiscoveryBatchEntry, discoveryLogger, DiscoveryRawLog, normalizeDiscoveryMetadata(), DecodeResult

### Community 105 - "Community 105"
Cohesion: 0.56
Nodes (7): checkpointStmt(), getCheckpoint(), getGlobalCheckpoint(), getRollbackGuard(), rollbackToBlock(), setCheckpoint(), setRollbackGuard()

### Community 106 - "Community 106"
Cohesion: 0.21
Nodes (6): effectiveGasPriceWei(), ensureFreshGasOracle(), fetchEIP1559Fees(), GasOracle, isGasOracleStale(), quickGasCheck()

### Community 108 - "Community 108"
Cohesion: 0.4
Nodes (4): AbiExpectation, CONTRACT_CATALOG, ContractCatalogEntry, UNISWAP_V2_PAIR_CREATED_EXPECTATION

## Knowledge Gaps
- **732 isolated node(s):** `runnerApp`, `target`, `module`, `moduleResolution`, `noEmit` (+727 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RegistryService` connect `Community 3` to `Community 1`, `Community 35`, `Community 15`, `Community 79`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `normalizeEvmAddress()` connect `Community 29` to `Community 0`, `Community 1`, `Community 4`, `Community 10`, `Community 13`, `Community 14`, `Community 17`, `Community 23`, `Community 40`, `Community 41`, `Community 57`, `Community 58`, `Community 60`, `Community 63`, `Community 67`, `Community 71`, `Community 73`, `Community 82`, `Community 87`, `Community 94`, `Community 100`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `logger` connect `Community 37` to `Community 1`, `Community 2`, `Community 35`, `Community 36`, `Community 100`, `Community 6`, `Community 43`, `Community 11`, `Community 79`, `Community 15`, `Community 85`, `Community 23`, `Community 88`, `Community 60`, `Community 29`, `Community 31`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `normalizeEvmAddress()` (e.g. with `normalisePoolAddress()` and `collectChunkPoolState()`) actually correct?**
  _`normalizeEvmAddress()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `normalizeProtocolKey()` (e.g. with `poolLiquidityWmatic()` and `isSupportedWarmupProtocol()`) actually correct?**
  _`normalizeProtocolKey()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **What connects `runnerApp`, `target`, `module` to the rest of the system?**
  _732 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._