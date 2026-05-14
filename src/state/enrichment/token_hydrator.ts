/**
 * src/enrichment/token_hydrator.js — ERC-20 metadata hydration via multicall
 *
 * Uses viem's built-in Multicall3 support to batch-fetch decimals, symbol, and
 * name for a set of token addresses in a single JSON-RPC round-trip per chunk.
 * Routes through HYPERRPC_URL (your external HyperRPC instance) with fallback
 * to the hot-path RPC pool if unavailable.
 *
 * Cost model:
 *   - 200 tokens × 3 calls = 600 eth_call targets per multicall request
 *   - allowFailure: true — a non-ERC20 token or failed call never aborts the batch
 */

import { chunk } from "../../utils/concurrency.ts";
import { getAddress, createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { ENRICH_CONCURRENCY } from "../../config/index.ts";
import { dynamicPublicClient, isEndpointCapabilityError } from "../../utils/rpc_manager.ts";
import { logger } from "../../utils/logger.ts";
import { getPoolTokens } from "../../utils/pool_record.ts";
import { normalizeHydrationAddresses, normalizeTokenHydrationAddress } from "./token_hydrator_helpers.ts";
import { throttledMap } from "./rpc.ts";

// ─── HyperRPC client ──────────────────────────────────────────
//
// Separate from the hot-path RPC manager so multicall traffic doesn't compete
// with latency-sensitive arb calls for endpoint health scoring.
// Falls back to dynamicPublicClient if HYPERRPC_URL is unreachable.
// Created lazily to avoid circular module initialization deadlock.

let _hyperRpcClient: ReturnType<typeof createPublicClient> | null = null;

function getHyperRpcClient() {
  if (!_hyperRpcClient) {
    const url = process.env.HYPERRPC_URL || "";
    _hyperRpcClient = createPublicClient({
      chain: polygon,
      transport: http(url, {
        timeout: 30_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: { multicall: true },
    });
  }
  return _hyperRpcClient;
}

let hyperRpcMulticallAvailable = true;
let hyperRpcMulticallDisabledAt = 0;
const HYPERRPC_MULTICALL_RECOVERY_MS = 60_000;

// ─── ERC-20 ABI fragments ──────────────────────────────────────

const DECIMALS_ABI = [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] }];
const SYMBOL_ABI = [{ name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] }];
const NAME_ABI = [{ name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] }];
const SYMBOL_BYTES32_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
];
const NAME_BYTES32_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
];

// ─── Helpers ──────────────────────────────────────────────────

const CHUNK_SIZE = 200; // tokens per multicall → 600 call targets per request
type ViemAddress = `0x${string}`;

type MulticallContract = {
  address: ViemAddress;
  abi: readonly unknown[];
  functionName: string;
};

type MulticallResult = {
  status?: unknown;
  result?: unknown;
  error?: unknown;
};

type MulticallClient = {
  multicall: (args: { contracts: readonly MulticallContract[]; allowFailure: boolean }) => Promise<MulticallResult[]>;
};

function requireMulticallClient(client: unknown, label: string): MulticallClient {
  const multicall = client != null && typeof client === "object" ? (client as { multicall?: unknown }).multicall : null;
  if (typeof multicall !== "function") {
    throw new Error(`${label} client does not expose multicall()`);
  }
  return client as MulticallClient;
}

export type HydratedTokenMetadata = {
  address: string;
  decimals: number | null;
  symbol: string | null;
  name: string | null;
};

type PersistableTokenMetadata = {
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
};

type TokenMetadataRegistry = {
  getTokenDecimals: (addresses: string[]) => Map<string, unknown>;
  batchUpsertTokenMeta: (tokens: PersistableTokenMetadata[]) => unknown;
};

export function decodeBytes32Text(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const bytes = Buffer.from(value.slice(2), "hex");
  const nulIndex = bytes.indexOf(0);
  const content = (nulIndex >= 0 ? bytes.subarray(0, nulIndex) : bytes).toString("utf8").trim();
  return content || null;
}

function normalizeHydratedDecimals(value: unknown) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) return 18;
  return numeric;
}

function normalizeHydratedText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function persistableTokenMetadata(meta: HydratedTokenMetadata & { decimals: number }): PersistableTokenMetadata {
  return {
    address: meta.address,
    decimals: meta.decimals,
    ...(meta.symbol != null ? { symbol: meta.symbol } : {}),
    ...(meta.name != null ? { name: meta.name } : {}),
  };
}

