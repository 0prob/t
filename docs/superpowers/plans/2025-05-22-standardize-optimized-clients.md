# Standardize Optimized Client Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize `viem` client settings with optimized batch and transport configurations across `state_multicall_hydrator.ts`, `tx_sniper.ts`, and `token_hydrator.ts`.

**Architecture:** Update `createPublicClient` and `http` transport settings to enable JSON-RPC batching and tune multicall wait times.

**Tech Stack:** viem, TypeScript

---

### Task 1: Update `src/state/state_multicall_hydrator.ts`

**Files:**
- Modify: `src/state/state_multicall_hydrator.ts`

- [ ] **Step 1: Update `hyperRpcStateClient` configuration**

Modify the `hyperRpcStateClient` definition to enable `batch: true` in the `http` transport and tune the `multicall` wait time to `16`ms.

```typescript
const hyperRpcStateClient = createPublicClient({
  chain: polygon,
  transport: http(HYPERRPC_URL, {
    batch: true, // ENABLED
    timeout: 30_000,
    fetchOptions: { headers: { Connection: "keep-alive" } },
  }),
  batch: {
    multicall: { wait: 16 }, // TUNED
  },
});
```

### Task 2: Update `src/execution/tx_sniper.ts`

**Files:**
- Modify: `src/execution/tx_sniper.ts`

- [ ] **Step 1: Update `createRpcClient` function**

Modify the `createRpcClient` function to enable `batch: true` in the `http` transport.

```typescript
function createRpcClient(url: string): RpcClient {
  const client = createPublicClient({
    chain: polygon,
    transport: http(url, {
      batch: true, // ENABLED
      timeout: SUBMISSION_TIMEOUT_MS,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
  });
  // Only expose transport.request — PublicClient has no sendRawTransaction.
  return { request: (args) => client.transport.request(args) };
}
```

### Task 3: Update `src/state/enrichment/token_hydrator.ts`

**Files:**
- Modify: `src/state/enrichment/token_hydrator.ts`

- [ ] **Step 1: Update `getHyperRpcClient` function**

Modify the `getHyperRpcClient` function to enable `batch: true` in the `http` transport and tune the `multicall` wait time to `16`ms.

```typescript
function getHyperRpcClient() {
  if (!_hyperRpcClient) {
    _hyperRpcClient = createPublicClient({
      chain: polygon,
      transport: http(HYPERRPC_URL, {
        batch: true, // ENABLED
        timeout: 30_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: {
        multicall: { wait: 16 }, // TUNED
      },
    });
  }
  return _hyperRpcClient;
}
```

### Task 4: Verification and Commit

- [ ] **Step 1: Run typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: exit 0

- [ ] **Step 2: Commit the changes**

```bash
git add src/state/state_multicall_hydrator.ts src/execution/tx_sniper.ts src/state/enrichment/token_hydrator.ts
git commit -m "perf(viem): standardize optimized client settings project-wide"
```
