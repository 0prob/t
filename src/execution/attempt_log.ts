import { logger } from "../utils/logger.ts";
import type { BuiltTx } from "./build_tx.ts";

const attemptLogger = logger.child({ component: "attempt_log" });

export type AttemptStage =
  | "dry_run_start"
  | "dry_run_result"
  | "sign_start"
  | "sign_result"
  | "submit_start"
  | "submit_endpoint_result"
  | "submit_result"
  | "fallback_start"
  | "fallback_attempt"
  | "receipt_wait_start"
  | "receipt_result"
  | "final";

export type AttemptOutcome =
  | "dry_run_failed"
  | "sign_failed"
  | "submitted"
  | "submission_failed"
  | "confirmed"
  | "reverted"
  | "receipt_timeout"
  | "dropped"
  | "skipped";

export type AttemptEndpointResult = {
  endpoint: string;
  latencyMs: number;
  error?: string;
  hash?: string;
};

export type AttemptLogEntry = {
  attemptId: string;
  stage: AttemptStage;
  outcome?: AttemptOutcome;
  txHash?: string;
  nonce?: number;
  endpoint?: string;
  latencyMs?: number;
  error?: string;
  errorCategory?: string;
  endpointResults?: AttemptEndpointResult[];
  gasLimit?: string;
  gasPrice?: string;
  profitWei?: string;
  routeSummary?: string;
  meta?: Record<string, unknown>;
};

let attemptIdCounter = 0;

// ─── Persistent sink ──────────────────────────────────────────
// Optional write-through to a durable store (e.g. TxAttemptStore).
// Registered once at startup; never throws back into the hot path.
let _attemptLogSink: ((entry: AttemptLogEntry) => void) | null = null;

/**
 * Register a durable sink that receives every AttemptLogEntry written by
 * logAttemptStage().  Call once at startup, e.g.:
 *
 *   import { TxAttemptStore } from "./tx_attempt_store.ts";
 *   import { setAttemptLogSink } from "./attempt_log.ts";
 *   const store = new TxAttemptStore(DB_PATH);
 *   setAttemptLogSink(store.write.bind(store));
 */
export function setAttemptLogSink(sink: ((entry: AttemptLogEntry) => void) | null): void {
  _attemptLogSink = sink;
}

export function nextAttemptId(prefix = "tx"): string {
  return `${prefix}_${++attemptIdCounter}_${Date.now()}`;
}

function redactPrivateKey(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const copy = { ...meta };
  if (copy.privateKey) copy.privateKey = "***";
  return copy;
}

export function logAttemptStage(entry: AttemptLogEntry): void {
  const { stage, outcome } = entry;
  if (outcome && (outcome === "dry_run_failed" || outcome === "sign_failed" || outcome === "submission_failed" || outcome === "reverted" || outcome === "receipt_timeout" || outcome === "dropped")) {
    attemptLogger.error({ ...entry, meta: redactPrivateKey(entry.meta) }, `attempt ${stage}: ${outcome}`);
  } else if (outcome === "confirmed") {
    attemptLogger.info({ ...entry, meta: redactPrivateKey(entry.meta) }, `attempt ${stage}: ${outcome}`);
  } else if (stage === "submit_endpoint_result" && entry.error) {
    attemptLogger.warn({ ...entry, meta: redactPrivateKey(entry.meta) }, `attempt ${stage}: endpoint failed`);
  } else if (stage === "submit_endpoint_result") {
    attemptLogger.debug({ ...entry, meta: redactPrivateKey(entry.meta) }, `attempt ${stage}: endpoint success`);
  } else {
    attemptLogger.info({ ...entry, meta: redactPrivateKey(entry.meta) }, `attempt ${stage}${outcome ? `: ${outcome}` : ""}`);
  }

  // Write to durable sink (non-blocking, swallows errors so logging never stalls execution)
  if (_attemptLogSink) {
    try {
      _attemptLogSink(entry);
    } catch {
      // Sink errors must never surface into the hot execution path
    }
  }
}

export function stageFromBuiltTx(attemptId: string, builtTx: BuiltTx, txHash?: string, nonce?: number): AttemptLogEntry {
  const meta = builtTx.meta ?? {};
  return {
    attemptId,
    stage: "final",
    txHash,
    nonce,
    profitWei: String(meta.expectedProfit ?? ""),
    gasLimit: String(builtTx.gasLimit ?? ""),
    gasPrice: builtTx.effectiveGasPriceWei ? String(builtTx.effectiveGasPriceWei) : undefined,
    routeSummary: [
      meta.protocol ? (meta.protocol as string[]).join("->") : "",
      meta.pools ? (meta.pools as string[]).slice(0, 2).map(String).join(",") : "",
    ].filter(Boolean).join(" "),
    meta,
  };
}
