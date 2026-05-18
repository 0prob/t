import type { BuiltTransaction } from "./builder.ts";
import { logAttempt } from "./attempt_log.ts";

export interface SubmissionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  method?: string;
}

export interface SubmitterConfig {
  privateRpcUrl?: string;
  alchemyRpcUrl?: string;
  publicRpcUrls?: string[];
  timeoutMs?: number;
}

export interface Submitter {
  submit(tx: BuiltTransaction, signedRawTx: string): Promise<SubmissionResult>;
}

class PrivateRelaySubmitter {
  constructor(private rpcUrl: string) {}

  async submit(signedRawTx: string, timeoutMs: number): Promise<SubmissionResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendRawTransaction",
          params: [signedRawTx],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = await res.json() as { result?: string; error?: { message?: string } };
      if (body.error) return { success: false, error: body.error.message };
      return { success: true, txHash: body.result, method: `private_relay:${new URL(this.rpcUrl).hostname}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class AlchemyPrivateTxSubmitter {
  constructor(private rpcUrl: string) {}

  async submit(signedRawTx: string, timeoutMs: number): Promise<SubmissionResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendPrivateTransaction",
          params: [{ tx: signedRawTx }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = await res.json() as { result?: string; error?: { message?: string } };
      if (body.error) return { success: false, error: body.error.message };
      return { success: true, txHash: body.result, method: "alchemy_private_tx" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class PublicSubmitter {
  constructor(private rpcUrls: string[]) {}

  async submit(signedRawTx: string, timeoutMs: number): Promise<SubmissionResult> {
    const submissions = this.rpcUrls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_sendRawTransaction",
            params: [signedRawTx],
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = await res.json() as { result?: string; error?: { message?: string } };
        if (body.error) throw new Error(body.error.message);
        const hostname = new URL(url).hostname;
        return { success: true, txHash: body.result, method: `public:${hostname}` } as SubmissionResult;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err), method: `public:${new URL(url).hostname}` };
      }
    });
    const results = await Promise.allSettled(submissions);
    const firstSuccess = results.find((r) => r.status === "fulfilled" && r.value.success);
    if (firstSuccess && firstSuccess.status === "fulfilled") return firstSuccess.value;
    const errors = results
      .filter((r): r is PromiseFulfilledResult<SubmissionResult> => r.status === "fulfilled")
      .map((r) => r.value.error)
      .filter(Boolean);
    return { success: false, error: `all public RPCs failed: ${errors.join("; ")}` };
  }
}

export function createSubmitter(config: SubmitterConfig): Submitter {
  const privateRelay = config.privateRpcUrl ? new PrivateRelaySubmitter(config.privateRpcUrl) : null;
  const alchemySubmitter = config.alchemyRpcUrl ? new AlchemyPrivateTxSubmitter(config.alchemyRpcUrl) : null;
  const publicSubmitter = (config.publicRpcUrls?.length ?? 0) > 0 ? new PublicSubmitter(config.publicRpcUrls ?? []) : null;

  return {
    async submit(tx: BuiltTransaction, signedRawTx: string): Promise<SubmissionResult> {
      const timeoutMs = config.timeoutMs ?? 10_000;
      const submissions: Array<Promise<SubmissionResult>> = [];

      // Race private relay with Alchemy private tx, then fall back to public
      if (privateRelay) submissions.push(privateRelay.submit(signedRawTx, timeoutMs));
      if (alchemySubmitter) submissions.push(alchemySubmitter.submit(signedRawTx, timeoutMs));

      let result: SubmissionResult | null = null;

      if (submissions.length > 0) {
        try {
          result = await Promise.any(submissions);
        } catch {
          // All private submissions failed
        }
      }

      if (!result || !result.success) {
        if (publicSubmitter) {
          result = await publicSubmitter.submit(signedRawTx, timeoutMs);
        } else {
          result = { success: false, error: result?.error ?? "no submission methods configured" };
        }
      }

      logAttempt({
        timestamp: Date.now(),
        routeKey: tx.routeHash,
        profit: BigInt((tx.meta.expectedProfit as string) ?? "0"),
        gasCost: 0n,
        success: result.success,
        error: result.error,
      });

      return result;
    },
  };
}
