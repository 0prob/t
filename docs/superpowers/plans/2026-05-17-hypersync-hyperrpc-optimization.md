# Hypersync and HyperRPC Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve data retrieval performance and reliability by enabling streaming for Hypersync log fetches and refining error handling/failover for the HyperRPC multicall hydrator.

**Architecture:** We will update the `hypersync-client` configuration to enable proactive rate limit handling and introduce a stream-based consumption loop in `paginate.ts`. For HyperRPC, we will add error inspection to `state_multicall_hydrator.ts` to distinguish between transport-level failures (which trigger a global fallback cooldown) and expected execution-level reverts (which should not).

**Tech Stack:** TypeScript, `@envio-dev/hypersync-client`, `viem`, Node.js.

---

### Task 1: Update Hypersync Client Configuration

**Files:**
- Modify: `src/hypersync/client.ts`

- [ ] **Step 1: Write the failing test** (or rather, modify the implementation to support new fields, as configuration validation tests might not exist or be easy to target independently here. We'll update the `normalizeHypersyncClientConfig` function).

Modify `src/hypersync/client.ts` to include `proactiveRateLimitSleep` in the `HypersyncClientConfig` type and the normalization function.

```typescript
type HypersyncClientConfig = {
  url: string;
  apiToken: string;
  httpReqTimeoutMillis?: number;
  maxNumRetries?: number;
  retryBackoffMs?: number;
  retryBaseMs?: number;
  retryCeilingMs?: number;
  proactiveRateLimitSleep?: boolean; // ADD THIS
};
```

- [ ] **Step 2: Update the normalization function**

In `normalizeHypersyncClientConfig` inside `src/hypersync/client.ts`:

```typescript
export function normalizeHypersyncClientConfig(rawConfig: HypersyncClientConfig) {
  // ... existing code ...
  const retryBaseMs = normalizeOptionalClientInteger("retryBaseMs", rawConfig?.retryBaseMs);
  const retryCeilingMs = normalizeOptionalClientInteger("retryCeilingMs", rawConfig?.retryCeilingMs);
  
  // ADD THIS:
  let proactiveRateLimitSleep = rawConfig?.proactiveRateLimitSleep;
  if (proactiveRateLimitSleep !== undefined && typeof proactiveRateLimitSleep !== "boolean") {
     throw createHypersyncConfigError("proactiveRateLimitSleep must be a boolean.");
  }

  // ... existing check ...
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
    ...(proactiveRateLimitSleep !== undefined ? { proactiveRateLimitSleep } : {}), // ADD THIS
  };
}
```

- [ ] **Step 3: Update `config/index.ts` to enable proactive rate limiting**

Modify `src/config/index.ts` (assuming the client initialization uses it, though actually `client.ts` reads from `src/config/index.ts` constants. Let's see where the singleton is created. Ah, `src/hypersync/client.ts` itself reads environment variables if it exports the singleton. Wait, let's look at `src/hypersync/client.ts`. The singleton is created at the bottom:

```typescript
export const client = createHypersyncClient(hypersync, {
  url: HYPERSYNC_URL,
  apiToken: ENVIO_API_TOKEN,
  httpReqTimeoutMillis: HYPERSYNC_HTTP_REQ_TIMEOUT_MS,
  maxNumRetries: HYPERSYNC_MAX_RETRIES,
  retryBackoffMs: HYPERSYNC_RETRY_BACKOFF_MS,
  retryBaseMs: HYPERSYNC_RETRY_BASE_MS,
  retryCeilingMs: HYPERSYNC_RETRY_CEILING_MS,
  proactiveRateLimitSleep: true, // ADD THIS
});
```
*(Note: If the `client` export is at the bottom of `src/hypersync/client.ts`, add `proactiveRateLimitSleep: true` there).*

- [ ] **Step 4: Run typecheck to verify**

Run: `pnpm run typecheck` or `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hypersync/client.ts
git commit -m "feat(hypersync): support proactiveRateLimitSleep in config"
```

---

### Task 2: Implement Streaming Log Fetcher

**Files:**
- Modify: `src/hypersync/paginate.ts`

- [ ] **Step 1: Write the failing test / implementation**

We are replacing the `while (true)` loop with a stream. The `fetchAllLogsWithClient` function signature doesn't need to change drastically, but the internal logic must use `stream`. Note: `stream` requires the client to have the `stream` method. `HypersyncClientRuntime` already includes it: `stream: <T = unknown>(query: unknown, config: unknown) => Promise<T>;`.

Wait, the `stream` method returns a `Stream` object that has a `recv()` method, not the direct results. Let's update `HypersyncClientRuntime` in `src/hypersync/client.ts` first if needed. Looking at Context7 docs, `stream` returns an object with `.recv()`.

Let's modify `src/hypersync/client.ts` to define the stream interface:

```typescript
// In src/hypersync/client.ts
export type HypersyncStream<T> = {
  recv: () => Promise<HyperSyncGetResponse<T> | null>;
};

// Update HypersyncClientRuntime:
export type HypersyncClientRuntime = {
  // ...
  stream: <T = unknown>(query: unknown, config: unknown) => Promise<HypersyncStream<T>>;
  // ...
};
```
And in `createUnavailableHypersyncClient`:
```typescript
    stream: async () => throwUnsupportedHypersync(unavailableError),
```

Now, update `src/hypersync/paginate.ts`. 

```typescript
// Add type for stream config
type HyperSyncStreamConfig = {
  concurrency?: number;
  batchSize?: number;
};
```

Rewrite `fetchAllLogsWithClient` body in `src/hypersync/paginate.ts`:

```typescript
// inside src/hypersync/paginate.ts
export async function fetchAllLogsWithClient<TLog>(
  hypersyncClient: { 
    get: (query: HyperSyncLogQuery) => Promise<HyperSyncGetResponse<TLog>>,
    stream?: (query: HyperSyncLogQuery, config: HyperSyncStreamConfig) => Promise<{ recv: () => Promise<HyperSyncGetResponse<TLog> | null> }>
  },
  query: HyperSyncLogQuery,
  options: HyperSyncPaginationOptions = {},
): Promise<HyperSyncPageResult<TLog>> {
  // ... Keep initial block validation ...
  const initialFromBlock = parseBlockInteger("query fromBlock", query?.fromBlock);
  const initialToBlock = parseOptionalBlockInteger("query toBlock", query?.toBlock);
  if (initialToBlock != null && initialToBlock < initialFromBlock) {
    throw new Error(`HyperSync query has invalid block range: fromBlock ${initialFromBlock} exceeds toBlock ${initialToBlock}.`);
  }
  const maxPages = parsePositiveInteger("pagination maxPages", options.maxPages, 10_000);

  if (initialToBlock != null && initialToBlock === initialFromBlock) {
    return {
      logs: [],
      archiveHeight: null,
      rollbackGuard: null,
      nextBlock: initialFromBlock,
      pages: 0,
    };
  }

  const MAX_ACCUMULATED_LOGS = 5_000_000;
  const allLogs: TLog[] = [];
  let currentQuery = applyHistoricalHyperSyncQueryPolicy(query);
  let archiveHeight: number | null = null;
  let rollbackGuard: Record<string, unknown> | null = null;
  let lastNextBlock: number | null = null;
  let pages = 0;
  
  if (hypersyncClient.stream) {
    // USE STREAMING
    const stream = await hypersyncClient.stream(currentQuery, {
      concurrency: 10,
      batchSize: 1000,
    });

    while (true) {
      if (pages >= maxPages) {
        throw new Error(`HyperSync pagination exceeded maxPages ${maxPages} before reaching a terminal cursor.`);
      }
      
      const res = await stream.recv();
      if (res === null) {
         // Stream ended
         break;
      }
      pages++;

      if (res.archiveHeight != null) {
        archiveHeight = parseBlockInteger("response archiveHeight", res.archiveHeight);
      }
      if (res.rollbackGuard) {
        rollbackGuard = res.rollbackGuard;
      }

      const pageLogs = pageLogsFromResponse(res);
      if (pageLogs.length > 0) {
        if (allLogs.length + pageLogs.length > MAX_ACCUMULATED_LOGS) {
          throw new Error(
            `HyperSync pagination exceeded memory limit of ${MAX_ACCUMULATED_LOGS} logs (${allLogs.length} + ${pageLogs.length} from page ${pages}).`
          );
        }
        allLogs.push(...pageLogs);
      }

      const responseNextBlock = parseBlockInteger("response nextBlock cursor", res.nextBlock);
      lastNextBlock = clampNextBlockToExclusiveTarget(currentQuery, responseNextBlock);
      
      options.onProgress?.({
        pages,
        logs: allLogs.length,
        fromBlock: responseNextBlock, // approx
        nextBlock: lastNextBlock,
        archiveHeight,
      });
    }
  } else {
    // FALLBACK TO ORIGINAL GET LOOP (keep existing code here for safety if stream is not available)
    // (Ensure you retain the original `while(true)` get loop inside this else block)
  }

  return {
    logs: allLogs,
    archiveHeight,
    rollbackGuard,
    nextBlock: lastNextBlock,
    pages,
  };
}
```
*(Agentic worker note: Be careful to keep the existing `get` loop inside the `else` block to ensure backwards compatibility if the client doesn't support streaming).*

- [ ] **Step 2: Run typecheck to verify**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hypersync/client.ts src/hypersync/paginate.ts
git commit -m "perf(hypersync): implement streaming log fetcher"
```

---

### Task 3: Refine HyperRPC Multicall Error Handling

**Files:**
- Modify: `src/state/state_multicall_hydrator.ts`

- [ ] **Step 1: Write the refinement logic**

Update the `stateMulticallWithFallback` function in `src/state/state_multicall_hydrator.ts` to inspect the errors before disabling HyperRPC. If the error contains evidence of a contract execution revert, it is not a transport failure.

```typescript
// Add helper in src/state/state_multicall_hydrator.ts
function isExecutionRevertError(error: unknown): boolean {
  const msg = typeof error === "string" ? error : (error as Error)?.message || "";
  const lowerMsg = msg.toLowerCase();
  return lowerMsg.includes("execution reverted") || lowerMsg.includes("revert") || lowerMsg.includes("out of gas");
}
```

Update `stateMulticallWithFallback`:

```typescript
export async function stateMulticallWithFallback<T = StateMulticallResult[]>(params: StateMulticallParams): Promise<T> {
  if (hyperRpcMulticallAvailable) {
    if (hyperRpcMulticallDisabledAt > 0 && Date.now() >= hyperRpcMulticallDisabledAt) {
      hyperRpcMulticallDisabledAt = 0;
      stateHydratorLogger.info("[state_multicall_hydrator] HyperRPC cooldown elapsed — retrying");
    }
    if (hyperRpcMulticallDisabledAt === 0) {
      try {
        const hyperRpcMulticallClient = requireStateMulticallClient(hyperRpcStateClient, "HyperRPC state");
        const results = await hyperRpcMulticallClient.multicall<T>(params);
        if (Array.isArray(results) && results.length > 0 && results.every((r) => r?.status !== "success")) {
          // Check if it's just all reverts
          const allReverts = results.every(r => isExecutionRevertError(errorMessage(r.error)));
          
          if (!allReverts) {
             const firstError = results[0]?.status === "failure" ? errorMessage(results[0].error) : "unknown";
             hyperRpcMulticallDisabledAt = Date.now() + HYPERRPC_MULTICALL_RECOVERY_MS;
             stateHydratorLogger.warn(
               { firstError, count: results.length },
               "[state_multicall_hydrator] HyperRPC returned all failures (not execution reverts) — cooling down for %dms",
               HYPERRPC_MULTICALL_RECOVERY_MS,
             );
          } else {
             stateHydratorLogger.debug("[state_multicall_hydrator] HyperRPC returned all reverts, skipping cooldown");
             return results;
          }
        } else {
          return results;
        }
      } catch (err) {
        if (isEndpointCapabilityError(err, "eth_call")) {
          hyperRpcMulticallDisabledAt = Date.now() + HYPERRPC_MULTICALL_RECOVERY_MS;
          stateHydratorLogger.warn(
            "[state_multicall_hydrator] HyperRPC does not support multicall — cooling down for %dms",
            HYPERRPC_MULTICALL_RECOVERY_MS,
          );
        } else if (isExecutionRevertError(err)) {
          // It threw a revert error directly instead of returning it in the array
          stateHydratorLogger.debug("[state_multicall_hydrator] HyperRPC multicall threw revert, skipping cooldown");
          throw err; // Let it fall through to retry if necessary, or just throw
        } else {
          hyperRpcMulticallDisabledAt = Date.now() + HYPERRPC_MULTICALL_RECOVERY_MS;
          stateHydratorLogger.debug(
            { err, blockTag: params.blockTag, callCount: params.contracts.length },
            "[state_multicall_hydrator] HyperRPC multicall failed — cooling down for %dms",
            HYPERRPC_MULTICALL_RECOVERY_MS,
          );
        }
      }
    }
  }

  return multicallWithRetry<T>(params);
}
```

- [ ] **Step 2: Run typecheck to verify**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/state/state_multicall_hydrator.ts
git commit -m "fix(hyperrpc): prevent global cooldown on contract execution reverts"
```

---

### Task 4: Verify Live Behavior

- [ ] **Step 1: Build / lint**
Run `pnpm run lint` and fix any formatting issues.
Run `pnpm run typecheck` to ensure full project stability.

- [ ] **Step 2: Start bot in watch mode briefly**
Run `pnpm run start` and observe logs for 30 seconds. Ensure `[state_multicall_hydrator]` logs do not constantly show cooldowns unless the endpoint is actually down, and `[hypersync]` successfully uses streaming for backlog fetching without OOM.

- [ ] **Step 3: Commit any final tweaks**

```bash
git add .
git commit -m "chore: final adjustments for hypersync optimizations"
```
