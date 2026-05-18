import { describe, it, expect } from "vitest";
import { revertRiskBps, slippageDeduction, revertPenalty, flashLoanFee } from "./risk.ts";
import { FlashLoanSource } from "../types/execution.ts";

describe("revertRiskBps", () => {
  it("returns base for 2-hop routes", () => {
    expect(revertRiskBps(2)).toBe(500n);
  });
  it("adds 200 bps per extra hop beyond 2", () => {
    expect(revertRiskBps(3)).toBe(700n);
    expect(revertRiskBps(4)).toBe(900n);
    expect(revertRiskBps(5)).toBe(1100n);
  });
  it("caps at 30%", () => {
    expect(revertRiskBps(100)).toBe(3000n);
  });
  it("returns base for zero or negative hops", () => {
    expect(revertRiskBps(0)).toBe(500n);
    expect(revertRiskBps(-1)).toBe(500n);
  });
});

describe("slippageDeduction", () => {
  it("computes basis points correctly", () => {
    expect(slippageDeduction(10_000n, 50n)).toBe(50n); // 0.5% of 10000
  });
  it("returns 0 for zero amount", () => {
    expect(slippageDeduction(0n, 50n)).toBe(0n);
  });
  it("returns 0 for zero bps", () => {
    expect(slippageDeduction(10_000n, 0n)).toBe(0n);
  });
});

describe("revertPenalty", () => {
  it("scales with hop count", () => {
    expect(revertPenalty(10_000n, 2)).toBe(500n);  // 5% of 10000
    expect(revertPenalty(10_000n, 3)).toBe(700n);  // 7% of 10000
  });
  it("returns 0 for zero profit", () => {
    expect(revertPenalty(0n, 3)).toBe(0n);
  });
  it("returns 0 for negative profit", () => {
    expect(revertPenalty(-100n, 3)).toBe(0n);
  });
});

describe("flashLoanFee", () => {
  it("returns 0 for Balancer (zero-fee on Polygon)", () => {
    expect(flashLoanFee(1_000_000n, FlashLoanSource.BALANCER)).toBe(0n);
  });
  it("returns 5 bps for Aave V3", () => {
    expect(flashLoanFee(1_000_000n, FlashLoanSource.AAVE_V3)).toBe(500n);
  });
  it("uses override bps when provided", () => {
    expect(flashLoanFee(1_000_000n, FlashLoanSource.BALANCER, 10n)).toBe(1_000n);
  });
});
