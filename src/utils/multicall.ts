/**
 * multicall.ts — Multicall3 batching utilities
 *
 * Multicall3 is deployed at the canonical address on Polygon (and 250+ chains):
 *   0xcA11bde05977b3631167028862bE2a173976CA11
 *
 * Use these helpers to replace any loop of individual readContract / eth_call
 * calls with a single JSON-RPC round-trip.
 *
 * Why Multicall3 over Multicall2?
 *   - tryAggregate3 lets individual calls fail without aborting the batch.
 *   - aggregate3Value supports payable calls (not needed here but forward-compat).
 *   - Same canonical address across all EVM chains we might expand to.
 */

import type { Abi, Address, ContractFunctionName, ContractFunctionArgs } from "viem";
import type { PublicClient } from "viem";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MulticallCall<
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, "pure" | "view"> = ContractFunctionName<TAbi, "pure" | "view">,
> {
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args?: ContractFunctionArgs<TAbi, "pure" | "view", TFunctionName>;
}

export interface MulticallResult<T> {
  success: boolean;
  result: T | undefined;
  error?: Error;
}

// ─── Core batch helper ───────────────────────────────────────────────────────

/**
 * Execute an arbitrary set of view/pure calls in a single JSON-RPC request.
 * Uses allowFailure=true (Multicall3 tryAggregate3 semantics) so one bad call
 * does not abort the batch.
 *
 * @param client  A viem PublicClient (any RPC — typically the main read client
 *                or the HyperRPC client for hydration, NOT the execution client).
 * @param calls   Array of contract calls to batch.
 * @returns       Parallel array of {success, result, error} per call.
 */
export async function multicall<T = unknown>(client: PublicClient, calls: MulticallCall<Abi>[]): Promise<MulticallResult<T>[]> {
  if (calls.length === 0) return [];

  const raw = await client.multicall({
    contracts: calls as Parameters<typeof client.multicall>[0]["contracts"],
    multicallAddress: MULTICALL3_ADDRESS,
    allowFailure: true,
  });

  return raw.map((r) => {
    if (r.status === "success") {
      return { success: true, result: r.result as T };
    }
    return { success: false, result: undefined, error: r.error as Error };
  });
}

/**
 * Chunk-aware multicall: splits `calls` into pages of `chunkSize` and fires
 * them serially. Use this for large token/pool sets to stay within RPC payload
 * limits and avoid memory spikes.
 *
 * @param client     A viem PublicClient.
 * @param calls      Full list of calls to execute.
 * @param chunkSize  Max calls per batch (default 128).
 */
export async function multicallChunked<T = unknown>(
  client: PublicClient,
  calls: MulticallCall<Abi>[],
  chunkSize = 128,
): Promise<MulticallResult<T>[]> {
  const results: MulticallResult<T>[] = [];
  for (let i = 0; i < calls.length; i += chunkSize) {
    const chunk = calls.slice(i, i + chunkSize);
    const chunkResults = await multicall<T>(client, chunk);
    results.push(...chunkResults);
  }
  return results;
}

// ─── ERC-20 metadata batch ────────────────────────────────────────────────────

const ERC20_META_ABI = [
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { name: "name", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

export interface TokenMetadata {
  address: Address;
  decimals: number;
  symbol: string;
  name: string;
}

/**
 * Fetch decimals, symbol, and name for a list of ERC-20 tokens in a single
 * Multicall3 request (3 calls × N tokens = 1 round-trip).
 *
 * @param client     A viem PublicClient.
 * @param tokens     Token addresses to hydrate.
 * @param chunkSize  Max tokens per batch (default 64, i.e. 192 calls/batch).
 */
export async function fetchTokenMetadata(client: PublicClient, tokens: Address[], chunkSize = 64): Promise<TokenMetadata[]> {
  const calls = tokens.flatMap((address) => [
    { address, abi: ERC20_META_ABI, functionName: "decimals" as const },
    { address, abi: ERC20_META_ABI, functionName: "symbol" as const },
    { address, abi: ERC20_META_ABI, functionName: "name" as const },
  ]);

  const results = await multicallChunked<number | string>(
    client,
    calls,
    chunkSize * 3, // 3 calls per token
  );

  return tokens.map((address, i) => {
    const [dec, sym, nam] = results.slice(i * 3, i * 3 + 3);
    return {
      address,
      decimals: dec.success && typeof dec.result === "number" ? dec.result : 18,
      symbol: sym.success && typeof sym.result === "string" ? sym.result : "???",
      name: nam.success && typeof nam.result === "string" ? nam.result : "Unknown",
    };
  });
}

// ─── ERC-20 balance + allowance pre-flight ────────────────────────────────────

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface BalanceAllowance {
  balance: bigint;
  allowance: bigint;
}

/**
 * Fetch ERC-20 balance AND allowance for a single token in one Multicall3
 * round-trip — replaces two separate eth_call / readContract invocations that
 * typically happen during execution pre-flight.
 *
 * @param client   A viem PublicClient (use the main read client, not execution).
 * @param token    ERC-20 token address.
 * @param owner    Address whose balance to check (typically the executor contract).
 * @param spender  Address to check allowance for (e.g. Balancer vault, router).
 */
export async function fetchBalanceAndAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<BalanceAllowance> {
  // Fix #5: viem multicall with allowFailure:false returns raw values directly
  // as a readonly tuple — NOT {status, result} objects. Accessing .result on
  // them returns undefined. Destructure the values directly.
  const results = await client.multicall({
    contracts: [
      {
        address: token,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [owner],
      },
      {
        address: token,
        abi: ERC20_BALANCE_ABI,
        functionName: "allowance",
        args: [owner, spender],
      },
    ],
    multicallAddress: MULTICALL3_ADDRESS,
    allowFailure: false, // hard-fail: if we can't read balances, abort execution
  });

  // In viem v2, multicall with allowFailure: false returns an array of results directly.
  // However, the type system might still treat it as a tuple of results.
  const [balance, allowance] = results as [bigint, bigint];

  return {
    balance,
    allowance,
  };
}
