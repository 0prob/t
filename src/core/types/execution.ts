import type { Address, FeeSnapshot } from "./common.ts";
import type { ArbPath, RouteSimulationResult, RouteIdentityEdge } from "./route.ts";

export enum FlashLoanSource {
  BALANCER = "BALANCER",
  AAVE_V3 = "AAVE_V3",
}

export interface ProfitAssessment {
  shouldExecute: boolean;
  grossProfit: bigint;
  gasCostWei: bigint;
  gasCostInTokens: bigint;
  flashLoanFee: bigint;
  slippageDeduction: bigint;
  revertPenalty: bigint;
  netProfit: bigint;
  netProfitAfterGas: bigint;
  roi: number;
  rejectReason?: string;
}

export interface CandidateEntry {
  path: ArbPath;
  result: RouteSimulationResult;
  assessment?: ProfitAssessment;
}

export interface ExecutableCandidate extends CandidateEntry {
  assessment: ProfitAssessment & { shouldExecute: true };
}

export interface TransactionParams {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  nonce: number;
  chainId: number;
}

export interface DryRunResult {
  success: boolean;
  gasUsed?: bigint;
  revertReason?: string;
  error?: string;
}

export interface SubmissionResult {
  success: boolean;
  txHash?: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  blockNumber?: number;
  profit?: bigint;
  error?: string;
  endpoint?: string;
}

export type ExecutionOutcome =
  | { type: "success"; txHash: string; profit: bigint; gasUsed: bigint }
  | { type: "revert"; txHash: string; reason: string; gasUsed: bigint }
  | { type: "dryrun_fail"; reason: string }
  | { type: "submit_fail"; error: string }
  | { type: "quarantined"; routeKey: string; reason: string };

export interface CandidatePipelineResult {
  evaluated: number;
  shortlisted: number;
  optimized: number;
  profitable: number;
  candidates: ExecutableCandidate[];
}
