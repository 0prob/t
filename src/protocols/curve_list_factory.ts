import { errorMessage } from "../utils/errors.ts";
import { isRecord } from "../utils/identity.ts";
import { fetchBlockRollbackGuard, readContractWithRetry, multicallWithRetry } from "../state/enrichment/rpc.ts";
import { hydrateNewTokens } from "../state/enrichment/token_hydrator.ts";
import { logger } from "../utils/logger.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import type { ProtocolDiscoveryResult } from "./factories.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const discoveryLogger = logger.child({ component: "discovery_curve_factory" });

const POOL_COUNT_ABI = [
  {
    name: "pool_count",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const POOL_LIST_ABI = [
  {
    name: "pool_list",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "arg0", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
];

function isMissingPoolListEntryError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  return message.includes("missing or invalid parameters") || message.includes("metadata is not found");
}

function getCoinsAbi(slotCount: number) {
  return [
    {
      name: "get_coins",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "_pool", type: "address" }],
      outputs: [{ name: "", type: `address[${slotCount}]` }],
    },
  ];
}

function getDynamicCoinsAbi() {
  return [
    {
      name: "get_coins",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "_pool", type: "address" }],
      outputs: [{ name: "", type: "address[]" }],
    },
  ];
}

type DiscoverCurveFactoryOptions = {
  protocolKey: string;
  protocolName: string;
  factoryAddress: string;
  slotCount?: number;
  dynamicCoins?: boolean;
  registry: unknown;
  checkpointBlock?: number | null;
  metadataForPool?: (poolAddress: string, tokens: string[]) => Record<string, unknown>;
};

type CurveFactoryRegistry = {
  getPools?: (opts: Record<string, unknown>) => unknown;
  getPoolAddressesForProtocol?: (protocolKey: string) => unknown;
  batchUpsertPools: (pools: Record<string, unknown>[]) => unknown;
  setCheckpoint: (protocolKey: string, block: number) => unknown;
};

type CurveTokenMetadataRegistry = {
  getTokenDecimals: (addresses: string[]) => Map<string, unknown>;
  batchUpsertTokenMeta: (tokens: Array<{ address: string; decimals: number; symbol?: string; name?: string }>) => unknown;
};

type CurveFactoryPool = {
  pool_address?: unknown;
  address?: unknown;
  tokens?: unknown;
  metadata?: unknown;
  created_block?: unknown;
  created_tx?: unknown;
  status?: unknown;
  removed_block?: unknown;
};

type ListedPoolEntry = {
  isNew: boolean;
  pool: Record<string, unknown>;
};

function requireCurveFactoryRegistry(registry: unknown): CurveFactoryRegistry {
  if (isRecord(registry) && typeof registry.batchUpsertPools === "function" && typeof registry.setCheckpoint === "function") {
    return registry as CurveFactoryRegistry;
  }
  throw new Error("Curve factory discovery requires registry batchUpsertPools() and setCheckpoint() methods");
}

function requireCurveTokenMetadataRegistry(registry: unknown): CurveTokenMetadataRegistry {
  if (isRecord(registry) && typeof registry.getTokenDecimals === "function" && typeof registry.batchUpsertTokenMeta === "function") {
    return registry as CurveTokenMetadataRegistry;
  }
  throw new Error("Curve factory discovery requires registry token metadata methods for hydration");
}

