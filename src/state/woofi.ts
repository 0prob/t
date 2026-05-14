import { isNoDataReadContractError, readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { ENRICH_CONCURRENCY } from "../config/index.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { errorMessage } from "../utils/errors.ts";
import {
  WOOFI_WOOPP_V2,
  WOOFI_WOORACLE_V2,
  WOOFI_POOL_ABI,
  WOOFI_ORACLE_WITH_DECIMALS_ABI,
  tupleValue,
  toBigIntValue,
} from "../protocols/woofi_shared.ts";

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export type WoofiTokenInfo = {
  reserve: bigint;
  feeRate: bigint;
  maxGamma: bigint;
  maxNotionalSwap: bigint;
};

export type WoofiOracleState = {
  price: bigint;
  spread: bigint;
  coeff: bigint;
  feasible: boolean;
  priceDecimals: number;
  priceDec: bigint;
};

export type WoofiBaseState = WoofiTokenInfo &
  WoofiOracleState & {
    token: string;
    baseDecimals: number;
    quoteDecimals: number;
    baseDec: bigint;
    quoteDec: bigint;
  };

export type WoofiPoolState = {
  address: string;
  quoteToken: string;
  wooracle: string;
  tokens: string[];
  quoteReserve: bigint;
  quoteFeeRate: bigint;
  quoteDecimals: number;
  quoteDec: bigint;
  baseStates: WoofiBaseState[];
  fetchedAt: number;
};

export type WoofiStateMap = Map<string, WoofiPoolState> & {
  noDataFailures?: Set<string>;
};

type WoofiFetchResult = { addr: string; state: WoofiPoolState; error: null } | { addr: string; state: null; error: unknown };

function pow10(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) return 1n;
  return 10n ** BigInt(decimals);
}

async function readAddress(poolAddress: string, functionName: "quoteToken" | "wooracle"): Promise<string | null> {
  return normalizeEvmAddress(
    await readContractWithRetry({
      address: poolAddress,
      abi: WOOFI_POOL_ABI,
      functionName,
    }),
  );
}

async function readTokenDecimals(token: string): Promise<number> {
  const value = await readContractWithRetry({
    address: token,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  });
  return Number(value);
}

const UNLIMITED_GAMMA = (1n << 128n) - 1n;

function tryOptionalBigint(value: unknown): bigint | null {
  if (value == null) return null;
  try {
    return toBigIntValue(value);
  } catch {
    return null;
  }
}

async function fetchTokenInfo(poolAddress: string, token: string): Promise<WoofiTokenInfo> {
  const result = await readContractWithRetry({
    address: poolAddress,
    abi: WOOFI_POOL_ABI,
    functionName: "tokenInfos",
    args: [token],
  });
  return {
    reserve: toBigIntValue(tupleValue(result, 0, "reserve")),
    feeRate: toBigIntValue(tupleValue(result, 1, "feeRate")),
    maxGamma: tryOptionalBigint(tupleValue(result, 2, "maxGamma")) ?? UNLIMITED_GAMMA,
    maxNotionalSwap: tryOptionalBigint(tupleValue(result, 3, "maxNotionalSwap")) ?? UNLIMITED_GAMMA,
  };
}

async function fetchOracleState(wooracle: string, token: string): Promise<WoofiOracleState> {
  const [state, decimals] = await Promise.all([
    readContractWithRetry({
      address: wooracle,
      abi: WOOFI_ORACLE_WITH_DECIMALS_ABI,
      functionName: "state",
      args: [token],
    }),
    readContractWithRetry({
      address: wooracle,
      abi: WOOFI_ORACLE_WITH_DECIMALS_ABI,
      functionName: "decimals",
      args: [token],
    }),
  ]);
  const priceDecimals = Number(decimals);
  return {
    price: toBigIntValue(tupleValue(state, 0, "price")),
    spread: toBigIntValue(tupleValue(state, 1, "spread")),
    coeff: toBigIntValue(tupleValue(state, 2, "coeff")),
    feasible: tupleValue(state, 3, "woFeasible") !== false,
    priceDecimals,
    priceDec: pow10(priceDecimals),
  };
}

