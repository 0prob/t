export type ProtocolKey = string;
export type ProtocolFamily = "V2" | "V3" | "CURVE" | "BALANCER" | "DODO" | "WOOFI";

export interface ProtocolDefinition {
  key: ProtocolKey;
  family: ProtocolFamily;
  factoryAddress: string;
  eventSignature: string;
  topic0: string;
  startBlock: number;
  decode: (log: unknown) => DecodedPool | null;
}

export interface DecodedPool {
  address: string;
  token0: string;
  token1: string;
  tokens?: string[];
  fee?: number;
  tickSpacing?: number;
  poolType?: string;
  blockNumber: number;
}

export const V2_FAMILY_KEYS = new Set([
  "QUICKSWAP_V2", "SUSHISWAP_V2", "DFYN_V2", "APESWAP_V2",
  "COMETHSWAP_V2", "MESHSWAP_V2", "JETSWAP_V2", "UNISWAP_V2",
]);

export const V3_FAMILY_KEYS = new Set([
  "UNISWAP_V3", "SUSHISWAP_V3", "QUICKSWAP_V3", "KYBERSWAP_ELASTIC",
]);

export const CURVE_FAMILY_KEYS = new Set([
  "CURVE_MAIN_REGISTRY", "CURVE_STABLE_FACTORY", "CURVE_CRYPTO_FACTORY",
  "CURVE_STABLESWAP_NG", "CURVE_TRICRYPTO_NG",
]);

export const BALANCER_FAMILY_KEYS = new Set(["BALANCER_V2"]);
export const DODO_FAMILY_KEYS = new Set(["DODO_DVM", "DODO_DPP", "DODO_DSP"]);
export const WOOFI_FAMILY_KEYS = new Set(["WOOFI"]);

export function protocolFamily(key: string): ProtocolFamily | null {
  const upper = key.toUpperCase();
  if (V2_FAMILY_KEYS.has(upper)) return "V2";
  if (V3_FAMILY_KEYS.has(upper)) return "V3";
  if (CURVE_FAMILY_KEYS.has(upper)) return "CURVE";
  if (BALANCER_FAMILY_KEYS.has(upper)) return "BALANCER";
  if (DODO_FAMILY_KEYS.has(upper)) return "DODO";
  if (WOOFI_FAMILY_KEYS.has(upper)) return "WOOFI";
  return null;
}

export function isV2Protocol(key: string): boolean { return V2_FAMILY_KEYS.has(key.toUpperCase()); }
export function isV3Protocol(key: string): boolean { return V3_FAMILY_KEYS.has(key.toUpperCase()); }
export function isCurveProtocol(key: string): boolean { return CURVE_FAMILY_KEYS.has(key.toUpperCase()); }
export function isBalancerProtocol(key: string): boolean { return BALANCER_FAMILY_KEYS.has(key.toUpperCase()); }
export function isDodoProtocol(key: string): boolean { return DODO_FAMILY_KEYS.has(key.toUpperCase()); }
export function isWoofiProtocol(key: string): boolean { return WOOFI_FAMILY_KEYS.has(key.toUpperCase()); }
