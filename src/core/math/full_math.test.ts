import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mulDiv, mulDivRoundingUp, divRoundingUp } from "./full_math.ts";

const bigUint64 = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });

describe("mulDiv", () => {
  it("computes a * b / d for small values", () => {
    expect(mulDiv(10n, 20n, 5n)).toBe(40n);
  });
  it("handles zero numerator", () => {
    expect(mulDiv(0n, 100n, 7n)).toBe(0n);
  });
  it("rounds toward zero", () => {
    expect(mulDiv(7n, 3n, 4n)).toBe(5n);
  });
  it("throws on zero denominator", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow();
  });
  it("property: result matches (a*b)/d for positive inputs", () => {
    fc.assert(fc.property(
      bigUint64, bigUint64, bigUint64.filter((n) => n > 0n),
      (a, b, d) => {
        expect(mulDiv(a, b, d)).toBe((a * b) / d);
      },
    ));
  });
});

describe("mulDivRoundingUp", () => {
  it("rounds up when remainder is non-zero", () => {
    expect(mulDivRoundingUp(7n, 3n, 4n)).toBe(6n);
  });
  it("matches mulDiv when result is exact", () => {
    expect(mulDivRoundingUp(10n, 20n, 5n)).toBe(40n);
  });
  it("throws on zero denominator", () => {
    expect(() => mulDivRoundingUp(1n, 1n, 0n)).toThrow();
  });
  it("property: rounds up correctly", () => {
    fc.assert(fc.property(
      bigUint64, bigUint64, bigUint64.filter((n) => n > 0n),
      (a, b, d) => {
        const product = a * b;
        const expected = product % d > 0n ? product / d + 1n : product / d;
        expect(mulDivRoundingUp(a, b, d)).toBe(expected);
      },
    ));
  });
});

describe("divRoundingUp", () => {
  it("rounds up non-exact division", () => {
    expect(divRoundingUp(10n, 3n)).toBe(4n);
  });
  it("returns exact result for clean division", () => {
    expect(divRoundingUp(10n, 2n)).toBe(5n);
  });
  it("throws on zero divisor", () => {
    expect(() => divRoundingUp(1n, 0n)).toThrow();
  });
});
