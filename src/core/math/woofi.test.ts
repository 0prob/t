import { describe, it, expect } from "vitest";
import { simulateWoofiSwap } from "./woofi.ts";

describe("simulateWoofiSwap", () => {
  it("returns simulation result", () => {
    const baseAddress = "0x" + "11".repeat(20);
    const quoteAddress = "0x" + "22".repeat(20);
    const state = {
      tokens: [baseAddress, quoteAddress],
      quoteToken: quoteAddress,
      quoteReserve: 1_000_000_000n,
      quoteFeeRate: 0n,
      quoteDec: 1_000_000n,
      fee: 25n,
      feeDenominator: 100_000n,
      balances: [1_000_000_000n],
      baseTokenStates: {
        [baseAddress]: { price: 1_000_000_000n, spread: 0n, coeff: 0n, reserve: 1_000_000_000_000_000_000n, dec: 1_000_000_000_000_000_000n, feeRate: 0n },
      },
    };
    const result = simulateWoofiSwap(1_000_000n, state, 0, 1);
    expect(result.gasEstimate).toBeGreaterThan(0);
  });
});
