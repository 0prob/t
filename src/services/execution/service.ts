import type { Logger } from "../../infra/observability/logger.ts";
import type { GasOracle, FeeSnapshot } from "./gas.ts";
import type { NonceManager } from "./nonce.ts";

export interface CandidateExecution {
  routeKey: string;
  calldata: string;
  targetAddress: string;
  value: bigint;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: bigint;
}

export class ExecutionService {
  private running = false;
  private quarantine = new Set<string>();

  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private nonceManager: NonceManager,
    private submitTx: (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }) => Promise<string>,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.gasOracle.start();
    await this.nonceManager.initialize();
    this.logger.info({}, "ExecutionService started");
  }

  stop(): void {
    this.running = false;
    this.gasOracle.stop();
    this.logger.info({}, "ExecutionService stopped");
  }

  async execute(candidate: CandidateExecution): Promise<ExecutionResult> {
    if (this.quarantine.has(candidate.routeKey)) {
      return { success: false, error: "route quarantined" };
    }

    try {
      const fee = this.gasOracle.getSnapshot();
      if (!fee) return { success: false, error: "no gas data" };

      const nonce = this.nonceManager.getNextNonce();
      const txHash = await this.submitTx({
        to: candidate.targetAddress,
        data: candidate.calldata,
        value: candidate.value,
        nonce,
        maxFee: fee.maxFee,
      });

      this.logger.info({ txHash, routeKey: candidate.routeKey }, "Transaction submitted");
      return { success: true, txHash };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.quarantine.add(candidate.routeKey);
      return { success: false, error: msg };
    }
  }

  isQuarantined(routeKey: string): boolean {
    return this.quarantine.has(routeKey);
  }
}
