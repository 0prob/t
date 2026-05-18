import { FlashLoanSource } from "../../core/types/execution.ts";

export interface FlashLoanQuote {
  source: FlashLoanSource;
  amount: bigint;
  fee: bigint;
  token: string;
}

export type LiquidityChecker = (token: string, amount: bigint, source: FlashLoanSource) => Promise<boolean>;

export async function selectFlashLoanSource(
  token: string,
  amount: bigint,
  checkLiquidity: LiquidityChecker,
): Promise<FlashLoanSource> {
  const balancerAvailable = await checkLiquidity(token, amount, FlashLoanSource.BALANCER);
  if (balancerAvailable) return FlashLoanSource.BALANCER;

  return FlashLoanSource.AAVE_V3;
}

export function computeFlashLoanFee(amount: bigint, source: FlashLoanSource): bigint {
  if (source === FlashLoanSource.BALANCER) return 0n;
  if (source === FlashLoanSource.AAVE_V3) return (amount * 5n) / 10_000n;
  return 0n;
}
