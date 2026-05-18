# Optimize Config and Singleton Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize `viem` clients in `src/config/rpc_env.ts` by enabling JSON-RPC batching, tuning multicall wait time, and adding `Connection: keep-alive` headers to reduce RPC overhead.

**Architecture:** Update the singleton client factory functions to include performance-oriented configurations.

**Tech Stack:** TypeScript, viem

---

### Task 1: Update `createGasEstimationClient`

**Files:**
- Modify: `src/config/rpc_env.ts`

- [ ] **Step 1: Update `createGasEstimationClient` implementation**

Update `createGasEstimationClient` to enable `jsonRpc` batching, set multicall `wait` to 16ms, and add `Connection: keep-alive` header.

```typescript
export function createGasEstimationClient() {
  if (_gasEstimationClient) return _gasEstimationClient;
  _gasEstimationClient = createPublicClient({
    chain: polygon,
    transport: http(GAS_ESTIMATION_RPC_URL, {
      // Tight timeout — if the simulation RPC is slow, fail fast and skip the
      // opportunity rather than holding up the hot path.
      timeout: 5_000,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
    batch: { 
      multicall: { wait: 16 },
      jsonRpc: true
    },
  });
  return _gasEstimationClient;
}
```

### Task 2: Update `createExecutionClient`

**Files:**
- Modify: `src/config/rpc_env.ts`

- [ ] **Step 1: Update `createExecutionClient` implementation**

Update `createExecutionClient` to add `Connection: keep-alive` header.

```typescript
export function createExecutionClient(account: Parameters<typeof createWalletClient>[0]["account"]) {
  if (_executionWalletClient) {
    if (account == null) return _executionWalletClient;
    return _executionWalletClient;
  }
  if (account == null) {
    throw new Error("createExecutionClient: account parameter is required for first initialization");
  }
  _executionWalletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(EXECUTION_RPC_URL, {
      timeout: 10_000,
      retryCount: 0,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
  });
  return _executionWalletClient;
}
```

### Task 3: Update `createExecutionReadClient`

**Files:**
- Modify: `src/config/rpc_env.ts`

- [ ] **Step 1: Update `createExecutionReadClient` implementation**

Update `createExecutionReadClient` to enable `jsonRpc` batching, set multicall `wait` to 16ms, and add `Connection: keep-alive` header.

```typescript
export function createExecutionReadClient() {
  if (_executionReadClient) return _executionReadClient;
  _executionReadClient = createPublicClient({
    chain: polygon,
    transport: http(EXECUTION_RPC_URL, {
      timeout: 10_000,
      retryCount: 0,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
    batch: { 
      multicall: { wait: 16 },
      jsonRpc: true
    },
  });
  return _executionReadClient;
}
```

### Task 4: Verification and Commit

- [ ] **Step 1: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 2: Commit changes**

```bash
git add src/config/rpc_env.ts
git commit -m "perf(viem): optimize singleton clients with batching and keep-alive"
```
