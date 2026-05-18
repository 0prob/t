import { describe, it, expect } from "vitest";
import { optimizeInputAmount } from "./optimizer.ts";
import type { RouteSimulationResult } from "../types/route.ts";

function mkResult(amountIn: bigint, profit: bigint): RouteSimulationResult {
  return {
    amountIn, amountOut: amountIn + profit, profit, profitable: profit > 0n,
    hopAmounts: [], totalGas: 0, poolPath: [], tokenPath: [], protocols: [], hopCount: 0,
  };
}

describe("optimizeInputAmount", () => {
  it("finds the peak of a unimodal profit function", () => {
    // Profit function: -(amountIn - 1000)^2 / 10 (peak at 1000)
    const simulate = (amountIn: bigint) => {
      const diff = amountIn - 1000n;
      const profit = 1_000_000n - (diff * diff) / 10n;
      return mkResult(amountIn, profit);
    };
    const result = optimizeInputAmount(simulate, { minAmount: 1n, maxAmount: 10_000n, iterations: 64 });
    // Should land within ~10 of 1000
    expect(result.amountIn).toBeGreaterThan(900n);
    expect(result.amountIn).toBeLessThan(1100n);
  });

  it("returns the only point when minAmount == maxAmount", () => {
    const simulate = (amountIn: bigint) => mkResult(amountIn, 100n);
    const result = optimizeInputAmount(simulate, { minAmount: 500n, maxAmount: 500n });
    expect(result.amountIn).toBe(500n);
  });

  it("respects accept predicate", () => {
    // Only accept amounts >= 100. Optimal should be at 100 even if profit function peaks at 50.
    const simulate = (amountIn: bigint) => {
      const diff = amountIn - 50n;
      const profit = 1_000n - (diff * diff);
      return mkResult(amountIn, profit);
    };
    const result = optimizeInputAmount(simulate, {
      minAmount: 1n, maxAmount: 1_000n, iterations: 64,
      accept: (r) => r.amountIn >= 100n,
    });
    expect(result.amountIn).toBeGreaterThanOrEqual(100n);
  });

  it("uses custom scorer", () => {
    // Profit ignored; scorer is amountOut directly
    const simulate = (amountIn: bigint) => mkResult(amountIn, amountIn * 2n);
    const result = optimizeInputAmount(simulate, {
      minAmount: 1n, maxAmount: 1_000n, iterations: 32,
      scorer: (r) => r.amountOut,
    });
    // amountOut is monotonically increasing -> optimum is near max
    expect(result.amountIn).toBeGreaterThan(800n);
  });
});
