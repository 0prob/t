import { describe, it, expect } from "vitest";
import { toBigInt, toBigIntOrNull, bigintToApproxNumber, toFiniteNumber, isBigIntConvertible } from "./bigint.ts";
import * as fc from "fast-check";

describe("toBigInt", () => {
  it("returns bigint unchanged", () => {
    expect(toBigInt(42n)).toBe(42n);
  });
  it("converts numeric strings", () => {
    expect(toBigInt("123")).toBe(123n);
  });
  it("converts integers", () => {
    expect(toBigInt(456)).toBe(456n);
  });
  it("converts boolean", () => {
    expect(toBigInt(true)).toBe(1n);
    expect(toBigInt(false)).toBe(0n);
  });
  it("returns fallback for null", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(null, 99n)).toBe(99n);
  });
  it("returns fallback for invalid strings", () => {
    expect(toBigInt("not a number", 7n)).toBe(7n);
  });
  it("returns fallback for non-integer numbers", () => {
    expect(toBigInt(3.14, 0n)).toBe(0n);
  });

  it("property: result matches direct BigInt for safe integers", () => {
    fc.assert(fc.property(fc.integer(), (n) => {
      expect(toBigInt(n)).toBe(BigInt(n));
    }));
  });
});

describe("toBigIntOrNull", () => {
  it("returns null for null/undefined", () => {
    expect(toBigIntOrNull(null)).toBeNull();
    expect(toBigIntOrNull(undefined)).toBeNull();
  });
  it("returns null for invalid strings", () => {
    expect(toBigIntOrNull("foo")).toBeNull();
  });
  it("returns bigint for valid input", () => {
    expect(toBigIntOrNull("100")).toBe(100n);
  });
});

describe("bigintToApproxNumber", () => {
  it("returns 0 for zero", () => {
    expect(bigintToApproxNumber(0n)).toBe(0);
  });
  it("converts small positive bigints exactly", () => {
    expect(bigintToApproxNumber(12345n)).toBe(12345);
  });
  it("converts negative bigints", () => {
    expect(bigintToApproxNumber(-100n)).toBe(-100);
  });
  it("handles decimals shift", () => {
    expect(bigintToApproxNumber(1_000_000_000_000_000_000n, 18)).toBe(1);
  });
  it("handles very large values without overflow", () => {
    const huge = 10n ** 30n;
    const approx = bigintToApproxNumber(huge);
    expect(approx).toBeGreaterThan(0);
    expect(Number.isFinite(approx)).toBe(true);
  });

  it("property: round-trips small integers", () => {
    fc.assert(fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (n) => {
      expect(bigintToApproxNumber(BigInt(n))).toBe(n);
    }));
  });
});

describe("toFiniteNumber", () => {
  it("returns finite numbers unchanged", () => {
    expect(toFiniteNumber(3.14)).toBe(3.14);
  });
  it("returns fallback for NaN", () => {
    expect(toFiniteNumber(NaN, 99)).toBe(99);
  });
  it("returns fallback for Infinity", () => {
    expect(toFiniteNumber(Infinity, 99)).toBe(99);
  });
  it("converts bigint", () => {
    expect(toFiniteNumber(42n)).toBe(42);
  });
  it("converts numeric strings", () => {
    expect(toFiniteNumber("3.14")).toBe(3.14);
  });
});

describe("isBigIntConvertible", () => {
  it("detects convertible types", () => {
    expect(isBigIntConvertible(1n)).toBe(true);
    expect(isBigIntConvertible("123")).toBe(true);
    expect(isBigIntConvertible(123)).toBe(true);
    expect(isBigIntConvertible(true)).toBe(true);
  });
  it("rejects non-convertible types", () => {
    expect(isBigIntConvertible(null)).toBe(false);
    expect(isBigIntConvertible({})).toBe(false);
    expect(isBigIntConvertible([])).toBe(false);
  });
});