export function mergeMetadataBatchResults(
  addresses: string[],
  results: MulticallResult[],
  fallbackResultsByAddressIndex = new Map<number, MetadataFallback>(),
): HydratedTokenMetadata[] {
  return addresses.map((addr, i) => {
    const dec = results[i * 3];
    const sym = results[i * 3 + 1];
    const name = results[i * 3 + 2];
    const fallback = fallbackResultsByAddressIndex.get(i);
    return {
      address: addr,
      decimals: dec?.status === "success" ? normalizeHydratedDecimals(dec.result) : null,
      symbol: sym?.status === "success" ? (normalizeHydratedText(sym.result) ?? fallback?.symbol ?? null) : (fallback?.symbol ?? null),
      name: name?.status === "success" ? (normalizeHydratedText(name.result) ?? fallback?.name ?? null) : (fallback?.name ?? null),
    };
  });
}

type MetadataFallbackField = "symbol" | "name";
type MetadataFallback = { symbol?: string | null; name?: string | null };

async function runMulticall(contracts: readonly MulticallContract[]) {
  const hyperRpcMulticallClient = requireMulticallClient(getHyperRpcClient(), "HyperRPC");
  const fallbackMulticallClient = requireMulticallClient(dynamicPublicClient, "RPC manager");
  if (hyperRpcMulticallAvailable) {
    if (hyperRpcMulticallDisabledAt > 0 && Date.now() >= hyperRpcMulticallDisabledAt) {
      hyperRpcMulticallDisabledAt = 0;
      logger.info("[token_hydrator] HyperRPC multicall cooldown elapsed — retrying");
    }
    if (hyperRpcMulticallDisabledAt === 0) {
      try {
        const results = await hyperRpcMulticallClient.multicall({ contracts, allowFailure: true });
        // HyperRPC returns without error but all calls fail — fall back to RPC manager
        // which may route through a different endpoint with working Multicall3 support.
        if (Array.isArray(results) && results.length > 0 && results.every((r) => r?.status !== "success")) {
          logger.warn("[token_hydrator] HyperRPC multicall returned all failures — falling back to RPC manager");
          return await fallbackMulticallClient.multicall({ contracts, allowFailure: true });
        }
        return results;
      } catch (err) {
        if (isEndpointCapabilityError(err)) {
          hyperRpcMulticallAvailable = false;
          logger.warn("[token_hydrator] HyperRPC does not support multicall here — falling back to RPC manager");
        } else {
          hyperRpcMulticallDisabledAt = Date.now() + HYPERRPC_MULTICALL_RECOVERY_MS;
          logger.debug("[token_hydrator] HyperRPC multicall failed — falling back for %dms", HYPERRPC_MULTICALL_RECOVERY_MS);
        }
      }
    }
  }
  return await fallbackMulticallClient.multicall({ contracts, allowFailure: true });
}

// ─── Multicall batch ──────────────────────────────────────────

/**
 * Fetch decimals, symbol, and name for up to CHUNK_SIZE token addresses
 * in a single Multicall3 call.
 *
 * @param {string[]} addresses  Lowercase token addresses (max CHUNK_SIZE)
 * @returns {Promise<Array<{ address: string, decimals: number|null, symbol: string|null, name: string|null }>>}
 */
