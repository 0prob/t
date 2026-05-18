import { withRetry } from "../../infra/rpc/retry.ts";

export type NonceFetcher = (address: string) => Promise<number>;

export class NonceManager {
  private localNonce: number | null = null;
  private pendingCount = 0;

  constructor(
    private address: string,
    private fetchNonce: NonceFetcher,
  ) {}

  async initialize(): Promise<void> {
    this.localNonce = await withRetry(() => this.fetchNonce(this.address), { maxAttempts: 3 });
    this.pendingCount = 0;
  }

  getNextNonce(): number {
    if (this.localNonce == null) throw new Error("NonceManager not initialized");
    const nonce = this.localNonce + this.pendingCount;
    this.pendingCount++;
    return nonce;
  }

  async confirmNonce(confirmedNonce: number): Promise<void> {
    if (this.localNonce != null && confirmedNonce >= this.localNonce) {
      const confirmed = confirmedNonce - this.localNonce + 1;
      this.localNonce = confirmedNonce + 1;
      this.pendingCount = Math.max(0, this.pendingCount - confirmed);
    }
  }

  async resync(): Promise<void> {
    this.localNonce = await withRetry(() => this.fetchNonce(this.address), { maxAttempts: 3 });
    this.pendingCount = 0;
  }

  get expectedNextNonce(): number | null {
    return this.localNonce != null ? this.localNonce + this.pendingCount : null;
  }
}
