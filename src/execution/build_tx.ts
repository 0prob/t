/**
 * src/execution/build_tx.js — Transaction builder
 *
 * Constructs the complete transaction object for an arbitrage execution.
 * Delegates calldata encoding to the existing calldata.js module and
 * adds gas parameters from gas.js.
 *
 * This module is a pure builder — it does not submit transactions.
 * Use send_tx.js for submission.
 *
 * Usage:
 *   import { buildArbTx } from "./build_tx.js";
 *   const tx = await buildArbTx(route, config);
 *   // tx: { to, data, value, maxFeePerGas, maxPriorityFeePerGas, gasLimit, ... }
 */

import { encodeFunctionData, getAddress } from "viem";

import { encodeRoute, encodeExecuteArb, buildFlashParams } from "./calldata.ts";
import { ERC20_TRANSFER_ABI } from "./abi_fragments.ts";
import { recommendGasParams } from "./gas.ts";
import { routeExecutionCacheKey } from "../routing/route_identity.ts";
import { getPathHopCount } from "../routing/path_hops.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { isSwapExecutionProtocol, normalizeProtocolKey } from "../protocols/classification.ts";
import { CONFIG_DEFAULT_SLIPPAGE_BPS, CONFIG_DEFAULT_GAS_MULTIPLIER, CONFIG_DEFAULT_MIN_PROFIT_WEI } from "../config/index.ts";

// ─── Defaults ─────────────────────────────────────────────────

const DEFAULT_DEADLINE_OFFSET_S = 120;
const EXECUTOR_MAX_CALLS = 12;

export type ExecutionRouteEdge = {
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
};