async function fetchMetaBatch(addresses: string[]): Promise<HydratedTokenMetadata[]> {
  const contracts: MulticallContract[] = addresses.flatMap((addr) => [
    { address: getAddress(addr), abi: DECIMALS_ABI, functionName: "decimals" },
    { address: getAddress(addr), abi: SYMBOL_ABI, functionName: "symbol" },
    { address: getAddress(addr), abi: NAME_ABI, functionName: "name" },
  ]);
  const results = await runMulticall(contracts);

  const successCount = Array.isArray(results) ? results.filter((r) => r?.status === "success").length : 0;
  logger.info(
    {
      addresses: addresses.length,
      callCount: contracts.length,
      resultCount: Array.isArray(results) ? results.length : 0,
      successCount,
    },
    "[token_hydrator] multicall raw result summary",
  );

  const fallbackContracts: MulticallContract[] = [];
  const fallbackLookups: Array<{ addressIndex: number; field: MetadataFallbackField }> = [];
  for (let i = 0; i < addresses.length; i++) {
    const symbolResult = results[i * 3 + 1];
    const nameResult = results[i * 3 + 2];
    if (symbolResult?.status !== "success") {
      fallbackLookups.push({ addressIndex: i, field: "symbol" });
      fallbackContracts.push({ address: getAddress(addresses[i]), abi: SYMBOL_BYTES32_ABI, functionName: "symbol" });
    }
    if (nameResult?.status !== "success") {
      fallbackLookups.push({ addressIndex: i, field: "name" });
      fallbackContracts.push({ address: getAddress(addresses[i]), abi: NAME_BYTES32_ABI, functionName: "name" });
    }
  }

  let fallbackResults: MulticallResult[] = [];
  if (fallbackContracts.length > 0) {
    fallbackResults = await runMulticall(fallbackContracts);
    const fallbackResolved = fallbackResults.filter((result) => decodeBytes32Text(result?.result) != null).length;
    logger.info(
      {
        fallbackCallCount: fallbackContracts.length,
        fallbackResolved,
      },
      "[token_hydrator] bytes32 metadata fallback summary",
    );
  }

  const fallbackByAddressIndex = new Map<number, MetadataFallback>();
  for (let i = 0; i < fallbackLookups.length; i++) {
    const lookup = fallbackLookups[i];
    const decoded = decodeBytes32Text(fallbackResults[i]?.status === "success" ? fallbackResults[i]?.result : null);
    const next = fallbackByAddressIndex.get(lookup.addressIndex) ?? {};
    next[lookup.field] = decoded;
    fallbackByAddressIndex.set(lookup.addressIndex, next);
  }

  return mergeMetadataBatchResults(addresses, results, fallbackByAddressIndex);
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Hydrate token metadata for a list of addresses.
 *
 * Only fetches tokens not already present in the registry's token_meta table.
 * Tokens where decimals() reverts (e.g. non-ERC20) are silently skipped.
 *
 * @param {string[]} tokenAddresses  Lowercase ERC-20 addresses
 * @param {import('../db/registry.ts').RegistryService} registry
 * @returns {Promise<number>}  Number of new tokens persisted
 */
export async function hydrateTokens(tokenAddresses: unknown, registry: TokenMetadataRegistry) {
  return hydrateTokensWithDeps(tokenAddresses, registry);
}

export async function hydrateTokensWithDeps(
  tokenAddresses: unknown,
  registry: TokenMetadataRegistry,
  deps: {
    fetchMetaBatch?: (addresses: string[]) => Promise<HydratedTokenMetadata[]>;
    concurrency?: number;
  } = {},
) {
  const normalizedAddresses = normalizeHydrationAddresses(tokenAddresses);
  if (normalizedAddresses.length === 0) return 0;

  // Filter to only addresses not yet in the DB — re-hydration is rare; this
  // check ensures a repeated discovery run is a no-op for existing tokens.
  const existing = registry.getTokenDecimals(normalizedAddresses);
  const toFetch = normalizedAddresses.filter((address) => !existing.has(address));

  if (toFetch.length === 0) {
    logger.debug(`[token_hydrator] ${normalizedAddresses.length} token(s) already in DB — skipping`);
    return 0;
  }

  logger.info(
    `[token_hydrator] Hydrating ${toFetch.length} new token(s) via multicall ` +
      `(${chunk(toFetch, CHUNK_SIZE).length} batch(es) of up to ${CHUNK_SIZE}, concurrency=${deps.concurrency ?? ENRICH_CONCURRENCY})`,
  );

  const chunks = chunk(toFetch, CHUNK_SIZE);
  const fetchBatch = deps.fetchMetaBatch ?? fetchMetaBatch;
  const hydratedPerChunk = await throttledMap(
    chunks,
    async (batch) => {
      try {
        const meta = await fetchBatch(batch);
        logger.info(
          {
            batchSize: batch.length,
            sample: meta.slice(0, 5),
            decimalsResolved: meta.filter((m) => m.decimals !== null).length,
            symbolResolved: meta.filter((m) => m.symbol !== null).length,
            nameResolved: meta.filter((m) => m.name !== null).length,
          },
          "[token_hydrator] batch decode summary",
        );

        // Persist all entries — decimals defaults to 18 if on-chain call reverts
        const valid = meta.filter((m): m is HydratedTokenMetadata & { decimals: number } => typeof m.decimals === "number");
        if (valid.length > 0) {
          registry.batchUpsertTokenMeta(valid.map(persistableTokenMetadata));
        }
        return valid.length;
      } catch (err) {
        logger.warn(`[token_hydrator] Multicall chunk failed: ${(err as { message?: unknown } | null | undefined)?.message ?? err}`);
        return 0;
      }
    },
    Math.max(1, deps.concurrency ?? ENRICH_CONCURRENCY),
  );
  const hydrated = hydratedPerChunk.reduce((sum, count) => sum + count, 0);

  logger.info(`[token_hydrator] Done — ${hydrated}/${toFetch.length} tokens persisted`);
  return hydrated;
}

/**
 * Extract unique token addresses from a list of pool records and hydrate them.
 *
 * Convenience wrapper for post-discovery calls. Ignores the zero address.
 *
 * @param {Array<{ tokens: string[]|string }>} pools  Newly discovered pool records
 * @param {import('../db/registry.ts').RegistryService} registry
 * @returns {Promise<number>}
 */
export async function hydrateNewTokens(pools: unknown, registry: TokenMetadataRegistry) {
  const seen = new Set<string>();
  if (!Array.isArray(pools)) return 0;
  for (const pool of pools) {
    const tokens = getPoolTokens(pool);
    if (!Array.isArray(tokens)) continue;
    for (const t of tokens) {
      const normalized = normalizeTokenHydrationAddress(t);
      if (normalized) seen.add(normalized);
    }
  }
  return hydrateTokens([...seen], registry);
}
