import type { Address } from "./common.ts";

export interface V2PoolState {
  reserve0: bigint;
  reserve1: bigint;
  fee: bigint;
  feeDenominator: bigint;
}

export interface V3PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  fee: bigint;
  tickSpacing?: number;
  ticks?: Map<number, { liquidityGross: bigint; liquidityNet: bigint }>;
}

export interface CurvePoolState {
  balances: bigint[];
  A: bigint;
  fee: bigint;
  rates?: bigint[];
  virtualPrice?: bigint;
  nCoins: number;
}

export interface BalancerPoolState {
  balances: bigint[];
  weights?: bigint[];
  scalingFactors?: bigint[];
  amp?: bigint;
  ampPrecision?: bigint;
  fee: bigint;
  poolType: "weighted" | "stable";
  bptIndex?: number;
}

export interface DodoPoolState {
  baseReserve: bigint;
  quoteReserve: bigint;
  baseTarget: bigint;
  quoteTarget: bigint;
  i: bigint;
  k: bigint;
  rState: number;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
  fee: bigint;
}

export interface WoofiPoolState {
  quoteReserve: bigint;
  quoteFeeRate: bigint;
  quoteDec: bigint;
  fee: bigint;
  feeDenominator: bigint;
  balances: bigint[];
  baseInfos: Map<Address, WoofiBaseInfo>;
}

export interface WoofiBaseInfo {
  price: bigint;
  spread: bigint;
  coeff: bigint;
  reserve: bigint;
  dec: bigint;
}

export type PoolState = Record<string, unknown>;

export interface PoolMeta {
  address: Address;
  protocol: string;
  token0: Address;
  token1: Address;
  tokens?: Address[];
  fee?: number;
  tickSpacing?: number;
  poolType?: string;
  discoveredBlock?: number;
  status?: "active" | "removed";
}

export interface PoolRecord extends PoolMeta {
  stateJson?: string;
  lastStateBlock?: number;
  lastStateTimestamp?: number;
}

export interface CachedPoolFee {
  address: Address;
  protocol: string;
  fee: number;
}

export interface CachedTokenMeta {
  address: Address;
  decimals: number;
  symbol?: string;
  name?: string;
}
