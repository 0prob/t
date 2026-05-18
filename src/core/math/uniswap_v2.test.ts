import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { getV2AmountOut, getV2AmountIn, simulateV2Swap } from "./uniswap_v2.ts";

const bigUint40 = fc.bigInt({ min: 0n, max: 2n ** 40n - 1n });
const bigUint20 = fc.bigInt({ min: 0n, max: 2n ** 20n - 1n });

describe("getV2AmountOut", () => {
  it("computes correct output for standard fee", () => {
    const out = getV2AmountOut(1000n, 1000n, 1000n, 997n, 1000n);
    expect(out).toBe(499n);
  });
  it("returns 0 for zero amountIn", () => {
    expect(getV2AmountOut(0n, 1000n, 1000n, 997n, 1000n)).toBe(0n);
  });
  it("returns 0 for zero reserves", () => {
    expect(getV2AmountOut(1000n, 0n, 1000n, 997n, 1000n)).toBe(0n);
  });
  it("property: monotonic in amountIn", () => {
    fc.assert(fc.property(
      bigUint40.filter((n) => n > 0n),
      bigUint40.filter((n) => n > 0n),
      bigUint20.filter((n) => n > 0n),
      (reserveIn, reserveOut, baseAmountIn) => {
        const out1 = getV2AmountOut(baseAmountIn, reserveIn, reserveOut, 997n, 1000n);
        const out2 = getV2AmountOut(baseAmountIn * 2n, reserveIn, reserveOut, 997n, 1000n);
        expect(out2).toBeGreaterThanOrEqual(out1);
      },
    ));
  });
  it("property: output < reserveOut (cannot drain pool)", () => {
    fc.assert(fc.property(
      bigUint40.filter((n) => n > 0n),
      bigUint40.filter((n) => n > 0n),
      bigUint40.filter((n) => n > 0n),
      (amountIn, reserveIn, reserveOut) => {
        const out = getV2AmountOut(amountIn, reserveIn, reserveOut, 997n, 1000n);
        expect(out).toBeLessThan(reserveOut);
      },
    ));
  });
});

describe("simulateV2Swap", () => {
  it("returns amountOut and gasEstimate", () => {
    const state = { reserve0: 1000n, reserve1: 1000n, fee: 997n, feeDenominator: 1000n };
    const result = simulateV2Swap(state, 100n, true);
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.gasEstimate).toBeGreaterThan(0);
  });
});
