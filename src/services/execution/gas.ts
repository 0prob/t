import type { Address } from "../../core/types/common.ts";

export interface FeeSnapshot {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  gasPrice: bigint;
  timestamp: number;
}

export interface GasOracleConfig {
  pollIntervalMs: number;
  priorityFeeFloorGwei: number;
  priorityFeeCeilingGwei: number;
  maxBidMultiplier: number;
}

export const DEFAULT_GAS_CONFIG: GasOracleConfig = {
  pollIntervalMs: 2_000,
  priorityFeeFloorGwei: 30,
  priorityFeeCeilingGwei: 500,
  maxBidMultiplier: 5,
};

export class GasOracle {
  private current: FeeSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: GasOracleConfig = DEFAULT_GAS_CONFIG,
    private fetchGas: () => Promise<{ baseFee: bigint; priorityFee: bigint }>,
  ) {}

  getSnapshot(): FeeSnapshot | null {
    return this.current;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const { baseFee, priorityFee } = await this.fetchGas();
      const clampedPriority = clampPriorityFee(priorityFee, this.config);
      const maxFee = baseFee * 2n + clampedPriority;
      this.current = {
        baseFee, priorityFee: clampedPriority, maxFee, gasPrice: baseFee + clampedPriority,
        timestamp: Date.now(),
      };
    } catch {
      // Keep last known values on fetch failure
    }
  }
}

function clampPriorityFee(priorityFee: bigint, config: GasOracleConfig): bigint {
  const floor = BigInt(config.priorityFeeFloorGwei) * 1_000_000_000n;
  const ceiling = BigInt(config.priorityFeeCeilingGwei) * 1_000_000_000n;
  if (priorityFee < floor) return floor;
  if (priorityFee > ceiling) return ceiling;
  return priorityFee;
}

export function scalePriorityFeeByProfitMargin(
  priorityFee: bigint,
  profitMarginBps: bigint,
  maxMultiplier: number,
): bigint {
  const multiplier = Math.max(1, Math.min(maxMultiplier, Number(profitMarginBps) / 100));
  return priorityFee * BigInt(multiplier);
}
