import { describe, it, expect } from "vitest";
import { getCurveAmountOut, simulateCurveSwap } from "./curve.ts";

const DEFAULT_RATES = [10n ** 18n, 10n ** 18n];

describe("getCurveAmountOut", () => {
  it("returns positive output for balanced 2-coin stable pool", () => {
    const state = { balances: [1_000_000_000_000n, 1_000_000_000_000n], rates: DEFAULT_RATES, A: 100n, fee: 4_000_000n };
    const out = getCurveAmountOut(1_000_000n, state, 0, 1);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(1_000_000n);
  });
  it("returns 0 for zero input", () => {
    const state = { balances: [1_000_000_000_000n, 1_000_000_000_000n], rates: DEFAULT_RATES, A: 100n, fee: 4_000_000n };
    const out = getCurveAmountOut(0n, state, 0, 1);
    expect(out).toBe(0n);
  });
});

describe("simulateCurveSwap", () => {
  it("returns simulation result with gas estimate", () => {
    const state = { balances: [1_000_000_000_000n, 1_000_000_000_000n], rates: DEFAULT_RATES, A: 100n, fee: 4_000_000n };
    const result = simulateCurveSwap(1_000_000n, state, 0, 1);
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.gasEstimate).toBeGreaterThan(0);
  });
});
