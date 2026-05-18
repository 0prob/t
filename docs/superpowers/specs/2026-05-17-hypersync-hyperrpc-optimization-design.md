# Design Spec: Hypersync and HyperRPC Optimization

**Date:** 2026-05-17
**Topic:** Troubleshooting, repairing, and optimizing Hypersync and HyperRPC usage.
**Status:** Approved by User

## 1. Overview
The goal of this task is to improve the performance and reliability of data retrieval using Envio's Hypersync and HyperRPC services. Current implementations are functional but do not fully leverage parallelization (Hypersync) and are overly aggressive in failing over to slower public RPCs (HyperRPC).

## 2. Hypersync Optimization: Streaming log fetcher

### 2.1 Problem
`src/hypersync/paginate.ts` uses sequential `client.get()` calls. For large historical scans, this is latency-bound and inefficient.

### 2.2 Solution
Introduce a streaming log fetcher using `client.stream()`.

*   **Implementation:**
    *   Refactor `fetchAllLogsWithClient` to detect if a "streaming" mode is preferred (or make it the default).
    *   Use `client.stream(query, { concurrency: 10, batchSize: 1000 })`.
    *   Consume the stream using an async iterator/loop: `while(true) { const res = await stream.recv(); if (res === null) break; ... }`.
*   **Error Handling:**
    *   Ensure `proactiveRateLimitSleep` is enabled in the client config to handle Envio's rate limits gracefully within the stream.
*   **Safety:**
    *   Maintain the existing `MAX_ACCUMULATED_LOGS` limit to prevent OOM errors.

## 3. HyperRPC Optimization: Refined Multicall Hydrator

### 3.1 Problem
`src/state/state_multicall_hydrator.ts` disables the HyperRPC lane for 60 seconds if any error occurs. This includes contract-level reverts which are expected for some pool types or states.

### 3.2 Solution
Differentiate between "Network/Protocol errors" and "Execution errors".

*   **Logic:**
    *   If `multicall` returns results where *all* calls failed with `status: "failure"`, investigate the error types.
    *   Only disable HyperRPC if the error is a transport error (429, 5xx, timeout) or a "method not supported" error.
    *   If the error is an EVM revert (e.g., "execution reverted"), treat it as a valid (though failed) response and do NOT trigger the global cooldown.
*   **Client Tuning:**
    *   Increase `fetchOptions: { headers: { Connection: "keep-alive" } }` (already present, but verify effectiveness).
    *   Ensure `batch: { multicall: true }` in Viem is correctly utilized for high-density packing.

## 4. Configuration & Client Factory

### 4.1 Changes
*   Update `src/hypersync/client.ts` to include all relevant `ClientConfig` options:
    *   `retryBaseMs`
    *   `retryCeilingMs`
    *   `proactiveRateLimitSleep`
*   Add more granular logging for Hypersync page transitions and HyperRPC status changes.

## 5. Verification Plan

### 5.1 Automated Tests
*   **Unit Tests:** Verify `normalizeHypersyncClientConfig` correctly handles the new fields.
*   **Mocked Stream Test:** Create a test case that mocks the `stream.recv()` interface to ensure logs are correctly accumulated.
*   **Multicall Error Test:** Simulate a revert from HyperRPC and verify it doesn't trigger the 60s cooldown.

### 5.2 Manual Verification
*   Run the bot with `--live` and monitor logs for `[state_multicall_hydrator]` and `[hypersync]` to verify the "warm-path" lane stays active and log fetching is fast.
