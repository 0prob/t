import { describe, it, expect } from "vitest";
import { simulateV3Swap, quoteV3 } from "./uniswap_v3.ts";
import { getSqrtRatioAtTick } from "./tick_math.ts";

function makePoolState() {
  return {
    initialized: true,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    tick: 0,
    liquidity: 1_000_000_000_000_000_000n,
    fee: 3000n,
    tickSpacing: 60,
    ticks: new Map([
      [-60, { liquidityGross: 1_000_000_000_000_000_000n, liquidityNet: 1_000_000_000_000_000_000n }],
      [60, { liquidityGross: 1_000_000_000_000_000_000n, liquidityNet: -1_000_000_000_000_000_000n }],
    ]),
  };
}

describe("simulateV3Swap", () => {
  it("returns zero output for empty liquidity", () => {
    const state = { initialized: true, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: 0n, fee: 3000n, tickSpacing: 60, ticks: new Map() };
    const result = simulateV3Swap(state, 1000n, true);
    expect(result.amountOut).toBe(0n);
  });
  it("simulates a swap with active liquidity", () => {
    const result = simulateV3Swap(makePoolState(), 1000n, true);
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.gasEstimate).toBeGreaterThan(0);
  });
});

describe("quoteV3", () => {
  it("returns same as simulateV3Swap.amountOut", () => {
    const sim = simulateV3Swap(makePoolState(), 1000n, true);
    const quote = quoteV3(makePoolState(), 1000n, true);
    expect(quote).toBe(sim.amountOut);
  });
});
