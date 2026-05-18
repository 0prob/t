import { mulDiv, divRoundingUp } from "../math/full_math.ts";
import { bigintToApproxNumber } from "../utils/bigint.ts";
import { revertPenalty, slippageDeduction, flashLoanFee, BPS_DENOM } from "./risk.ts";
import { FlashLoanSource } from "../types/execution.ts";
import type { ProfitAssessment } from "../types/execution.ts";

/**
 * Convert a token-denominated amount to MATIC wei using an oracle rate.
 *
 * `tokenToMaticRate` is the number of MATIC wei equivalent to 1 unit (smallest denomination)
 * of the token. E.g. if token has 6 decimals and the price is 0.5 MATIC/token, then
 * tokenToMaticRate = 0.5 * 10^18 / 10^6 = 5 * 10^11 wei per smallest token unit.
 */
export function tokensToMaticWei(amountInTokens: bigint, tokenToMaticRate: bigint): bigint {
  if (amountInTokens <= 0n) return 0n;
  if (tokenToMaticRate <= 0n) throw new Error("tokenToMaticRate must be > 0");
  return mulDiv(amountInTokens, tokenToMaticRate, 1n);
}

/**
 * Convert MATIC wei to token units using an oracle rate, rounding up (conservative).
 * Used to express MATIC-denominated costs (e.g. gas) in token units when needed.
 */
export function maticWeiToTokens(amountInMaticWei: bigint, tokenToMaticRate: bigint): bigint {
  if (amountInMaticWei <= 0n) return 0n;
  if (tokenToMaticRate <= 0n) throw new Error("tokenToMaticRate must be > 0");
  return divRoundingUp(amountInMaticWei, tokenToMaticRate);
}

/** Compute gas cost in MATIC wei from gas units and gas price. */
export function gasCostMaticWei(gasUnits: number, gasPriceWei: bigint): bigint {
  if (!Number.isSafeInteger(gasUnits) || gasUnits < 0)
    throw new Error("gasUnits must be a finite non-negative safe integer");
  if (gasPriceWei < 0n) throw new Error("gasPriceWei must be >= 0");
  return BigInt(gasUnits) * gasPriceWei;
}

/** ROI in micro-units (parts per million) of profit / amountIn. */
export function roiMicroUnits(profit: bigint, amountIn: bigint): number {
  if (amountIn <= 0n) return 0;
  return bigintToApproxNumber((profit * 1_000_000n) / amountIn);
}

/**
 * Options for profit computation. All financial values are in source-defined units;
 * conversions to MATIC wei happen internally via tokenToMaticRate.
 */
export interface ComputeProfitOptions {
  /** Gross profit in start-token units (amountOut - amountIn) */
  grossProfitInTokens: bigint;
  /** Input amount in start-token units */
  amountInTokens: bigint;
  /** Gas units estimated for the route */
  gasUnits: number;
  /** Current gas price in wei (MATIC) */
  gasPriceWei: bigint;
  /** Rate: 1 token unit = N MATIC wei. Must be > 0. */
  tokenToMaticRate: bigint;
  /** Hop count for revert risk calculation */
  hopCount: number;
  /** Minimum acceptable net profit, in MATIC wei */
  minProfitMaticWei: bigint;
  /** Slippage in basis points (applied to gross profit) */
  slippageBps?: bigint;
  /** Base revert risk in basis points */
  revertRiskBps?: bigint;
  /** Flash loan source for fee calculation */
  flashLoanSource?: FlashLoanSource;
  /** Override flash loan fee bps */
  flashLoanFeeBps?: bigint;
}

/**
 * Compute profit assessment with CORRECT unit handling.
 *
 * The previous implementation (src/arb/profit_compute.ts) compared `gasCost` in MATIC wei
 * against `minNetProfit` in start-token units, producing wrong accept/reject decisions
 * whenever the start token had a different price than MATIC.
 *
 * This implementation converts everything to MATIC wei (the canonical chain unit)
 * before any comparison. Returns assessment with both MATIC-wei and token-unit values
 * for diagnostic purposes.
 */
export function computeProfit(opts: ComputeProfitOptions): ProfitAssessment {
  const {
    grossProfitInTokens,
    amountInTokens,
    gasUnits,
    gasPriceWei,
    tokenToMaticRate,
    hopCount,
    minProfitMaticWei,
    slippageBps = 50n,
    revertRiskBps: baseRiskBps = 500n,
    flashLoanSource = FlashLoanSource.BALANCER,
    flashLoanFeeBps,
  } = opts;

  if (tokenToMaticRate <= 0n) {
    return invalidAssessment(grossProfitInTokens, "tokenToMaticRate must be > 0 (oracle cold?)");
  }

  // Compute deductions in token units (consistent with grossProfit)
  const slippage = slippageDeduction(grossProfitInTokens, slippageBps);
  const revert = revertPenalty(grossProfitInTokens, hopCount, baseRiskBps);
  const flashFee = flashLoanFee(amountInTokens, flashLoanSource, flashLoanFeeBps);

  // Net profit in token units, before gas
  const netProfitInTokens = grossProfitInTokens - slippage - revert - flashFee;

  // Gas cost in MATIC wei (the native chain unit)
  const gasCostWei = gasCostMaticWei(gasUnits, gasPriceWei);

  // Convert net profit (in tokens) to MATIC wei using oracle rate
  const netProfitMaticWei = tokensToMaticWei(netProfitInTokens > 0n ? netProfitInTokens : 0n, tokenToMaticRate);

  // Net profit after gas, in MATIC wei -- THIS is the canonical profitability metric
  const netProfitAfterGasMaticWei = netProfitMaticWei - gasCostWei;

  // For backward compatibility with consumers expecting token-unit values
  const gasCostInTokens = maticWeiToTokens(gasCostWei, tokenToMaticRate);
  const netProfitAfterGasInTokens = netProfitInTokens - gasCostInTokens;

  const shouldExecute = netProfitAfterGasMaticWei >= minProfitMaticWei;
  const roi = roiMicroUnits(netProfitAfterGasInTokens, amountInTokens);

  const result: ProfitAssessment = {
    shouldExecute,
    grossProfit: grossProfitInTokens,
    gasCostWei,
    gasCostInTokens,
    flashLoanFee: flashFee,
    slippageDeduction: slippage,
    revertPenalty: revert,
    netProfit: netProfitInTokens,
    netProfitAfterGas: netProfitAfterGasInTokens,
    roi,
  };

  if (!shouldExecute) {
    if (netProfitAfterGasMaticWei < 0n) {
      result.rejectReason = `unprofitable after gas: ${netProfitAfterGasMaticWei} wei`;
    } else {
      result.rejectReason = `below minProfit: ${netProfitAfterGasMaticWei} < ${minProfitMaticWei}`;
    }
  }

  return result;
}

function invalidAssessment(grossProfit: bigint, reason: string): ProfitAssessment {
  return {
    shouldExecute: false,
    grossProfit,
    gasCostWei: 0n,
    gasCostInTokens: 0n,
    flashLoanFee: 0n,
    slippageDeduction: 0n,
    revertPenalty: 0n,
    netProfit: 0n,
    netProfitAfterGas: 0n,
    roi: 0,
    rejectReason: reason,
  };
}
