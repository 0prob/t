import { encodeFunctionData, getAddress, keccak256, encodeAbiParameters } from "viem";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../../core/math/tick_math.ts";
import { simulateV3Swap } from "../../core/math/uniswap_v3.ts";

const ERC20_TRANSFER_ABI = [{
  name: "transfer", type: "function", inputs: [
    { name: "to", type: "address" }, { name: "amount", type: "uint256" },
  ], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable",
}];

const V2_PAIR_SWAP_ABI = [{
  name: "swap", type: "function", inputs: [
    { name: "amount0Out", type: "uint256" }, { name: "amount1Out", type: "uint256" },
    { name: "to", type: "address" }, { name: "data", type: "bytes" },
  ], outputs: [], stateMutability: "nonpayable",
}];

const V3_POOL_SWAP_ABI = [{
  name: "swap", type: "function", inputs: [
    { name: "recipient", type: "address" }, { name: "zeroForOne", type: "bool" },
    { name: "amountSpecified", type: "int256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
    { name: "data", type: "bytes" },
  ], outputs: [{ name: "amount0", type: "int256" }, { name: "amount1", type: "int256" }],
  stateMutability: "nonpayable",
}];

const KYBER_ELASTIC_POOL_SWAP_ABI = [{
  name: "swap", type: "function", inputs: [
    { name: "recipient", type: "address" }, { name: "swapQty", type: "int256" },
    { name: "isToken0", type: "bool" }, { name: "limitSqrtP", type: "uint160" },
    { name: "data", type: "bytes" },
  ], outputs: [{ name: "qty0", type: "int256" }, { name: "qty1", type: "int256" }],
  stateMutability: "nonpayable",
}];

const DODO_SELL_BASE_ABI = [{
  name: "sellBase", type: "function", inputs: [{ name: "to", type: "address" }],
  outputs: [{ name: "receiveQuoteAmount", type: "uint256" }], stateMutability: "nonpayable",
}];

const DODO_SELL_QUOTE_ABI = [{
  name: "sellQuote", type: "function", inputs: [{ name: "to", type: "address" }],
  outputs: [{ name: "receiveBaseAmount", type: "uint256" }], stateMutability: "nonpayable",
}];

const WOOFI_ROUTER_SWAP_ABI = [{
  name: "swap", type: "function", inputs: [
    { name: "fromToken", type: "address" }, { name: "toToken", type: "address" },
    { name: "fromAmount", type: "uint256" }, { name: "minToAmount", type: "uint256" },
    { name: "to", type: "address" }, { name: "rebateTo", type: "address" },
  ], outputs: [{ name: "realToAmount", type: "uint256" }], stateMutability: "payable",
}];

const CURVE_EXCHANGE_INT128_ABI = [{
  name: "exchange", type: "function", inputs: [
    { name: "i", type: "int128" }, { name: "j", type: "int128" },
    { name: "dx", type: "uint256" }, { name: "min_dy", type: "uint256" },
  ], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable",
}];

const CURVE_EXCHANGE_UINT256_ABI = [{
  name: "exchange", type: "function", inputs: [
    { name: "i", type: "uint256" }, { name: "j", type: "uint256" },
    { name: "dx", type: "uint256" }, { name: "min_dy", type: "uint256" },
  ], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable",
}];

const CURVE_EXCHANGE_INT128_RECEIVER_ABI = [{
  name: "exchange", type: "function", inputs: [
    { name: "i", type: "int128" }, { name: "j", type: "int128" },
    { name: "dx", type: "uint256" }, { name: "min_dy", type: "uint256" },
    { name: "receiver", type: "address" },
  ], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable",
}];

const BALANCER_VAULT_SWAP_ABI = [{
  name: "swap", type: "function", inputs: [
    { name: "singleSwap", type: "tuple", components: [
      { name: "poolId", type: "bytes32" }, { name: "kind", type: "uint8" },
      { name: "assetIn", type: "address" }, { name: "assetOut", type: "address" },
      { name: "amount", type: "uint256" }, { name: "userData", type: "bytes" },
    ] },
    { name: "funds", type: "tuple", components: [
      { name: "sender", type: "address" }, { name: "fromInternalBalance", type: "bool" },
      { name: "recipient", type: "address" }, { name: "toInternalBalance", type: "bool" },
    ] },
    { name: "limit", type: "uint256" }, { name: "deadline", type: "uint256" },
  ], outputs: [{ name: "amountCalculated", type: "uint256" }], stateMutability: "payable",
}];

const EXECUTOR_ABI = [{
  name: "executeArb", type: "function", inputs: [
    { name: "flashToken", type: "address" }, { name: "flashAmount", type: "uint256" },
    { name: "params", type: "tuple", components: [
      { name: "profitToken", type: "address" }, { name: "minProfit", type: "uint256" },
      { name: "deadline", type: "uint256" }, { name: "routeHash", type: "bytes32" },
      { name: "calls", type: "tuple[]", components: [
        { name: "target", type: "address" }, { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ] },
    ] },
  ], outputs: [], stateMutability: "nonpayable",
}];

const EXECUTOR_APPROVE_IF_NEEDED_ABI = [{
  name: "approveIfNeeded", type: "function", inputs: [
    { name: "token", type: "address" }, { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ], outputs: [], stateMutability: "nonpayable",
}];

const CALL_STRUCT_ARRAY_ABI = [{
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
}] as const;

// Protocol sets

const V2_PROTOCOLS = new Set([
  "QUICKSWAP_V2", "SUSHISWAP_V2", "UNISWAP_V2", "DFYN_V2",
  "COMETHSWAP_V2", "APESWAP_V2", "MESHSWAP_V2", "JETSWAP_V2",
]);

const CURVE_STABLE_PROTOCOLS = new Set([
  "CURVE_STABLE", "CURVE_STABLE_FACTORY", "CURVE_STABLESWAP_NG",
]);

const CURVE_CRYPTO_PROTOCOLS = new Set([
  "CURVE_CRYPTO", "CURVE_CRYPTO_FACTORY", "CURVE_TRICRYPTO_NG",
]);

const DODO_PROTOCOLS = new Set(["DODO_V2"]);

const WOOFI_PROTOCOLS = new Set(["WOOFI"]);

const BALANCER_PROTOCOLS = new Set(["BALANCER", "BALANCER_V2"]);

const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const WOOFI_ROUTER_V2 = "0x817Eb46D069c1d3b9C1f41EC7923E73F9c2d6BA3";

const CALLBACK_PROTOCOL_UNISWAP_V3 = 1;
const CALLBACK_PROTOCOL_SUSHISWAP_V3 = 2;
const CALLBACK_PROTOCOL_QUICKSWAP_V3 = 3;
const CALLBACK_PROTOCOL_KYBER_ELASTIC = 4;
const BPS_DENOMINATOR = 10_000;
const MAX_UINT24 = 16_777_215n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Types ─────────────────────────────────────────────────────

export type ExecutorCall = {
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
};

export type CalldataHop = {
  protocol?: unknown;
  poolAddress?: unknown;
  tokenIn?: unknown;
  tokenOut?: unknown;
  zeroForOne?: unknown;
  amountIn?: unknown;
  amountOut?: unknown;
  fee?: unknown;
  swapFeeBps?: unknown;
  kyberSwapFeeBps?: unknown;
  router?: unknown;
  metadata?: Record<string, unknown>;
  tokenInIdx?: unknown;
  tokenOutIdx?: unknown;
  isCrypto?: unknown;
  poolId?: unknown;
  stateRef?: Record<string, unknown>;
};

export type CalldataRoute = {
  path: {
    edges: CalldataHop[];
  };
  result: {
    hopAmounts: unknown[];
  };
};

export type RouteCalldataOptions = {
  slippageBps?: number;
  deadline?: bigint;
};

export type FlashParamsInput = {
  profitToken: string;
  minProfit: bigint;
  deadline: bigint;
  calls: unknown;
};

export type ExecuteArbInput = FlashParamsInput & {
  executorAddress: string;
  flashToken: string;
  flashAmount: bigint;
};

// ─── Helpers ───────────────────────────────────────────────────

function asAddress(value: unknown): `0x${string}` {
  return getAddress(String(value));
}

function normalizeUint(value: unknown, label: string): bigint {
  try {
    const n = BigInt(value as string | number | bigint | boolean);
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function normalizePositiveUint(value: unknown, label: string): bigint {
  const n = normalizeUint(value, label);
  if (n <= 0n) throw new Error(`${label} must be > 0`);
  return n;
}

function normalizeUint24(value: unknown, label: string): number {
  const n = normalizeUint(value, label);
  if (n > MAX_UINT24) throw new Error(`${label} must fit uint24`);
  return Number(n);
}

function normalizeSlippageBps(value: unknown): number {
  const n = Number(value ?? 50);
  if (!Number.isSafeInteger(n) || n < 0 || n > BPS_DENOMINATOR) {
    throw new Error("slippageBps must be an integer between 0 and 10000");
  }
  return n;
}

function slippageAdjustedAmountOut(amountOut: unknown, slippageBps: unknown, label: string): bigint {
  const output = normalizePositiveUint(amountOut, `${label} amountOut`);
  const bps = normalizeSlippageBps(slippageBps);
  const minOut = (output * BigInt(BPS_DENOMINATOR - bps)) / BigInt(BPS_DENOMINATOR);
  if (minOut <= 0n) throw new Error(`${label} minimum output must be > 0`);
  return minOut;
}

function normalizeBytes32(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value as `0x${string}` : null;
}

function normalizeExecutorCalls(calls: unknown): ExecutorCall[] {
  if (!Array.isArray(calls)) throw new Error("executor calls must be an array");
  return calls.map((call, index) => {
    if (!call || typeof call !== "object") throw new Error(`executor call ${index} must be an object`);
    const r = call as { target?: unknown; value?: unknown; data?: unknown };
    const target = asAddress(r.target);
    const value = normalizeUint(r.value ?? 0n, `executor call ${index} value`);
    const data = typeof r.data === "string" ? r.data : "";
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
      throw new Error(`executor call ${index} data must be 0x-prefixed even-length hex`);
    }
    return { target, value, data: data.toLowerCase() as `0x${string}` };
  });
}

function callbackProtocolId(protocol: unknown): number {
  switch (protocol) {
    case "UNISWAP_V3": return CALLBACK_PROTOCOL_UNISWAP_V3;
    case "SUSHISWAP_V3": return CALLBACK_PROTOCOL_SUSHISWAP_V3;
    case "QUICKSWAP_V3": return CALLBACK_PROTOCOL_QUICKSWAP_V3;
    case "KYBERSWAP_ELASTIC": return CALLBACK_PROTOCOL_KYBER_ELASTIC;
    default: throw new Error(`encodeV3Hop: unsupported callback protocol ${protocol}`);
  }
}

function poolTokensFromHop(hop: CalldataHop): { token0: `0x${string}`; token1: `0x${string}` } {
  return hop.zeroForOne
    ? { token0: asAddress(hop.tokenIn), token1: asAddress(hop.tokenOut) }
    : { token0: asAddress(hop.tokenOut), token1: asAddress(hop.tokenIn) };
}

function deriveTightV3PriceLimit(
  hop: CalldataHop, amountIn: bigint, expectedAmountOut: bigint, fee: number, label: string,
): bigint {
  const state = hop.stateRef ?? {};
  const sqrtBefore = normalizeUint(state.sqrtPriceX96, `${label} stateRef.sqrtPriceX96`);
  const liquidity = normalizeUint(state.liquidity, `${label} stateRef.liquidity`);
  if (sqrtBefore <= MIN_SQRT_RATIO || sqrtBefore >= MAX_SQRT_RATIO || liquidity <= 0n) {
    throw new Error(`${label}: valid stateRef sqrtPriceX96/liquidity required`);
  }
  const simulated = simulateV3Swap(state as Record<string, unknown>, amountIn, Boolean(hop.zeroForOne), fee);
  if (simulated.amountOut !== expectedAmountOut) {
    throw new Error(`${label}: simulated amountOut mismatch`);
  }
  const sqrtAfter = simulated.sqrtPriceX96After;
  const movedOk = hop.zeroForOne
    ? sqrtAfter < sqrtBefore && sqrtAfter > MIN_SQRT_RATIO
    : sqrtAfter > sqrtBefore && sqrtAfter < MAX_SQRT_RATIO;
  if (!movedOk) throw new Error(`${label}: unable to derive price limit`);
  const SLIPPAGE_BPS = 10n;
  const DENOM = 10_000n;
  return hop.zeroForOne
    ? (sqrtAfter * (DENOM - SLIPPAGE_BPS)) / DENOM
    : (sqrtAfter * (DENOM + SLIPPAGE_BPS)) / DENOM;
}

function encodeDynamicApprovalCall(
  executor: string, token: string, spender: string, amount: bigint,
): ExecutorCall {
  return {
    target: getAddress(executor),
    value: 0n,
    data: encodeFunctionData({
      abi: EXECUTOR_APPROVE_IF_NEEDED_ABI,
      functionName: "approveIfNeeded",
      args: [getAddress(token), getAddress(spender), normalizeUint(amount, "approval amount")],
    }),
  };
}

function normalizeKyberSwapFeePips(hop: CalldataHop): number {
  const metadata = (hop.metadata ?? {}) as Record<string, unknown>;
  const explicitBps = hop.swapFeeBps ?? hop.kyberSwapFeeBps ?? metadata.swapFeeBps;
  if (explicitBps != null) {
    const feeBps = normalizeUint(explicitBps, "encodeKyberElasticHop swapFeeBps");
    if (feeBps > 10_000n) throw new Error("encodeKyberElasticHop swapFeeBps must be <= 10000");
    const feePips = feeBps * 100n;
    if (feePips > MAX_UINT24) throw new Error("encodeKyberElasticHop fee pips exceeds uint24");
    return Number(feePips);
  }
  const feePips = normalizeUint(hop.fee ?? 0, "encodeKyberElasticHop fee");
  if (feePips > MAX_UINT24) throw new Error("encodeKyberElasticHop fee pips exceeds uint24");
  return Number(feePips);
}

// ─── Per-hop encoders ──────────────────────────────────────────

export function encodeV2Hop(hop: CalldataHop, recipient: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const pair = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeV2Hop amountIn");
  const minAmountOut = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeV2Hop");
  const calls: ExecutorCall[] = [];
  calls.push({
    target: tokenIn, value: 0n,
    data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [pair, amountIn] }),
  });
  const amount0Out = hop.zeroForOne ? 0n : minAmountOut;
  const amount1Out = hop.zeroForOne ? minAmountOut : 0n;
  calls.push({
    target: pair, value: 0n,
    data: encodeFunctionData({ abi: V2_PAIR_SWAP_ABI, functionName: "swap", args: [amount0Out, amount1Out, asAddress(recipient), "0x"] }),
  });
  return calls;
}

export function encodeV3Hop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const { token0, token1 } = poolTokensFromHop(hop);
  const amountSpecified = normalizePositiveUint(hop.amountIn, "encodeV3Hop amountIn");
  const amountOut = normalizePositiveUint(hop.amountOut, "encodeV3Hop amountOut");
  const fee = normalizeUint24(hop.fee ?? 0, "encodeV3Hop fee");
  const sqrtPriceLimitX96 = deriveTightV3PriceLimit(hop, amountSpecified, amountOut, fee, "encodeV3Hop");
  const callbackData = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "protocolId", type: "uint8" }, { name: "token0", type: "address" },
      { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
    ] }],
    [{ protocolId: callbackProtocolId(hop.protocol), token0, token1, fee }],
  );
  return [{
    target: pool, value: 0n,
    data: encodeFunctionData({
      abi: V3_POOL_SWAP_ABI, functionName: "swap",
      args: [asAddress(recipient), Boolean(hop.zeroForOne), amountSpecified, sqrtPriceLimitX96, callbackData],
    }),
  }];
}