function metadataFactoryIndex(metadata: unknown) {
  const index = Number(isRecord(metadata) ? metadata.factoryIndex : undefined);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function asCurveFactoryPool(value: unknown): CurveFactoryPool | null {
  return isRecord(value) ? value : null;
}

function discoverStartIndex(existingPools: CurveFactoryPool[], poolCount: number) {
  let maxIndexed = -1;
  for (const pool of existingPools) {
    const index = metadataFactoryIndex(pool.metadata);
    if (index != null && index > maxIndexed) maxIndexed = index;
  }
  if (maxIndexed < 0) return 0;
  return Math.min(poolCount, maxIndexed + 1);
}

export function discoverFactoryIndexesToScan(existingPools: unknown, poolCount: number) {
  const normalizedPoolCount = Number(poolCount);
  if (!Number.isSafeInteger(normalizedPoolCount) || normalizedPoolCount <= 0) return [];

  const discoveredIndexes = new Set<number>();
  for (const pool of Array.isArray(existingPools)
    ? existingPools.map(asCurveFactoryPool).filter((entry): entry is CurveFactoryPool => entry != null)
    : []) {
    const index = metadataFactoryIndex(pool.metadata);
    if (index != null && index < normalizedPoolCount) {
      discoveredIndexes.add(index);
    }
  }

  const indexes: number[] = [];
  for (let index = 0; index < normalizedPoolCount; index++) {
    if (!discoveredIndexes.has(index)) indexes.push(index);
  }
  return indexes;
}

export async function discoverCurveListedFactory({
  protocolKey,
  protocolName,
  factoryAddress,
  slotCount = 0,
  dynamicCoins = false,
  registry,
  checkpointBlock = null,
  metadataForPool = () => ({}),
}: DiscoverCurveFactoryOptions): Promise<ProtocolDiscoveryResult> {
  const rollbackGuard = await fetchBlockRollbackGuard();
  const curveRegistry = requireCurveFactoryRegistry(registry);
  const directPools = typeof curveRegistry.getPools === "function" ? curveRegistry.getPools({ protocol: protocolKey }) : null;
  const fallbackAddresses =
    !Array.isArray(directPools) && typeof curveRegistry.getPoolAddressesForProtocol === "function"
      ? curveRegistry.getPoolAddressesForProtocol(protocolKey)
      : [];
  const existingPools: CurveFactoryPool[] = Array.isArray(directPools)
    ? directPools.map(asCurveFactoryPool).filter((entry): entry is CurveFactoryPool => entry != null)
    : (Array.isArray(fallbackAddresses) ? fallbackAddresses : []).map((address) => ({
        pool_address: address,
        tokens: [],
        metadata: {},
        status: "active",
      }));
  const existingByAddress = new Map<string, CurveFactoryPool>(
    existingPools.flatMap((pool) => {
      const address = normalizeEvmAddress(pool.pool_address ?? pool.address);
      return address ? [[address, pool] as const] : [];
    }),
  );

  let poolCount = 0;
  try {
    poolCount = Number(
      await readContractWithRetry({
        address: factoryAddress,
        abi: POOL_COUNT_ABI,
        functionName: "pool_count",
      }),
    );
  } catch (error: unknown) {
    console.warn(`  [${protocolName}] Failed to get pool count: ${errorMessage(error)}`);
    if (checkpointBlock != null) curveRegistry.setCheckpoint(protocolKey, checkpointBlock);
    return { discovered: 0, checkpointBlock: checkpointBlock ?? 0, rollbackGuard, hydrationPromise: null };
  }

  if (!Number.isFinite(poolCount) || poolCount <= 0) {
    if (checkpointBlock != null) curveRegistry.setCheckpoint(protocolKey, checkpointBlock);
    return { discovered: 0, checkpointBlock, rollbackGuard, hydrationPromise: null };
  }

  const indexes = discoverFactoryIndexesToScan(existingPools, poolCount);
  const startIndex = indexes.length > 0 ? indexes[0] : Math.min(poolCount, discoverStartIndex(existingPools, poolCount));
  const scanCount = indexes.length;
  const missingBelowTip = indexes.some((index) => index < Math.max(0, poolCount - 1));

  console.log(
    `\n[${protocolName}] Enumerating ${scanCount} new factory-listed pool slot(s)` +
      (missingBelowTip
        ? ` across ${poolCount} pool slot(s) to repair missing index gap(s)`
        : startIndex > 0
          ? ` from index ${startIndex}`
          : ` across ${poolCount} pool slot(s)`) +
      `...`,
  );
  discoveryLogger.info(
    {
      protocol: protocolKey,
      poolCount,
      existingPools: existingPools.length,
      startIndex,
      scanCount,
      missingIndexRepair: missingBelowTip,
    },
    "[discovery] Enumerating Curve factory-listed pools",
  );

  const getCoinsABI = dynamicCoins ? getDynamicCoinsAbi() : getCoinsAbi(slotCount);

  type PoolListResult = { index: number; poolAddress: string };
  type ExistingPoolUpdate = { isNew: false; pool: Record<string, unknown> };

  const poolListContracts = indexes.map((index) => ({
    address: factoryAddress,
    abi: POOL_LIST_ABI,
    functionName: "pool_list",
    args: [BigInt(index)],
  }));

  let poolListResults: { status: string; result?: unknown; error?: unknown }[] = [];
  try {
    const chunks = [];
    for (let i = 0; i < poolListContracts.length; i += 100) {
      chunks.push(poolListContracts.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const chunkResults = (await multicallWithRetry({
        contracts: chunk,
        allowFailure: true,
      })) as { status: string; result?: unknown; error?: unknown }[];
      poolListResults.push(...chunkResults);
    }
  } catch (error: unknown) {
    console.warn(`  [${protocolName}] Multicall for pool_list failed: ${errorMessage(error)}`);
    if (checkpointBlock != null) curveRegistry.setCheckpoint(protocolKey, checkpointBlock);
    return { discovered: 0, checkpointBlock: checkpointBlock ?? 0, rollbackGuard, hydrationPromise: null };
  }

  const poolAddresses: PoolListResult[] = [];
  const existingUpdates: ExistingPoolUpdate[] = [];

  for (let i = 0; i < poolListResults.length; i++) {
    const index = indexes[i];
    const result = poolListResults[i];
    try {
      if (result.status === "failure") {
        if (isMissingPoolListEntryError(result.error)) continue;
        console.warn(`  [${protocolName}] Failed to enumerate pool #${index}: ${errorMessage(result.error)}`);
        continue;
      }
      const poolAddress = normalizeEvmAddress(result.result);
      if (!poolAddress || poolAddress === ZERO) continue;

      const existingPool = existingByAddress.get(poolAddress);
      const existingFactoryIndex = metadataFactoryIndex(existingPool?.metadata);
      if (existingPool && existingFactoryIndex !== index) {
        existingUpdates.push({
          isNew: false,
          pool: {
            protocol: protocolKey,
            block: existingPool.created_block ?? checkpointBlock ?? 0,
            tx: existingPool.created_tx ?? "",
            pool_address: poolAddress,
            tokens: Array.isArray(existingPool.tokens) ? existingPool.tokens : [],
            metadata: {
              ...(isRecord(existingPool.metadata) ? existingPool.metadata : {}),
              factory: factoryAddress,
              factoryIndex: index,
            },
            status: existingPool.status == null ? "active" : String(existingPool.status),
            removed_block: existingPool.removed_block ?? null,
          },
        });
        continue;
      }
      if (existingPool) continue;

      poolAddresses.push({ index, poolAddress });
    } catch {
      continue;
    }
  }

  const getCoinsContracts = poolAddresses.map(({ poolAddress }) => ({
    address: factoryAddress,
    abi: getCoinsABI,
    functionName: "get_coins",
    args: [poolAddress],
  }));

  let getCoinsResults: { status: string; result?: unknown; error?: unknown }[] = [];
  if (getCoinsContracts.length > 0) {
    try {
      // get_coins can be very slow on Curve factories; use small chunks to avoid RPC timeouts
      const chunks = [];
      for (let i = 0; i < getCoinsContracts.length; i += 5) {
        chunks.push(getCoinsContracts.slice(i, i + 5));
      }
      for (const chunk of chunks) {
        const chunkResults = (await multicallWithRetry({
          contracts: chunk,
          allowFailure: true,
        })) as { status: string; result?: unknown; error?: unknown }[];
        getCoinsResults.push(...chunkResults);
      }
    } catch (error: unknown) {
      console.warn(`  [${protocolName}] Multicall for get_coins failed: ${errorMessage(error)}`);
      // If some chunks succeeded, we still have partial results.
      // The loop below will handle missing results for failed chunks.
    }
  }

  const newPoolEntries: ListedPoolEntry[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const { index, poolAddress } = poolAddresses[i];
    const result = getCoinsResults[i];
    try {
      if (!result || result.status === "failure") {
        if (result) {
          console.warn(`  [${protocolName}] Failed to get coins for pool #${index}: ${errorMessage(result.error)}`);
        }
        continue;
      }
      const rawTokens = result.result;
      const tokens = (Array.isArray(rawTokens) ? rawTokens : [])
        .map((token) => normalizeEvmAddress(token))
        .filter((token): token is string => token != null && token !== ZERO);

      if (tokens.length < 2) continue;

      newPoolEntries.push({
        isNew: true,
        pool: {
          protocol: protocolKey,
          block: checkpointBlock ?? 0,
          tx: "",
          pool_address: poolAddress,
          tokens,
          metadata: {
            ...metadataForPool(poolAddress, tokens),
            factory: factoryAddress,
            factoryIndex: index,
          },
          status: "active",
        },
      });
    } catch {
      continue;
    }
  }

  const listedPoolEntries: ListedPoolEntry[] = [...existingUpdates, ...newPoolEntries];

  const listedPools = listedPoolEntries.filter((entry): entry is ListedPoolEntry => entry != null);
  const poolBatch = listedPools.map((entry) => entry.pool);
  const newPools = listedPools.filter((entry) => entry.isNew);
  if (poolBatch.length > 0) {
    curveRegistry.batchUpsertPools(poolBatch);
  }

  if (newPools.length > 0) {
    try {
      await hydrateNewTokens(
        newPools.map((entry) => entry.pool),
        requireCurveTokenMetadataRegistry(registry),
      );
    } catch (err: unknown) {
      console.warn(`  [discover] Token hydration failed: ${errorMessage(err)}`);
    }
  }

  if (checkpointBlock != null) curveRegistry.setCheckpoint(protocolKey, checkpointBlock);

  console.log(
    `  Inserted ${newPools.length} new pool(s), refreshed ${poolBatch.length - newPools.length} existing pool(s) for ${protocolName}.`,
  );
  discoveryLogger.info(
    {
      protocol: protocolKey,
      enumeratedPools: poolCount,
      scanStartIndex: startIndex,
      scannedSlots: scanCount,
      missingIndexRepair: missingBelowTip,
      insertedPools: newPools.length,
      refreshedPools: poolBatch.length - newPools.length,
      checkpointBlock,
    },
    "[discovery] Curve factory scan complete",
  );

  return {
    discovered: newPools.length,
    checkpointBlock,
    rollbackGuard,
    hydrationPromise: null,
  };
}
