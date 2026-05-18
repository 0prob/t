/**
 * Dedicated pool-state multicall hydrator.
 *
 * This is the warm-path HyperRPC lane for pool state reads. It is intentionally
 * separate from the execution RPC client and the latency-scored public RPC
 * manager so broad hydration cannot compete with final confirmation,
 * simulation, nonce, or submission calls.
 */

import { createPublicClient, http, getAddress } from "viem";
import { polygon } from "viem/chains";
import { HYPERRPC_URL } from "../config/index.ts";
import { isEndpointCapabilityError } from "../utils/rpc_manager.ts";
import { errorMessage } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { multicallWithRetry } from "./enrichment/rpc.ts";

export type StateReadBlockTag = "latest" | "pending";
type ViemAddress = `0x${string}`;

export const V2_GET_RESERVES_ABI = [
  {
    name: "getReserves",
    type: "function",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
  },
] as const;

export const V3_SLOT0_ABI = [
  {
    name: "slot0",
    type: "function",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
  },
] as const;

export const V3_LIQUIDITY_ABI = [
  {
    name: "liquidity",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
] as const;

export const V3_TICK_SPACING_ABI = [
  {
    name: "tickSpacing",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
    stateMutability: "view",
  },
] as const;

export const V3_FEE_ABI = [
  {
    name: "fee",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
    stateMutability: "view",
  },
] as const;

export const ALGEBRA_GLOBAL_STATE_ABI = [
  {
    name: "globalState",
    type: "function",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "fee", type: "uint16" },
      { name: "timepointIndex", type: "uint16" },
      { name: "communityFeeToken0", type: "uint8" },
      { name: "communityFeeToken1", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
  },
] as const;

export type StateMulticallContract = {
  address: ViemAddress;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

export type StateMulticallResult = {
  status?: unknown;
  result?: unknown;
  error?: unknown;
};

export type StateMulticallParams = {
  contracts: readonly StateMulticallContract[];
  allowFailure: boolean;
  blockTag?: StateReadBlockTag;
};

export type V3PoolCoreSnapshot = {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  fee: number;
  tickSpacing: number;
};

export type V3PoolCoreRequest = {
  address: string;
  isAlgebra?: boolean;
};

export type V3CoreSnapshotMap = Map<string, V3PoolCoreSnapshot> & {
  noDataFailures?: Set<string>;
};

type StateMulticallClient = {
  multicall: <T = StateMulticallResult[]>(params: StateMulticallParams) => Promise<T>;
};

const stateHydratorLogger = logger.child({ component: "state_multicall_hydrator" });

const hyperRpcStateClient = createPublicClient({
  chain: polygon,
  transport: http(HYPERRPC_URL, {
    timeout: 30_000,
    fetchOptions: { headers: { Connection: "keep-alive" } },
  }),
  batch: { multicall: true },
});

const hyperRpcMulticallAvailable = true;
let hyperRpcMulticallDisabledAt = 0;
const HYPERRPC_MULTICALL_RECOVERY_MS = 60_000;

function requireStateMulticallClient(client: unknown, label: string): StateMulticallClient {
  const multicall = client != null && typeof client === "object" ? (client as { multicall?: unknown }).multicall : null;
  if (typeof multicall !== "function") {
    throw new Error(`${label} client does not expose multicall()`);
  }
  return client as StateMulticallClient;
}

function toHydratorBigInt(value: unknown) {
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`invalid state multicall bigint value: ${String(value)}`);
}

function successTuple(result: StateMulticallResult | null | undefined): readonly unknown[] | null {
  if (!result || result.status !== "success" || !Array.isArray(result.result)) return null;
  return result.result;
}

function successScalar(result: StateMulticallResult | null | undefined) {
  return result?.status === "success" ? result.result : undefined;
}

function isExecutionRevertError(error: unknown): boolean {
  const msg = typeof error === "string" ? error : (error as Error)?.message || "";
  const lowerMsg = msg.toLowerCase();
  return lowerMsg.includes("execution reverted") || lowerMsg.includes("revert") || lowerMsg.includes("out of gas");
}

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
        if (Array.isArray(results) && results.length > 0 && results.every((r) => (r as any)?.status !== "success")) {
          // Check if it's just all reverts
          const allReverts = results.every((r) => isExecutionRevertError(errorMessage((r as any).error)));

          if (!allReverts) {
            const firstError = (results[0] as any)?.status === "failure" ? errorMessage((results[0] as any).error) : "unknown";
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
          throw err;
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

export async function fetchV3PoolCoreSnapshots(
  requests: V3PoolCoreRequest[],
  options: { blockTag?: StateReadBlockTag } = {},
): Promise<V3CoreSnapshotMap> {
  const states = new Map<string, V3PoolCoreSnapshot>() as V3CoreSnapshotMap;
  const noDataFailures = new Set<string>();
  const normalizedRequests = requests
    .map((request) => ({
      address: typeof request?.address === "string" ? request.address.toLowerCase() : "",
      isAlgebra: request?.isAlgebra === true,
    }))
    .filter((request) => /^0x[0-9a-f]{40}$/.test(request.address));

  if (normalizedRequests.length === 0) {
    states.noDataFailures = noDataFailures;
    return states;
  }

  const contracts: StateMulticallContract[] = [];
  const layouts: Array<{ address: string; isAlgebra: boolean; start: number; width: number }> = [];
  for (const request of normalizedRequests) {
    const start = contracts.length;
    if (request.isAlgebra) {
      contracts.push(
        { address: getAddress(request.address), abi: ALGEBRA_GLOBAL_STATE_ABI, functionName: "globalState" },
        { address: getAddress(request.address), abi: V3_LIQUIDITY_ABI, functionName: "liquidity" },
        { address: getAddress(request.address), abi: V3_TICK_SPACING_ABI, functionName: "tickSpacing" },
      );
      layouts.push({ address: request.address, isAlgebra: true, start, width: 3 });
    } else {
      contracts.push(
        { address: getAddress(request.address), abi: V3_SLOT0_ABI, functionName: "slot0" },
        { address: getAddress(request.address), abi: V3_LIQUIDITY_ABI, functionName: "liquidity" },
        { address: getAddress(request.address), abi: V3_FEE_ABI, functionName: "fee" },
        { address: getAddress(request.address), abi: V3_TICK_SPACING_ABI, functionName: "tickSpacing" },
      );
      layouts.push({ address: request.address, isAlgebra: false, start, width: 4 });
    }
  }

  const results = await stateMulticallWithFallback<StateMulticallResult[]>({
    contracts,
    allowFailure: true,
    blockTag: options.blockTag,
  });

  for (const layout of layouts) {
    const slice = results.slice(layout.start, layout.start + layout.width);
    try {
      if (layout.isAlgebra) {
        const globalState = successTuple(slice[0]);
        const liquidity = successScalar(slice[1]);
        const tickSpacing = successScalar(slice[2]);
        if (!globalState || liquidity == null || tickSpacing == null) {
          noDataFailures.add(layout.address);
          continue;
        }
        states.set(layout.address, {
          sqrtPriceX96: toHydratorBigInt(globalState[0]),
          tick: Number(globalState[1]),
          fee: Number(globalState[2]),
          liquidity: toHydratorBigInt(liquidity),
          tickSpacing: Number(tickSpacing),
        });
        continue;
      }

      const slot0 = successTuple(slice[0]);
      const liquidity = successScalar(slice[1]);
      const fee = successScalar(slice[2]);
      const tickSpacing = successScalar(slice[3]);
      if (!slot0 || liquidity == null || fee == null || tickSpacing == null) {
        noDataFailures.add(layout.address);
        continue;
      }
      states.set(layout.address, {
        sqrtPriceX96: toHydratorBigInt(slot0[0]),
        tick: Number(slot0[1]),
        fee: Number(fee),
        liquidity: toHydratorBigInt(liquidity),
        tickSpacing: Number(tickSpacing),
      });
    } catch {
      noDataFailures.add(layout.address);
    }
  }

  states.noDataFailures = noDataFailures;
  return states;
}
