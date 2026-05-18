import { describe, it, expect } from "vitest";
import { getBalancerAmountOut, simulateBalancerSwap } from "./balancer.ts";

const ONE = 10n ** 18n;

describe("getBalancerAmountOut", () => {
  it("returns positive output for weighted pool", () => {
    const state = {
      balances: [1_000_000_000_000_000_000_000n, 250_000_000_000_000_000_000n],
      weights: [800_000_000_000_000_000n, 200_000_000_000_000_000n],
      swapFee: 10_000_000_000_000_000n,
    };
    const out = getBalancerAmountOut(10_000_000_000_000_000_000n, state, 0, 1);
    expect(out).toBeGreaterThan(0n);
  });
});

describe("simulateBalancerSwap", () => {
  it("dispatches to weighted pool math", () => {
    const state = {
      balances: [1_000_000_000_000_000_000_000n, 250_000_000_000_000_000_000n],
      weights: [800_000_000_000_000_000n, 200_000_000_000_000_000n],
      swapFee: 10_000_000_000_000_000n,
      poolType: "weighted" as const,
    };
    const result = simulateBalancerSwap(10_000_000_000_000_000_000n, state, 0, 1);
    expect(result.amountOut).toBeGreaterThan(0n);
  });
});
