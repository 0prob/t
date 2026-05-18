import { describe, it, expect, vi } from "vitest";
import { selectFlashLoanSource, computeFlashLoanFee } from "./flash_loans.ts";
import { FlashLoanSource } from "../../core/types/execution.ts";

describe("selectFlashLoanSource", () => {
  it("prefers Balancer when liquidity available", async () => {
    const checkLiquidity = vi.fn(async (_token, _amount, source) => source === FlashLoanSource.BALANCER);
    const source = await selectFlashLoanSource("0xtoken", 1000n, checkLiquidity);
    expect(source).toBe(FlashLoanSource.BALANCER);
    expect(checkLiquidity).toHaveBeenCalledWith("0xtoken", 1000n, FlashLoanSource.BALANCER);
  });

  it("falls back to Aave V3 when Balancer unavailable", async () => {
    const checkLiquidity = vi.fn().mockResolvedValue(false);
    const source = await selectFlashLoanSource("0xtoken", 1000n, checkLiquidity);
    expect(source).toBe(FlashLoanSource.AAVE_V3);
  });
});

describe("computeFlashLoanFee", () => {
  it("Balancer fee is zero", () => {
    expect(computeFlashLoanFee(1_000_000n, FlashLoanSource.BALANCER)).toBe(0n);
  });

  it("Aave V3 fee is 0.05%", () => {
    const fee = computeFlashLoanFee(1_000_000n, FlashLoanSource.AAVE_V3);
    expect(fee).toBe(500n); // 0.05% of 1,000,000
  });
});