export function encodeKyberElasticHop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const { token0, token1 } = poolTokensFromHop(hop);
  const amountSpecified = normalizePositiveUint(hop.amountIn, "encodeKyberElasticHop amountIn");
  const isToken0 = Boolean(hop.zeroForOne);
  const swapFeePips = normalizeKyberSwapFeePips(hop);
  const simulated = simulateV3Swap(hop.stateRef ?? {}, amountSpecified, isToken0, swapFeePips);
  const sqrtPriceLimitX96 = deriveTightV3PriceLimit(hop, amountSpecified, simulated.amountOut, swapFeePips, "encodeKyberElasticHop");
  const callbackData = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "protocolId", type: "uint8" }, { name: "token0", type: "address" },
      { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
    ] }],
    [{ protocolId: callbackProtocolId("KYBERSWAP_ELASTIC"), token0, token1, fee: swapFeePips }],
  );
  return [{
    target: pool, value: 0n,
    data: encodeFunctionData({
      abi: KYBER_ELASTIC_POOL_SWAP_ABI, functionName: "swap",
      args: [asAddress(recipient), amountSpecified, isToken0, sqrtPriceLimitX96, callbackData],
    }),
  }];
}

export function encodeDodoHop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeDodoHop amountIn");
  return [
    {
      target: tokenIn, value: 0n,
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [pool, amountIn] }),
    },
    {
      target: pool, value: 0n,
      data: encodeFunctionData({
        abi: hop.zeroForOne ? DODO_SELL_BASE_ABI : DODO_SELL_QUOTE_ABI,
        functionName: hop.zeroForOne ? "sellBase" : "sellQuote",
        args: [asAddress(recipient)],
      }),
    },
  ];
}

