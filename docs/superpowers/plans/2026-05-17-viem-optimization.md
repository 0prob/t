# Viem Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize viem usage across the project to reduce RPC overhead and latency by enabling JSON-RPC batching, tuning multicall packing, and standardizing transport settings.

**Architecture:** We will apply consistent `batch` and `transport` configurations to all viem clients. This includes enabling `jsonRpc` batching to bundle independent requests and adding a small `wait` time to `multicall` batching to increase packing density.

**Tech Stack:** TypeScript, viem.

---

### Task 1: Optimize Config and Singleton Clients

**Files:**
- Modify: `src/config/rpc_env.ts`

- [ ] **Step 1: Update `createGasEstimationClient`**

Enable JSON-RPC batching and tune multicall wait time.

```typescript
export function createGasEstimationClient() {
  if (_gasEstimationClient) return _gasEstimationClient;
  _gasEstimationClient = createPublicClient({
    chain: polygon,
    transport: http(GAS_ESTIMATION_RPC_URL, {
      timeout: 5_000,
      fetchOptions: { headers: { Connection: "keep-alive" } }, // ADDED
    }),
    batch: { 
      multicall: { wait: 16 }, // TUNED
      jsonRpc: true            // ENABLED
    },
  });
  return _gasEstimationClient;
}
```

- [ ] **Step 2: Update `createExecutionClient`**

Standardize headers and connection settings.

```typescript
export function createExecutionClient(account: Parameters<typeof createWalletClient>[0]["account"]) {
  // ...
  _executionWalletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(EXECUTION_RPC_URL, {
      timeout: 10_000,
      retryCount: 0,
      fetchOptions: { headers: { Connection: "keep-alive" } }, // ADDED
    }),
  });
  return _executionWalletClient;
}
```

- [ ] **Step 3: Update `createExecutionReadClient`**

Enable JSON-RPC batching and tune multicall wait time.

```typescript
export function createExecutionReadClient() {
  if (_executionReadClient) return _executionReadClient;
  _executionReadClient = createPublicClient({
    chain: polygon,
    transport: http(EXECUTION_RPC_URL, {
      timeout: 10_000,
      retryCount: 0,
      fetchOptions: { headers: { Connection: "keep-alive" } }, // ADDED
    }),
    batch: { 
      multicall: { wait: 16 }, // TUNED
      jsonRpc: true            // ENABLED
    },
  });
  return _executionReadClient;
}
```

- [ ] **Step 4: Run typecheck**
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**
```bash
git add src/config/rpc_env.ts
git commit -m "perf(viem): optimize singleton clients with batching and keep-alive"
```

---

### Task 2: Optimize RpcManager Endpoints

**Files:**
- Modify: `src/utils/rpc_manager.ts`

- [ ] **Step 1: Update `RpcEndpoint` constructor**

Apply optimized batch and transport settings to all pool endpoints.

```typescript
class RpcEndpoint {
  // ...
  constructor(url: string) {
    // ...
    this.client = createPublicClient({
      chain: polygon,
      transport: http(this.url, {
        timeout: 20_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: { 
        multicall: { wait: 16 }, // TUNED
        jsonRpc: true            // ENABLED
      },
    });
  }
  // ...
}
```

- [ ] **Step 2: Run typecheck**
Run: `pnpm run typecheck`

- [ ] **Step 3: Commit**
```bash
git add src/utils/rpc_manager.ts
git commit -m "perf(viem): enable json-rpc batching for fallback rpc pool"
```

---

### Task 3: Optimize Mempool Watcher WebSocket

**Files:**
- Modify: `src/app/mempool_watcher.ts`

- [ ] **Step 1: Update `createClient` function**

Enable batching for the WebSocket client to bundle `getTransaction` calls.

```typescript
  function createClient() {
    if (deps.createClient) return deps.createClient();
    return createPublicClient({
      chain: polygon,
      transport: webSocket(wsUrl, {
        reconnect: true,
        retryCount: 10,
        retryDelay: 500,
        timeout: 10_000,
      }),
      batch: { 
        multicall: { wait: 16 }, // TUNED
        jsonRpc: true            // ENABLED
      },
    }) as PendingTxClient;
  }
```

- [ ] **Step 2: Run typecheck**
Run: `pnpm run typecheck`

- [ ] **Step 3: Commit**
```bash
git add src/app/mempool_watcher.ts
git commit -m "perf(viem): enable batching for mempool websocket client"
```

---

### Task 4: Standardize All Other Clients

**Files:**
- Modify: `src/state/state_multicall_hydrator.ts`
- Modify: `src/execution/tx_sniper.ts`
- Modify: `src/state/enrichment/token_hydrator.ts`

- [ ] **Step 1: Update `hyperRpcStateClient` in `src/state/state_multicall_hydrator.ts`**

```typescript
const hyperRpcStateClient = createPublicClient({
  chain: polygon,
  transport: http(HYPERRPC_URL, {
    timeout: 30_000,
    fetchOptions: { headers: { Connection: "keep-alive" } },
  }),
  batch: { 
    multicall: { wait: 16 }, // TUNED
    jsonRpc: true            // ENABLED
  },
});
```

- [ ] **Step 2: Update `createRpcClient` in `src/execution/tx_sniper.ts`**

```typescript
function createRpcClient(url: string): RpcClient {
  const client = createPublicClient({
    chain: polygon,
    transport: http(url, {
      timeout: SUBMISSION_TIMEOUT_MS,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
    batch: { jsonRpc: true }, // ENABLED
  });
  return { request: (args) => client.transport.request(args) };
}
```

- [ ] **Step 3: Update `getHyperRpcClient` in `src/state/enrichment/token_hydrator.ts`**

```typescript
function getHyperRpcClient() {
  if (!_hyperRpcClient) {
    _hyperRpcClient = createPublicClient({
      chain: polygon, // Ensure chain is specified if not already
      transport: http(HYPERRPC_URL, {
        timeout: 30_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: { 
        multicall: { wait: 16 }, // TUNED
        jsonRpc: true            // ENABLED
      },
    });
  }
  return _hyperRpcClient;
}
```

- [ ] **Step 4: Run typecheck and lint**
Run: `pnpm run typecheck && pnpm run lint`

- [ ] **Step 5: Commit**
```bash
git add .
git commit -m "perf(viem): standardize optimized client settings project-wide"
```