export type ExecutionRouteInput = {
  path?: {
    startToken?: unknown;
    edges?: ExecutionRouteEdge[];
    hopCount?: unknown;
    [key: string]: unknown;
  };
  result?: {
    amountIn?: unknown;
    amountOut?: unknown;
    profit?: unknown;
    hopAmounts?: unknown;
    tokenPath?: unknown;
    poolPath?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ValidatedExecutionRoute = {
  path: {
    startToken: string;
    edges: Array<
      ExecutionRouteEdge & {
        poolAddress: string;
        tokenIn: string;
        tokenOut: string;
        protocol: string;
      }
    >;
    hopCount?: unknown;
    [key: string]: unknown;
  };
  result: {
    amountIn: bigint;
    amountOut: bigint;
    profit: bigint;
    hopAmounts: bigint[];
    tokenPath: string[];
    poolPath: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type GasParamsOverride = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  effectiveGasPriceWei?: bigint;
  estimatedCostWei: bigint;
  maxCostWei?: bigint;
};

export type BuildArbTxConfig = {
  executorAddress: string | null | undefined;
  fromAddress: string | null | undefined;
};

export type BuildArbTxOptions = {
  minProfit?: bigint;
  deadlineOffsetS?: number;
  slippageBps?: number;
  gasMultiplier?: number;
  maxFeeOverride?: bigint;
  priorityFeeOverride?: bigint;
  maxEstimatedCostWei?: bigint;
  gasEstimateCacheKey?: string;
  gasParamsOverride?: GasParamsOverride | null;
};

export type ExecutionCall = {
  target: string;
  value: bigint;
  data: string;
};

export type BuiltTxMeta = Record<string, unknown>;

export type BuiltTx = {
  to: string;
  data: string;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  effectiveGasPriceWei?: bigint;
  estimatedCostWei?: bigint;
  maxCostWei?: bigint;
  gasEstimateCacheKey?: string;
  meta: BuiltTxMeta;
  flashParams?: Record<string, unknown>;
  calls?: ExecutionCall[];
};

function assertValidRouteForExecution(route: ExecutionRouteInput): asserts route is ValidatedExecutionRoute {
  if (!route?.path || !route?.result) {
    throw new Error("buildArbTx: route path/result required");
  }
  const amountIn = route.result.amountIn;
  const amountOut = route.result.amountOut;
  const profit = route.result.profit;
  const startToken = normalizeEvmAddress(route.path.startToken);
  if (!startToken) {
    throw new Error("buildArbTx: valid path.startToken required");
  }
  if (!Array.isArray(route.path.edges) || route.path.edges.length === 0) {
    throw new Error("buildArbTx: path.edges must be non-empty");
  }
  if (typeof amountIn !== "bigint" || amountIn <= 0n) {
    throw new Error("buildArbTx: result.amountIn must be > 0");
  }
  if (typeof amountOut !== "bigint" || amountOut <= 0n) {
    throw new Error("buildArbTx: result.amountOut must be > 0");
  }
  if (typeof profit !== "bigint" || profit !== amountOut - amountIn) {
    throw new Error("buildArbTx: inconsistent result.profit");
  }
  if (!Array.isArray(route.result.hopAmounts) || route.result.hopAmounts.length !== route.path.edges.length + 1) {
    throw new Error("buildArbTx: hopAmounts length mismatch");
  }
  if (!Array.isArray(route.result.tokenPath) || route.result.tokenPath.length !== route.path.edges.length + 1) {
    throw new Error("buildArbTx: tokenPath length mismatch");
  }
  if (!Array.isArray(route.result.poolPath) || route.result.poolPath.length !== route.path.edges.length) {
    throw new Error("buildArbTx: poolPath length mismatch");
  }
  if (!route.result.hopAmounts.every((amount) => typeof amount === "bigint")) {
    throw new Error("buildArbTx: hopAmounts must be bigint values");
  }
  if (!route.result.hopAmounts.every((amount) => amount > 0n)) {
    throw new Error("buildArbTx: hopAmounts must be > 0");
  }
  if (route.result.hopAmounts[0] !== amountIn) {
    throw new Error("buildArbTx: hopAmounts must start with amountIn");
  }
  if (route.result.hopAmounts[route.result.hopAmounts.length - 1] !== amountOut) {
    throw new Error("buildArbTx: hopAmounts must end with amountOut");
  }
  const normalizedTokenPath = route.result.tokenPath.map((token: unknown) => normalizeEvmAddress(token));
  const normalizedPoolPath = route.result.poolPath.map((pool: unknown) => normalizeEvmAddress(pool));
  if (normalizedTokenPath.some((token: string | null) => token == null)) {
    throw new Error("buildArbTx: tokenPath contains invalid token address");
  }
  if (normalizedPoolPath.some((pool: string | null) => pool == null)) {
    throw new Error("buildArbTx: poolPath contains invalid pool address");
  }
  if (normalizedTokenPath[0] !== startToken) {
    throw new Error("buildArbTx: tokenPath must start with path.startToken");
  }
  if (normalizedTokenPath[normalizedTokenPath.length - 1] !== startToken) {
    throw new Error("buildArbTx: tokenPath must end with path.startToken");
  }
  const normalizedEdges: Array<{ poolAddress: string; protocol: string; tokenIn: string; tokenOut: string }> = [];
  for (let i = 0; i < route.path.edges.length; i++) {
    const edge = route.path.edges[i];
    const protocol = normalizeProtocolKey(edge?.protocol);
    if (!protocol) throw new Error(`buildArbTx: edge ${i} missing protocol`);
    if (!isSwapExecutionProtocol(protocol)) {
      throw new Error(`buildArbTx: edge ${i} uses unsupported execution protocol ${protocol}`);
    }
    const edgeTokenIn = normalizeEvmAddress(edge?.tokenIn);
    const edgeTokenOut = normalizeEvmAddress(edge?.tokenOut);
    const edgePool = normalizeEvmAddress(edge?.poolAddress);
    if (!edgeTokenIn || !edgeTokenOut || !edgePool) {
      throw new Error(`buildArbTx: edge ${i} contains invalid route address`);
    }
    if (normalizedTokenPath[i] !== edgeTokenIn) {
      throw new Error(`buildArbTx: tokenPath input mismatch at hop ${i}`);
    }
    if (normalizedTokenPath[i + 1] !== edgeTokenOut) {
      throw new Error(`buildArbTx: tokenPath output mismatch at hop ${i}`);
    }
    if (normalizedPoolPath[i] !== edgePool) {
      throw new Error(`buildArbTx: poolPath mismatch at hop ${i}`);
    }
    normalizedEdges.push({ poolAddress: edgePool, protocol, tokenIn: edgeTokenIn, tokenOut: edgeTokenOut });
  }

  route.path.startToken = startToken;
  route.result.tokenPath = normalizedTokenPath;
  route.result.poolPath = normalizedPoolPath;
  for (let i = 0; i < route.path.edges.length; i++) {
    route.path.edges[i].poolAddress = normalizedEdges[i].poolAddress;
    route.path.edges[i].protocol = normalizedEdges[i].protocol;
    route.path.edges[i].tokenIn = normalizedEdges[i].tokenIn;
    route.path.edges[i].tokenOut = normalizedEdges[i].tokenOut;
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Determine the flash loan token and amount for a route.
 *
 * @param {Object} route  { path, result }
 * @returns {{ flashToken: string, flashAmount: bigint }}
 */
function resolveFlashLoan(route: ValidatedExecutionRoute) {
  return {
    flashToken: route.path.startToken,
    flashAmount: route.result.amountIn,
  };
}

export function gasEstimateCacheKeyForRoute(
  route: ExecutionRouteInput,
  context: { fromAddress?: unknown; executorAddress?: unknown; callCount?: unknown } = {},
) {
  const startToken = route?.path?.startToken;
  const edges = route?.path?.edges;
  const hopCount = getPathHopCount({
    edges,
    hopCount: typeof route?.path?.hopCount === "number" ? route.path.hopCount : undefined,
  });

  if (typeof startToken !== "string" || !startToken) {
    throw new Error("gasEstimateCacheKeyForRoute: path.startToken required");
  }
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error("gasEstimateCacheKeyForRoute: path.edges must be non-empty");
  }
  if (!Number.isFinite(hopCount) || hopCount <= 0) {
    throw new Error("gasEstimateCacheKeyForRoute: path hop count must be > 0");
  }

  const routeKey = routeExecutionCacheKey(
    startToken,
    hopCount,
    edges as Array<{ poolAddress: string; tokenIn: string; tokenOut: string; protocol: string }>,
  );
  const fromAddress = normalizeEvmAddress(context.fromAddress);
  const executorAddress = normalizeEvmAddress(context.executorAddress);
  const callCount = Number(context.callCount);
  const hasContext = context.fromAddress != null || context.executorAddress != null || context.callCount != null;
  if (!hasContext) return routeKey;
  if (!fromAddress) {
    throw new Error("gasEstimateCacheKeyForRoute: valid fromAddress required when cache context is provided");
  }
  if (!executorAddress) {
    throw new Error("gasEstimateCacheKeyForRoute: valid executorAddress required when cache context is provided");
  }
  if (!Number.isSafeInteger(callCount) || callCount <= 0) {
    throw new Error("gasEstimateCacheKeyForRoute: callCount must be a positive integer when cache context is provided");
  }

  return `gas:${fromAddress}:${executorAddress}:calls=${callCount}:${routeKey}`;
}
// ─── Main builder ─────────────────────────────────────────────

/**
 * @typedef {Object} BuiltTx
 * @property {string}  to                   Contract to call (ArbExecutor)
 * @property {string}  data                 Encoded calldata
 * @property {bigint}  value                ETH value (0 for ERC-20 arbs)
 * @property {bigint}  maxFeePerGas         EIP-1559 max fee
 * @property {bigint}  maxPriorityFeePerGas EIP-1559 priority fee
 * @property {bigint}  gasLimit             Gas limit with safety buffer
 * @property {bigint}  effectiveGasPriceWei Expected EIP-1559 paid gas price
 * @property {Object}  meta                 Human-readable metadata
 * @property {Object}  flashParams          Encoded flash loan params
 */

/**
 * Build a complete arbitrage transaction (without submitting).
 *
 * @param {Object} route              Profitable route { path, result }
 * @param {Object} config
 * @param {string} config.executorAddress  Deployed ArbExecutor contract address
 * @param {string} config.fromAddress      Sender/signer address (for gas estimation)
 * @param {Object} [options]
 * @param {bigint} [options.minProfit]     Minimum profit enforced on-chain
 * @param {number} [options.deadlineOffsetS]
 * @param {number} [options.slippageBps]
 * @param {number} [options.gasMultiplier]
 * @param {bigint} [options.maxFeeOverride]
 * @param {bigint} [options.priorityFeeOverride]
 * @param {bigint} [options.maxEstimatedCostWei]
 * @param {{maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, gasLimit: bigint, estimatedCostWei: bigint}} [options.gasParamsOverride]
 * @returns {Promise<BuiltTx>}
 */
export async function buildArbTx(route: ExecutionRouteInput, config: BuildArbTxConfig, options: BuildArbTxOptions = {}): Promise<BuiltTx> {
  const { executorAddress, fromAddress } = config;
  const {
    minProfit = CONFIG_DEFAULT_MIN_PROFIT_WEI,
    deadlineOffsetS = DEFAULT_DEADLINE_OFFSET_S,
    slippageBps = Number(CONFIG_DEFAULT_SLIPPAGE_BPS),
    gasMultiplier = CONFIG_DEFAULT_GAS_MULTIPLIER,
    maxFeeOverride,
    priorityFeeOverride,
    maxEstimatedCostWei,
    gasEstimateCacheKey: gasEstimateCacheKeyOverride,
    gasParamsOverride = null,
  } = options;

  if (!executorAddress) throw new Error("buildArbTx: executorAddress required");
  if (!fromAddress) throw new Error("buildArbTx: fromAddress required");
  assertValidRouteForExecution(route);
  if (!Number.isFinite(deadlineOffsetS) || deadlineOffsetS <= 0) {
    throw new Error("buildArbTx: deadlineOffsetS must be > 0");
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("buildArbTx: slippageBps must be between 0 and 10000");
  }
  if (!Number.isFinite(gasMultiplier) || gasMultiplier <= 0) {
    throw new Error("buildArbTx: gasMultiplier must be > 0");
  }
  if (minProfit < 0n) throw new Error("buildArbTx: minProfit must be >= 0");

  const { flashToken, flashAmount } = resolveFlashLoan(route);
  const profitToken = route.path.startToken;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineOffsetS);

  // Encode route into Call[]
  const calls = encodeRoute(route, executorAddress, { slippageBps, deadline });
  if (calls.length > EXECUTOR_MAX_CALLS) {
    throw new Error(`buildArbTx: route expands to ${calls.length} executor calls (max ${EXECUTOR_MAX_CALLS})`);
  }

  // Build flash loan params (includes route hash)
  const flashParams = buildFlashParams({ profitToken, minProfit, deadline, calls });

  // Encode full executeArb calldata
  const encodedTx = encodeExecuteArb({
    executorAddress,
    flashToken,
    flashAmount,
    profitToken,
    minProfit,
    deadline,
    calls,
  });

  // Build skeleton tx for gas estimation
  const skelTx = {
    to: encodedTx.to,
    data: encodedTx.data,
    value: 0n,
  };

  // Get gas params (estimate + EIP-1559 fees)
  const gasEstimateKey =
    gasEstimateCacheKeyOverride ??
    gasEstimateCacheKeyForRoute(route, {
      fromAddress,
      executorAddress,
      callCount: calls.length,
    });

  const gasParams =
    gasParamsOverride ??
    (await recommendGasParams(skelTx, fromAddress, {
      gasMultiplier,
      maxFeeOverride,
      priorityFeeOverride,
      maxEstimatedCostWei,
      gasEstimateCacheKey: gasEstimateKey,
    }));

  // Metadata for logging
  const meta = {
    protocol: route.path.edges.map((e) => e.protocol),
    pools: route.result.poolPath,
    tokens: route.result.tokenPath,
    hopAmounts: route.result.hopAmounts.map(String),
    expectedProfit: route.result.profit.toString(),
    flashToken,
    flashAmount: flashAmount.toString(),
    callCount: calls.length,
    routeHash: flashParams.routeHash,
    deadline: Number(deadline),
    slippageBps,
    gasLimit: gasParams.gasLimit.toString(),
    estimatedGasCostWei: gasParams.estimatedCostWei.toString(),
    maxGasCostWei: gasParams.maxCostWei?.toString?.(),
    maxEstimatedGasCostWei: maxEstimatedCostWei?.toString?.(),
  };

  return {
    to: encodedTx.to,
    data: encodedTx.data,
    value: 0n,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
    gasLimit: gasParams.gasLimit,
    effectiveGasPriceWei: gasParams.effectiveGasPriceWei,
    maxCostWei: gasParams.maxCostWei,
    gasEstimateCacheKey: gasEstimateKey,
    meta,
    flashParams,
    calls,
  };
}

/**
 * Build a simple ERC-20 transfer transaction (for testing/approval flows).
 *
 * @param {string} token      Token address
 * @param {string} to         Recipient
 * @param {bigint} amount     Amount in token units
 * @param {string} fromAddress Sender
 * @returns {Promise<BuiltTx>}
 */
export async function buildTransferTx(token: string, to: string, amount: bigint | number | string, fromAddress: string): Promise<BuiltTx> {
  const tokenAddress = getAddress(token);
  const recipientAddress = getAddress(to);
  const transferAmount = BigInt(amount);
  if (transferAmount < 0n) {
    throw new Error("buildTransferTx: amount must be >= 0");
  }

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [recipientAddress, transferAmount],
  });

  const skelTx = { to: tokenAddress, data, value: 0n };
  const gasParams = await recommendGasParams(skelTx, fromAddress);

  return {
    to: tokenAddress,
    data,
    value: 0n,
    ...gasParams,
    meta: { type: "erc20_transfer", token: tokenAddress, to: recipientAddress, amount: transferAmount.toString() },
  };
}