export function encodeWoofiHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const router = asAddress(hop.router ?? (hop.metadata as Record<string, unknown> | undefined)?.router ?? WOOFI_ROUTER_V2);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const exec = asAddress(executor);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeWoofiHop amountIn");
  const minToAmount = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeWoofiHop");
  return [
    encodeDynamicApprovalCall(exec, tokenIn, router, amountIn),
    {
      target: router, value: 0n,
      data: encodeFunctionData({
        abi: WOOFI_ROUTER_SWAP_ABI, functionName: "swap",
        args: [tokenIn, tokenOut, amountIn, minToAmount, exec, ZERO_ADDRESS],
      }),
    },
  ];
}

export function encodeCurveHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const pool = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenInIdx = Number(hop.tokenInIdx);
  const tokenOutIdx = Number(hop.tokenOutIdx);
  if (!Number.isInteger(tokenInIdx) || tokenInIdx < 0) throw new Error("encodeCurveHop: valid tokenInIdx required");
  if (!Number.isInteger(tokenOutIdx) || tokenOutIdx < 0) throw new Error("encodeCurveHop: valid tokenOutIdx required");
  if (tokenInIdx === tokenOutIdx) throw new Error("encodeCurveHop: token indices must differ");
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeCurveHop amountIn");
  const minDy = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeCurveHop");
  const calls: ExecutorCall[] = [encodeDynamicApprovalCall(executor, tokenIn, pool, amountIn)];
  const proto = String(hop.protocol ?? "");
  if (proto === "CURVE_STABLESWAP_NG") {
    calls.push({
      target: pool, value: 0n,
      data: encodeFunctionData({
        abi: CURVE_EXCHANGE_INT128_RECEIVER_ABI, functionName: "exchange",
        args: [tokenInIdx, tokenOutIdx, amountIn, minDy, executor],
      }),
    });
  } else if (hop.isCrypto) {
    calls.push({
      target: pool, value: 0n,
      data: encodeFunctionData({
        abi: CURVE_EXCHANGE_UINT256_ABI, functionName: "exchange",
        args: [BigInt(tokenInIdx), BigInt(tokenOutIdx), amountIn, minDy],
      }),
    });
  } else {
    calls.push({
      target: pool, value: 0n,
      data: encodeFunctionData({
        abi: CURVE_EXCHANGE_INT128_ABI, functionName: "exchange",
        args: [tokenInIdx, tokenOutIdx, amountIn, minDy],
      }),
    });
  }
  return calls;
}

