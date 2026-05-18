import type { Address } from "./common.ts";
import type { PoolState } from "./pool.ts";

export interface RouteEdge {
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  protocol: string;
  zeroForOne: boolean;
  fee?: number | bigint | string | null;
  swapFeeBps?: number | null;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  stateRef?: PoolState | null;
}

export interface ArbPath {
  startToken: Address;
  edges: RouteEdge[];
  hopCount: number;
  logWeight: number;
  cumulativeFeesBps?: number;
}

export interface SimulatedHopResult {
  amountOut: bigint;
  gasEstimate: number;
}

export interface RouteSimulationResult {
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  profitable: boolean;
  hopAmounts: bigint[];
  totalGas: number;
  poolPath: string[];
  tokenPath: string[];
  protocols: string[];
  hopCount: number;
}

export type RouteResultCore = Pick<RouteSimulationResult, "amountIn" | "amountOut" | "profit" | "totalGas">;

export type RouteResultTrace = Pick<RouteSimulationResult, "profitable" | "hopCount" | "poolPath" | "tokenPath" | "hopAmounts" | "protocols">;

export interface EvaluatedRoute {
  path: ArbPath;
  result: RouteSimulationResult;
}

export type RouteStateCache = Map<string, PoolState>;

export interface CycleEnumerationOptions {
  maxHops: number;
  maxPaths: number;
  max4HopPaths?: number;
  hubTokens: Address[];
  allTokens?: Address[];
  liquidityFloorWei?: bigint;
}

export interface RouteIdentityEdge {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
}
