import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { isRecord } from "../utils/identity.ts";
export { isRecord };

export const WOOFI_PROTOCOL = "WOOFI";
export const WOOFI_ROUTER_V2 = "0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7";
export const WOOFI_WOOPP_V2 = "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4";
export const WOOFI_WOORACLE_V2 = "0x2A8Ede62D0717C8C92b88639ecf603FDF31A8428";
export const WOOFI_INTEGRATION_HELPER = "0x7Ba560eB735AbDCf9a3a5692272652A0cc81850d";

export const WOOFI_POOL_ABI = [
  {
    name: "quoteToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "wooracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "tokenInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "reserve", type: "uint256" },
          { name: "feeRate", type: "uint16" },
          { name: "maxGamma", type: "uint128" },
          { name: "maxNotionalSwap", type: "uint128" },
        ],
      },
    ],
  },
] as const;

export const WOOFI_ORACLE_ABI = [
  {
    name: "state",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "base", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "price", type: "uint128" },
          { name: "spread", type: "uint64" },
          { name: "coeff", type: "uint64" },
          { name: "woFeasible", type: "bool" },
        ],
      },
    ],
  },
] as const;

export const WOOFI_ORACLE_WITH_DECIMALS_ABI = [
  ...WOOFI_ORACLE_ABI,
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "base", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export function tupleValue(value: unknown, index: number, key: string) {
  if (Array.isArray(value)) return value[index];
  if (isRecord(value)) return value[key] ?? value[index];
  return undefined;
}

export function bigintOrZero(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function toBigIntValue(value: unknown): bigint {
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`invalid bigint value: ${String(value)}`);
}

export function normalizeWoofiAddress(value: unknown): string | null {
  return normalizeEvmAddress(value);
}
