import { FlashLoanSource } from "../types/execution.ts";

export const BPS_DENOM = 10_000n;

/** Revert risk in basis points, scaling with hop count. */
export function revertRiskBps(hopCount: number, baseBps: bigint = 500n): bigint {
  if (hopCount <= 0) return baseBps;
  const extraHops = BigInt(Math.max(0, hopCount - 2));
  const scaled = baseBps + extraHops * 200n;
  const cap = 3_000n; // 30%
  return scaled > cap ? cap : scaled;
}

/** Compute slippage deduction in same units as amount. */
export function slippageDeduction(amount: bigint, slippageBps: bigint): bigint {
  if (amount <= 0n || slippageBps <= 0n) return 0n;
  return (amount * slippageBps) / BPS_DENOM;
}

/** Compute revert penalty in same units as profit. */
export function revertPenalty(profit: bigint, hopCount: number, baseRiskBps: bigint = 500n): bigint {
  if (profit <= 0n) return 0n;
  return (profit * revertRiskBps(hopCount, baseRiskBps)) / BPS_DENOM;
}

/** Compute flash loan fee in same units as amount, dispatched by source. */
export function flashLoanFee(amount: bigint, source: FlashLoanSource, overrideBps?: bigint): bigint {
  if (amount <= 0n) return 0n;
  let bps: bigint;
  if (overrideBps != null) {
    bps = overrideBps;
  } else if (source === FlashLoanSource.BALANCER) {
    bps = 0n; // Balancer V2 on Polygon is zero-fee
  } else if (source === FlashLoanSource.AAVE_V3) {
    bps = 5n; // Aave V3 on Polygon charges 0.05%
  } else {
    bps = 0n;
  }
  return (amount * bps) / BPS_DENOM;
}
