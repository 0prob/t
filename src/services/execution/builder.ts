import { getAddress, encodeFunctionData } from "viem";
import { encodeRoute, encodeExecuteArb, buildFlashParams, computeRouteHash, type ExecutorCall } from "./calldata.ts";

export interface BuilderRouteInput {
  path: {
    startToken?: unknown;
    edges: Array<{
      poolAddress?: unknown;
      tokenIn?: unknown;
      tokenOut?: unknown;
      protocol?: unknown;
      zeroForOne?: unknown;
      fee?: unknown;
      swapFeeBps?: unknown;
      metadata?: Record<string, unknown>;
      tokenInIdx?: unknown;
      tokenOutIdx?: unknown;
      poolId?: unknown;
      stateRef?: Record<string, unknown>;
    }>;
  };
  result: {
    amountIn?: unknown;
    amountOut?: unknown;
    profit?: unknown;
    hopAmounts?: unknown[];
    tokenPath?: unknown[];
    poolPath?: unknown[];
  };
}

export interface BuilderConfig {
  executorAddress: string;
  fromAddress: string;
}

export interface BuilderOptions {
  minProfit?: bigint;
  deadlineOffsetS?: number;
  slippageBps?: number;
  maxCalls?: number;
}

export interface BuiltTransaction {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasLimit?: bigint;
  routeHash: `0x${string}`;
  calls: ExecutorCall[];
  meta: Record<string, unknown>;
}

const DEFAULT_DEADLINE_OFFSET_S = 120;
const DEFAULT_MAX_CALLS = 12;

function normalizeEvmAddress(value: unknown): `0x${string}` | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return getAddress(value);
  }
  return null;
}

function assertValidRoute(route: BuilderRouteInput): void {
  if (!route?.path || !route?.result) throw new Error("buildArbTx: route path/result required");
  const startToken = normalizeEvmAddress(route.path.startToken);
  if (!startToken) throw new Error("buildArbTx: valid path.startToken required");
  if (!Array.isArray(route.path.edges) || route.path.edges.length === 0) {
    throw new Error("buildArbTx: path.edges must be non-empty");
  }
  const amountIn = route.result.amountIn;
  const amountOut = route.result.amountOut;
  if (typeof amountIn !== "bigint" || amountIn <= 0n) throw new Error("buildArbTx: result.amountIn must be > 0");
  if (typeof amountOut !== "bigint" || amountOut <= 0n) throw new Error("buildArbTx: result.amountOut must be > 0");
  if (!Array.isArray(route.result.hopAmounts) || route.result.hopAmounts.length !== route.path.edges.length + 1) {
    throw new Error("buildArbTx: hopAmounts length mismatch");
  }
  if (!Array.isArray(route.result.tokenPath) || route.result.tokenPath.length !== route.path.edges.length + 1) {
    throw new Error("buildArbTx: tokenPath length mismatch");
  }
  if (!Array.isArray(route.result.poolPath) || route.result.poolPath.length !== route.path.edges.length) {
    throw new Error("buildArbTx: poolPath length mismatch");
  }
}

export function buildArbTx(
  route: BuilderRouteInput,
  config: BuilderConfig,
  options: BuilderOptions = {},
): BuiltTransaction {
  const { executorAddress, fromAddress } = config;
  const {
    minProfit = 0n,
    deadlineOffsetS = DEFAULT_DEADLINE_OFFSET_S,
    slippageBps = 50,
    maxCalls = DEFAULT_MAX_CALLS,
  } = options;

  if (!executorAddress) throw new Error("buildArbTx: executorAddress required");
  if (!fromAddress) throw new Error("buildArbTx: fromAddress required");
  if (minProfit < 0n) throw new Error("buildArbTx: minProfit must be >= 0");
  if (!Number.isFinite(deadlineOffsetS) || deadlineOffsetS <= 0) throw new Error("buildArbTx: deadlineOffsetS must be > 0");
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("buildArbTx: slippageBps must be between 0 and 10000");
  }
  assertValidRoute(route);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineOffsetS);
  const flashToken = normalizeEvmAddress(route.path.startToken)!;
  const flashAmount = route.result.amountIn as bigint;
  const profitToken = flashToken;

  const calls = encodeRoute(route as never, executorAddress, { slippageBps, deadline });
  if (calls.length > maxCalls) {
    throw new Error(`buildArbTx: route expands to ${calls.length} calls (max ${maxCalls})`);
  }

  const flashParams = buildFlashParams({ profitToken, minProfit, deadline, calls });
  const encodedTx = encodeExecuteArb({ executorAddress, flashToken, flashAmount, profitToken, minProfit, deadline, calls });
  const routeHash = computeRouteHash(calls);

  return {
    to: encodedTx.to,
    data: encodedTx.data,
    value: 0n,
    routeHash,
    calls,
    meta: {
      flashToken,
      flashAmount: flashAmount.toString(),
      profitToken,
      minProfit: minProfit.toString(),
      deadline: Number(deadline),
      slippageBps,
      callCount: calls.length,
      routeHash,
      hopCount: route.path.edges.length,
      protocols: route.path.edges.map((e) => e.protocol),
      pools: (route.result.poolPath as string[]) ?? [],
      tokens: (route.result.tokenPath as string[]) ?? [],
      hopAmounts: (route.result.hopAmounts as bigint[])?.map(String) ?? [],
      expectedProfit: String(route.result.profit ?? ""),
    },
  };
}
