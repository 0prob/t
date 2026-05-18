/**
 * Shared bigint conversion utilities extracted from math/{uniswap_v3,uniswap_v2,balancer,curve,dodo,woofi}.ts
 * to eliminate identical copies of BigIntConvertible/isBigIntConvertible and BigIntOrNull variants.
 */

export type BigIntConvertible = bigint | string | number | boolean;

export function isBigIntConvertible(value: unknown): value is BigIntConvertible {
  return typeof value === "bigint" || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function toBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (value == null) return fallback;
  if (!isBigIntConvertible(value)) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

/**
 * Convert a value to bigint, or null if the value is not convertible.
 * Accepts bigint, string, number, or boolean inputs.
 */
export function toBigIntOrNull(value: unknown): bigint | null {
  if (!isBigIntConvertible(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Converts a bigint, number, or string to a finite number.
 * Returns `fallback` (default 0) for NaN, Infinity, or unrecognized input.
 */
/**
 * Convert a bigint to an approximate number, with optional decimal scaling.
 * For values with >15 digits, uses scientific notation to preserve precision
 * within the 53-bit mantissa limit.
 */
export function bigintToApproxNumber(value: bigint, decimals = 0): number {
  if (value === 0n) return 0;

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = abs.toString();
  const integerDigits = digits.length - decimals;

  if (integerDigits > 308) {
    return negative ? -Number.MAX_VALUE : Number.MAX_VALUE;
  }

  if (digits.length <= 15 + decimals) {
    const scaled = Number(abs) / 10 ** decimals;
    return negative ? -scaled : scaled;
  }

  const exponent = integerDigits - 1;
  const mantissaDigits = digits.slice(0, 15);
  const mantissa = mantissaDigits.length === 1 ? mantissaDigits : `${mantissaDigits[0]}.${mantissaDigits.slice(1)}`;
  const approximate = Number(`${mantissa}e${exponent}`);
  return negative ? -approximate : approximate;
}

export function toFiniteNumber(value: bigint | number | string | unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
