import type { Address } from "./types/common.ts";

export type EvmAddress = Address;
export type ProtocolKey = string;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export function isFastEvmAddress(value: string) {
  if (value.length !== 42) return false;
  if (value.charCodeAt(0) !== 48) return false;
  const prefix = value.charCodeAt(1);
  if (prefix !== 120 && prefix !== 88) return false;
  for (let i = 2; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 70;
    const lower = code >= 97 && code <= 102;
    if (!digit && !upper && !lower) return false;
  }
  return true;
}

export function normalizeEvmAddress(value: unknown, options: { allowZero?: boolean } = {}): Address | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!EVM_ADDRESS_RE.test(normalized)) return null;
  if (!options.allowZero && normalized === ZERO_ADDRESS) return null;
  return normalized as Address;
}

export function isEvmAddress(value: unknown, options: { allowZero?: boolean } = {}) {
  return normalizeEvmAddress(value, options) != null;
}

export function normalizeProtocolKey(protocol: unknown): ProtocolKey {
  return String(protocol ?? "")
    .trim()
    .toUpperCase();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

export const normalizeAddress = normalizeEvmAddress;

const POLYGON_SYSTEM_PREFIXES = [
  "0x02",
  "0x03",
  "0x04",
  "0x05",
  "0x06",
  "0x07",
  "0x08",
  "0x09",
  "0x0a",
  "0x0b",
  "0x0c",
  "0x0d",
  "0x0e",
  "0x0f",
];

export function isPolygonSystemContract(address: string): boolean {
  const lower = address.toLowerCase();
  return POLYGON_SYSTEM_PREFIXES.some((p) => lower.startsWith(p));
}