export function encodeBalancerHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50, deadline } = options;
  const poolId = normalizeBytes32(hop.poolId);
  if (!poolId) throw new Error("encodeBalancerHop: poolId required");
  if (deadline == null) throw new Error("encodeBalancerHop: deadline required");
  const vault = asAddress(BALANCER_VAULT);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const exec = asAddress(executor);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeBalancerHop amountIn");
  const limit = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeBalancerHop");
  return [
    encodeDynamicApprovalCall(exec, tokenIn, vault, amountIn),
    {
      target: vault, value: 0n,
      data: encodeFunctionData({
        abi: BALANCER_VAULT_SWAP_ABI, functionName: "swap",
        args: [
          { poolId, kind: 0, assetIn: tokenIn, assetOut: tokenOut, amount: amountIn, userData: "0x" },
          { sender: exec, fromInternalBalance: false, recipient: exec, toInternalBalance: false },
          limit, deadline,
        ],
      }),
    },
  ];
}

// ─── Route encoder ─────────────────────────────────────────────

function normalizeProtocolKey(protocol: unknown): string {
  if (typeof protocol === "string") return protocol.toUpperCase().replace(/\s+/g, "_");
  return String(protocol ?? "").toUpperCase().replace(/\s+/g, "_");
}

export function encodeRoute(route: CalldataRoute, executorAddress: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { path, result } = route;
  const executor = asAddress(executorAddress);
  const calls: ExecutorCall[] = [];
  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    const amountIn = result.hopAmounts[i];
    const amountOut = result.hopAmounts[i + 1];
    const proto = normalizeProtocolKey(edge.protocol);
    const meta = (edge.metadata ?? {}) as Record<string, unknown>;
    const hop: CalldataHop = {
      protocol: proto,
      poolAddress: edge.poolAddress, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
      zeroForOne: edge.zeroForOne, amountIn, amountOut,
      fee: edge.fee ?? meta.fee ?? 0,
      swapFeeBps: edge.swapFeeBps ?? meta.swapFeeBps,
      router: meta.router, metadata: meta, stateRef: edge.stateRef,
      tokenInIdx: edge.tokenInIdx ?? meta.tokenInIdx ?? (edge.zeroForOne ? 0 : 1),
      tokenOutIdx: edge.tokenOutIdx ?? meta.tokenOutIdx ?? (edge.zeroForOne ? 1 : 0),
      isCrypto: CURVE_CRYPTO_PROTOCOLS.has(proto),
      poolId: normalizeBytes32(
        meta.poolId ?? meta.pool_id ?? edge.poolId ?? (edge.stateRef as Record<string, unknown> | undefined)?.balancerPoolId
          ?? (edge.stateRef as Record<string, unknown> | undefined)?.poolId,
      ),
    };
    if (V2_PROTOCOLS.has(proto)) {
      calls.push(...encodeV2Hop(hop, executor, options));
    } else if (proto === "KYBERSWAP_ELASTIC") {
      calls.push(...encodeKyberElasticHop(hop, executor));
    } else if (DODO_PROTOCOLS.has(proto)) {
      calls.push(...encodeDodoHop(hop, executor));
    } else if (WOOFI_PROTOCOLS.has(proto)) {
      calls.push(...encodeWoofiHop(hop, executor, options));
    } else if (proto.startsWith("UNISWAP_V3") || proto.startsWith("SUSHISWAP_V3") || proto.startsWith("QUICKSWAP_V3")) {
      calls.push(...encodeV3Hop(hop, executor));
    } else if (CURVE_STABLE_PROTOCOLS.has(proto) || CURVE_CRYPTO_PROTOCOLS.has(proto)) {
      calls.push(...encodeCurveHop(hop, executor, options));
    } else if (BALANCER_PROTOCOLS.has(proto)) {
      calls.push(...encodeBalancerHop(hop, executor, options));
    } else {
      throw new Error(`Unsupported protocol for execution: ${proto} at hop ${i}`);
    }
  }
  return calls;
}

// ─── Route hash ────────────────────────────────────────────────

export function computeRouteHash(calls: unknown): `0x${string}` {
  const normalized = normalizeExecutorCalls(calls);
  const encoded = encodeAbiParameters(CALL_STRUCT_ARRAY_ABI, [
    normalized.map((c) => ({ target: c.target, value: c.value, data: c.data })),
  ]);
  return keccak256(encoded);
}

// ─── FlashParams builder ───────────────────────────────────────

export function buildFlashParams(input: FlashParamsInput) {
  const normalizedCalls = normalizeExecutorCalls(input.calls);
  const routeHash = computeRouteHash(normalizedCalls);
  return {
    profitToken: getAddress(input.profitToken),
    minProfit: input.minProfit,
    deadline: input.deadline,
    routeHash,
    calls: normalizedCalls,
  };
}

// ─── Top-level transaction encoder ─────────────────────────────

export function encodeExecuteArb(input: ExecuteArbInput) {
  const flashParams = buildFlashParams(input);
  const data = encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: "executeArb",
    args: [getAddress(input.flashToken), input.flashAmount, flashParams],
  });
  return { to: getAddress(input.executorAddress), data, value: 0n };
}
