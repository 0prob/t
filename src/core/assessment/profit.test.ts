import { describe, it, expect } from "vitest";
import { computeProfit, tokensToMaticWei, maticWeiToTokens, gasCostMaticWei } from "./profit.ts";
import { FlashLoanSource } from "../types/execution.ts";

describe("tokensToMaticWei", () => {
  it("converts 1 USDC (6 decimals) at 0.5 MATIC/USDC", () => {
    // 1 USDC = 1e6 smallest units. Rate = 0.5e18 wei per USDC / 1e6 smallest units = 5e11 wei per unit.
    // 1e6 units * 5e11 wei/unit = 5e17 wei = 0.5 MATIC. Correct.
    const ONE_USDC = 1_000_000n;
    const rate = 500_000_000_000n; // 5e11
    expect(tokensToMaticWei(ONE_USDC, rate)).toBe(500_000_000_000_000_000n); // 0.5e18
  });
  it("returns 0 for zero amount", () => {
    expect(tokensToMaticWei(0n, 1_000_000n)).toBe(0n);
  });
  it("throws for zero rate", () => {
    expect(() => tokensToMaticWei(100n, 0n)).toThrow();
  });
});

describe("maticWeiToTokens", () => {
  it("rounds up conservatively", () => {
    // 1 wei at rate 10 wei/unit = 0.1 units -> rounds up to 1
    expect(maticWeiToTokens(1n, 10n)).toBe(1n);
  });
  it("exact division returns exact value", () => {
    expect(maticWeiToTokens(100n, 10n)).toBe(10n);
  });
});

describe("gasCostMaticWei", () => {
  it("multiplies gas units by gas price", () => {
    expect(gasCostMaticWei(500_000, 30_000_000_000n)).toBe(15_000_000_000_000_000n); // 0.015 MATIC
  });
  it("throws for non-integer gas units", () => {
    expect(() => gasCostMaticWei(1.5, 1n)).toThrow();
  });
});

describe("computeProfit - canonical MATIC wei comparison", () => {
  const baseOpts = {
    grossProfitInTokens: 10_000_000n, // 10 USDC (6 decimals)
    amountInTokens: 1_000_000_000n,   // 1000 USDC
    gasUnits: 300_000,
    gasPriceWei: 50_000_000_000n,     // 50 gwei
    tokenToMaticRate: 500_000_000_000n, // 0.5 MATIC/USDC
    hopCount: 3,
    minProfitMaticWei: 1_000_000_000_000_000n, // 0.001 MATIC
    slippageBps: 50n,
    revertRiskBps: 500n,
    flashLoanSource: FlashLoanSource.BALANCER,
  };

  it("computes profitable assessment correctly", () => {
    const result = computeProfit(baseOpts);
    expect(result.grossProfit).toBe(10_000_000n);
    expect(result.gasCostWei).toBe(15_000_000_000_000_000n); // 0.015 MATIC = 300k * 50 gwei
    expect(result.flashLoanFee).toBe(0n); // Balancer
    expect(result.slippageDeduction).toBe(50_000n); // 0.5% of 10M
    expect(result.revertPenalty).toBe(700_000n); // 7% of 10M (3-hop)
  });

  it("REGRESSION: rejects when net profit < minProfit (in MATIC wei)", () => {
    // Set gas extremely high so gas cost exceeds gross profit value in MATIC
    const result = computeProfit({
      ...baseOpts,
      gasUnits: 10_000_000, // 10M gas at 50 gwei = 0.5 MATIC
      grossProfitInTokens: 1_000n, // tiny gross profit
    });
    expect(result.shouldExecute).toBe(false);
    expect(result.rejectReason).toMatch(/unprofitable|below minProfit/);
  });

  it("REGRESSION: gas unit fix - rejects when start token is cheaper than MATIC", () => {
    // Token worth 0.001 MATIC/token. Gross profit 10 tokens looks "large" in token units
    // but is actually tiny in MATIC. Gas cost in MATIC must be deducted in MATIC.
    // Bug (old behavior): compares gasCostMaticWei to minProfit in token units => false acceptance.
    // Fix (new behavior): compares everything in MATIC wei.
    const result = computeProfit({
      ...baseOpts,
      tokenToMaticRate: 1_000_000n, // 1 token = 1e-6 MATIC (very cheap token, 6 decimals)
      grossProfitInTokens: 1_000_000_000n,   // 1000 tokens = 0.001 MATIC value
      gasUnits: 300_000,                     // 0.015 MATIC gas cost
      minProfitMaticWei: 1_000_000_000_000_000n, // 0.001 MATIC minimum
    });
    // Gross in MATIC = 1000 * 1e-6 = 0.001 MATIC. After 5% revert + 0.5% slippage = ~0.000945 MATIC.
    // After gas: 0.000945 - 0.015 = NEGATIVE. Should reject.
    expect(result.shouldExecute).toBe(false);
    expect(result.netProfitAfterGas).toBeLessThanOrEqual(0n);
  });

  it("REGRESSION: gas unit fix - accepts when start token is expensive (high MATIC value)", () => {
    // Token worth 100 MATIC/token. Gross profit 1 token unit (smallest) = many MATIC.
    const result = computeProfit({
      ...baseOpts,
      tokenToMaticRate: 100_000_000_000_000_000_000n, // 1 unit = 100 MATIC (huge)
      grossProfitInTokens: 1_000n, // 1000 units * 100 MATIC = 100,000 MATIC value
      gasUnits: 300_000,
      minProfitMaticWei: 1_000_000_000_000_000n,
    });
    // Massive profit in MATIC terms. Should accept easily.
    expect(result.shouldExecute).toBe(true);
  });

  it("rejects when oracle is cold (rate = 0)", () => {
    const result = computeProfit({ ...baseOpts, tokenToMaticRate: 0n });
    expect(result.shouldExecute).toBe(false);
    expect(result.rejectReason).toMatch(/oracle/i);
  });

  it("computes flash loan fee for Aave V3 (5 bps)", () => {
    const result = computeProfit({
      ...baseOpts,
      flashLoanSource: FlashLoanSource.AAVE_V3,
    });
    // 5 bps of 1B = 500_000
    expect(result.flashLoanFee).toBe(500_000n);
  });

  it("applies hop-scaled revert risk", () => {
    const r2 = computeProfit({ ...baseOpts, hopCount: 2 });
    const r4 = computeProfit({ ...baseOpts, hopCount: 4 });
    // 2-hop: 5% revert penalty; 4-hop: 9% revert penalty
    expect(r4.revertPenalty).toBeGreaterThan(r2.revertPenalty);
  });

  it("computes ROI in micro-units", () => {
    const result = computeProfit(baseOpts);
    // ROI = netProfitAfterGas / amountIn * 1e6
    // Should be a finite number
    expect(typeof result.roi).toBe("number");
    expect(Number.isFinite(result.roi)).toBe(true);
  });
});
