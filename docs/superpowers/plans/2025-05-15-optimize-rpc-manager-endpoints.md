# Optimize RpcManager Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable JSON-RPC batching and tune multicall wait time for RpcManager endpoints.

**Architecture:** Update the viem PublicClient configuration in the RpcEndpoint class to enable transport-level batching and optimize multicall batching parameters.

**Tech Stack:** viem, TypeScript

---

### Task 1: Update RpcEndpoint constructor

**Files:**
- Modify: src/utils/rpc_manager.ts

- [ ] **Step 1: Modify the createPublicClient call in RpcEndpoint constructor**

Update the `transport` and `batch` options.

```typescript
    this.client = createPublicClient({
      chain: polygon,
      transport: http(this.url, {
        batch: true, // ENABLED
        timeout: 20_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: { 
        multicall: { wait: 16 }, // TUNED
      },
    });
```

- [ ] **Step 2: Verify with typecheck**

Run: `pnpm run typecheck`
Expected: SUCCESS

- [ ] **Step 3: Commit the changes**

```bash
git add src/utils/rpc_manager.ts
git commit -m "perf(viem): enable json-rpc batching for fallback rpc pool"
```
