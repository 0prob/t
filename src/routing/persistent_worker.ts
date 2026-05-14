/**
 * src/routing/persistent_worker.ts — Long-lived simulation + enumeration worker
 *
 * Handles two message types:
 *
 *   EVALUATE  { id, paths, stateObj, testAmount, options }
 *     Simulate a batch of paths against the provided state snapshot.
 *     Returns profitable paths sorted by profit desc.
 *
 *   ENUMERATE { id, adjacency, startTokens, options }
 *     Reconstruct a lightweight graph from `adjacency`
 *     (output of serializeTopology) and run findArbPaths on `startTokens`.
 *     Returns serialisable path descriptors (pool arrays, no functions).
 *     The main thread then looks up full edges from the live graph.
 */

import { parentPort } from "worker_threads";
import { evaluatePaths } from "./simulator.ts";
import { findArbPaths } from "./finder.ts";
import { deserializeTopology } from "./graph.ts";
import { rehydrateStateData } from "../db/registry_codec.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { errorMessage } from "../utils/errors.ts";
import type { RouteState, RouteStateCache, SimulationPath } from "./simulation_types.ts";
import type { SerializedEnumeratedPath, WorkerErrorResponse, WorkerRequest, WorkerStateObject } from "./worker_messages.ts";

if (!parentPort) throw new Error("persistent_worker must run in a Worker thread");

const workerStateMap: RouteStateCache = new Map();
let cachedTopologyKey: string | null = null;
let cachedTopologyGraph: ReturnType<typeof deserializeTopology> | null = null;

function stateEntries(stateObj: WorkerStateObject | Map<string, RouteState> | null | undefined) {
  if (!stateObj) return [];
  return stateObj instanceof Map ? [...stateObj.entries()] : Object.entries(stateObj);
}

function rehydrateAndStoreState(poolAddress: string, state: RouteState) {
  const normalizedPool = normalizeEvmAddress(poolAddress);
  if (!normalizedPool) return;
  const protocol = typeof state.protocol === "string" ? state.protocol : "";
  rehydrateStateData(protocol, state);
  workerStateMap.set(normalizedPool, state);
}

function serialiseEnumeratedPath(path: SimulationPath): SerializedEnumeratedPath {
  return {
    startToken: path.startToken,
    hopCount: path.hopCount,
    logWeight: path.logWeight,
    cumulativeFeesBps: path.cumulativeFeesBps,
    poolAddresses: path.edges.map((edge) => edge.poolAddress),
    tokenIns: path.edges.map((edge) => edge.tokenIn),
    tokenOuts: path.edges.map((edge) => edge.tokenOut),
    zeroForOnes: path.edges.map((edge) => edge.zeroForOne),
  };
}

parentPort!.on("message", (message: WorkerRequest) => {
  const { id } = message;
  try {
    if (message.type === "SYNC_STATE") {
      const { stateObj, retainPools } = message;
      for (const [poolAddress, state] of stateEntries(stateObj)) {
        rehydrateAndStoreState(poolAddress, state);
      }
      if (Array.isArray(retainPools)) {
        const retained = new Set(
          retainPools
            .map((poolAddress: string) => normalizeEvmAddress(poolAddress))
            .filter((poolAddress: string | null): poolAddress is string => poolAddress != null),
        );
        for (const poolAddress of [...workerStateMap.keys()]) {
          if (!retained.has(poolAddress)) {
            workerStateMap.delete(poolAddress);
          }
        }
      }
      parentPort!.postMessage({ id, type: "SYNC_STATE" });
    } else if (message.type === "SYNC_TOPOLOGY") {
      const { adjacency, topologyKey } = message;
      cachedTopologyGraph = deserializeTopology(adjacency);
      cachedTopologyKey = topologyKey ?? null;
      parentPort!.postMessage({ id, type: "SYNC_TOPOLOGY" });
    } else if (message.type === "EVALUATE") {
      const { paths, stateObj, testAmount, options } = message;
      if (stateObj) {
        for (const [poolAddress, state] of stateEntries(stateObj)) {
          rehydrateAndStoreState(poolAddress, state);
        }
      }

      const profitable = evaluatePaths(paths, workerStateMap, BigInt(testAmount), options || {});
      parentPort!.postMessage({ id, type: "EVALUATE", profitable });
    } else if (message.type === "ENUMERATE") {
      const { adjacency, topologyKey, startTokens, options } = message;
      let graph = cachedTopologyGraph;

      if (adjacency) {
        if (!graph || (topologyKey != null && topologyKey !== cachedTopologyKey)) {
          graph = deserializeTopology(adjacency);
          cachedTopologyGraph = graph;
          cachedTopologyKey = topologyKey ?? null;
        }
      }

      if (!graph) {
        throw new Error("ENUMERATE received no cached topology");
      }

      const paths = findArbPaths(graph, startTokens, options || {}) as SimulationPath[];
      const serialised = paths.map((path) => serialiseEnumeratedPath(path));
      parentPort!.postMessage({ id, type: "ENUMERATE", paths: serialised });
    } else {
      parentPort!.postMessage({ id, error: `Unknown message type: ${(message as { type?: unknown }).type}` });
    }
  } catch (err: unknown) {
    const response: WorkerErrorResponse = { id, error: errorMessage(err, { includeStack: true }) };
    parentPort!.postMessage(response);
  }
});