async function fetchWoofiBaseState(
  poolAddress: string,
  wooracle: string,
  quoteDecimals: number,
  token: string,
  cachedBaseDecimals?: number,
): Promise<WoofiBaseState> {
  const [tokenInfo, oracle, baseDecimals] = await Promise.all([
    fetchTokenInfo(poolAddress, token),
    fetchOracleState(wooracle, token),
    cachedBaseDecimals != null ? Promise.resolve(cachedBaseDecimals) : readTokenDecimals(token),
  ]);

  return {
    token,
    ...tokenInfo,
    ...oracle,
    baseDecimals,
    quoteDecimals,
    baseDec: pow10(baseDecimals),
    quoteDec: pow10(quoteDecimals),
  };
}

export async function fetchWoofiPoolState(
  poolAddress: string = WOOFI_WOOPP_V2,
  options: { tokens?: string[]; tokenDecimals?: Map<string, number> | null } = {},
): Promise<WoofiPoolState> {
  const addr = normalizeEvmAddress(poolAddress) ?? normalizeEvmAddress(WOOFI_WOOPP_V2)!;
  const [quoteToken, wooracleAddress] = await Promise.all([
    readAddress(addr, "quoteToken"),
    readAddress(addr, "wooracle").catch(() => null),
  ]);
  if (!quoteToken) {
    throw new Error(`WOOFi: quoteToken() returned an invalid address for ${addr}`);
  }

  const wooracle = wooracleAddress ?? normalizeEvmAddress(WOOFI_WOORACLE_V2)!;
  const candidateTokens = [
    ...new Set((options.tokens ?? []).map((token) => normalizeEvmAddress(token)).filter((token): token is string => token != null)),
  ];
  const baseTokens = candidateTokens.filter((token) => token !== quoteToken);
  const cachedQuoteDecimals = options.tokenDecimals?.get(quoteToken.toLowerCase());
  const [quoteInfo, quoteDecimals] = await Promise.all([
    fetchTokenInfo(addr, quoteToken),
    cachedQuoteDecimals != null ? Promise.resolve(cachedQuoteDecimals) : readTokenDecimals(quoteToken),
  ]);

  const baseResults = await throttledMap(
    baseTokens,
    async (token) => {
      try {
        const cachedBaseDecimals = options.tokenDecimals?.get(token.toLowerCase());
        const state = await fetchWoofiBaseState(addr, wooracle, quoteDecimals, token, cachedBaseDecimals);
        if (state.reserve <= 0n || state.price <= 0n || !state.feasible) return null;
        return state;
      } catch (error) {
        if (!isNoDataReadContractError(error)) {
          console.warn(`  Failed to fetch WOOFi base state for ${token}: ${errorMessage(error)}`);
        }
        return null;
      }
    },
    ENRICH_CONCURRENCY,
  );
  const baseStates = baseResults.filter((state): state is WoofiBaseState => state != null);

  return {
    address: addr,
    quoteToken,
    wooracle,
    tokens: [quoteToken, ...baseStates.map((state) => state.token)],
    quoteReserve: quoteInfo.reserve,
    quoteFeeRate: quoteInfo.feeRate,
    quoteDecimals,
    quoteDec: pow10(quoteDecimals),
    baseStates,
    fetchedAt: Date.now(),
  };
}

export async function fetchMultipleWoofiStates(
  poolAddresses: string[],
  concurrency = ENRICH_CONCURRENCY,
  poolTokens: Map<string, string[]> = new Map(),
): Promise<WoofiStateMap> {
  const states: WoofiStateMap = new Map();
  const noDataFailures = new Set<string>();

  const results = await throttledMap(
    poolAddresses,
    async (addr): Promise<WoofiFetchResult> => {
      const normalizedAddr = String(addr).toLowerCase();
      try {
        const state = await fetchWoofiPoolState(normalizedAddr, {
          tokens: poolTokens.get(normalizedAddr) ?? [],
        });
        return { addr: normalizedAddr, state, error: null };
      } catch (error) {
        if (isNoDataReadContractError(error)) {
          noDataFailures.add(normalizedAddr);
        }
        console.warn(`  Failed to fetch WOOFi state for ${addr}: ${errorMessage(error)}`);
        return { addr: normalizedAddr, state: null, error };
      }
    },
    concurrency,
  );

  for (const { addr, state } of results) {
    if (state) states.set(addr, state);
  }

  states.noDataFailures = noDataFailures;
  return states;
}
