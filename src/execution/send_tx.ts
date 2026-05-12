
/**
 * src/execution/send_tx.js — Transaction signer and submitter
 *
 * Optimized for HFT:
 *   - Reuses the shared, persistent PublicClient from gas.js.
 *   - Eliminates redundant client creation overhead.
 */

import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executionClient } from "./gas.ts";
import { signTransaction, sendPrivateBundle, sendPrivateTx, type RawTransaction, type SubmissionResult } from "./private_tx.ts";
import type { BuiltTx } from "./build_tx.ts";
import { logger } from "../utils/logger.ts";
import { updateGasEstimateMultiplier } from "./gas_adjustment.ts";
import { txLatency } from "../utils/metrics.ts";
import { TransactionSniper, createSniperFromConfig } from "./tx_sniper.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";
import {
  nextAttemptId,
  logAttemptStage,
  stageFromBuiltTx,
  type AttemptLogEntry,
  type AttemptEndpointResult,
} from "./attempt_log.ts";

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;
const MIN_RECEIPT_TIMEOUT_MS = 15_000;
const MAX_RECEIPT_TIMEOUT_MS = 60_000;
const DEFAULT_DRY_RUN = true;
const MAX_SUBMISSION_RETRIES = 3;
const RECEIPT_POLL_INTERVAL_MS = 5_000;
const RECEIPT_DROP_AFTER_MS = 45_000;
const RECEIPT_MISS_THRESHOLD = 3;

// Adaptive profit thresholds for receipt timeout scaling
const PROFIT_TINY_WEI = BigInt("50000000000000");    // 0.00005 MATIC — tight timeout
const PROFIT_SMALL_WEI = BigInt("500000000000000");   // 0.0005 MATIC — moderate timeout
const PROFIT_MEDIUM_WEI = BigInt("5000000000000000"); // 0.005 MATIC — generous timeout

/**
 * Compute a profit-weighted receipt timeout.
 * Tiny profits get a short timeout (capital recovery); large profits are worth the wait.
 */
function parseUnsignedBigInt(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

export function expectedProfitWei(builtTx: BuiltTx) {
  const meta = builtTx.meta ?? {};
  const explicitWei = parseUnsignedBigInt(
    meta.expectedProfitWei ?? meta.expectedProfitMaticWei ?? meta.expectedProfitNativeWei,
  );
  if (explicitWei != null) return explicitWei;

  // Backward compatibility for older BuiltTx objects: expectedProfit was a raw
  // start-token amount. Only use it as a wei estimate when no normalized value
  // was provided, preserving previous behavior for legacy callers.
  return parseUnsignedBigInt(meta.expectedProfit) ?? 0n;
}

function adaptiveReceiptTimeoutMs(builtTx: BuiltTx): number {
  const profit = expectedProfitWei(builtTx);

  if (profit <= PROFIT_TINY_WEI) return MIN_RECEIPT_TIMEOUT_MS;      // 15s for tiny
  if (profit <= PROFIT_SMALL_WEI) return 30_000;                     // 30s for small
  if (profit <= PROFIT_MEDIUM_WEI) return 45_000;                    // 45s for medium
  return MAX_RECEIPT_TIMEOUT_MS;                                      // 60s for large
}

/**
 * Exponential backoff delay for receipt polling: 1s, 2s, 4s, 8s, capped at 8s.
 */
function receiptPollDelayMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 8000);
}

type PendingReceiptEntry = {
  txHash: string;
  fromAddress: string;
  builtTx: BuiltTx;
  touchedPools: string[];  // Pool addresses touched by this tx (for conflict detection)
  publicClient: PublicClientLike;
  nonceManager?: NonceManagerLike;
  submittedAt: number;
  missCount: number;
  lastSeenAt: number;
  pollAttempt: number;
};

type AccountLike = {
  address: string;
};

type TxHash = `0x${string}`;

export type NonceManagerLike = {
  next: (address: string) => Promise<bigint | number>;
  confirm?: (address: string) => unknown;
  revert?: (address: string) => unknown;
  resync?: (address: string) => unknown;
  markDropped?: (address: string) => unknown;
  recoverFromNonceTooHigh?: (address: string, knownSubmitted?: number) => Promise<void>;
};

type TxReceiptLike = {
  status?: "success" | "reverted" | string;
  blockNumber?: { toString?: () => string } | bigint | number;
  gasUsed?: { toString?: () => string } | bigint | number;
  [key: string]: unknown;
};

export type PublicClientLike = {
  call: (params: { account: TxHash; to: TxHash; data: TxHash; value: bigint }) => Promise<unknown>;
  waitForTransactionReceipt: (params: { hash: TxHash }) => Promise<TxReceiptLike>;
  getTransactionReceipt: (params: { hash: TxHash }) => Promise<TxReceiptLike>;
  getTransaction: (params: { hash: TxHash }) => Promise<unknown>;
  getTransactionCount: (params: { address: TxHash; blockTag: "pending" }) => Promise<bigint | number>;
  getBlockNumber: () => Promise<bigint | number>;
};

type DryRunResult = {
  success: boolean;
  error: string | null;
};

type SendTxConfig = {
  privateKey: string;
  nonceManager?: NonceManagerLike | null;
};

type SendTxOptions = {
  dryRunFirst?: boolean;
  /** Skip dry-run entirely (set when pre-execution assessment already verified the route) */
  skipDryRun?: boolean;
  submitTx?: boolean;
  awaitReceipt?: boolean;
  receiptTimeoutMs?: number;
  allowPublicFallback?: boolean;
  publicClient?: PublicClientLike;
  accountFromPrivateKey?: (privateKey: string) => AccountLike;
  signTransactionFn?: typeof signTransaction;
  sendPrivateTxFn?: (rawTx: RawTransaction, options: { allowPublicFallback: boolean }) => Promise<SubmissionResult>;
  sleepFn?: (ms: number) => Promise<unknown>;
  /** Pool addresses touched by this transaction (for pending-conflict detection) */
  touchedPools?: string[];
};

type SendTxBundleOptions = Omit<SendTxOptions, "sendPrivateTxFn" | "sleepFn"> & {
  sendPrivateBundleFn?: (rawTxs: RawTransaction[], options: { blockNumber: bigint }) => Promise<SubmissionResult>;
  sendPrivateTxFn?: (rawTx: RawTransaction, options: { allowPublicFallback: boolean }) => Promise<SubmissionResult>;
  touchedPools?: string[];
};

export type SendTxResult = {
  submitted: boolean;
  confirmed: boolean;
  txHash?: string;
  dryRun?: DryRunResult;
  receipt?: TxReceiptLike;
  error?: string | null;
};

export type SendTxBundleResult = {
  submitted: boolean;
  confirmed: boolean;
  txHashes?: string[];
  receipts?: TxReceiptLike[];
  bundleHash?: unknown;
  submissionMode?: string;
  error?: string | null;
};

const defaultAccountFromPrivateKey = (privateKey: string): AccountLike =>
  privateKeyToAccount(privateKey as TxHash);

function asTxHash(value: string) {
  return value as TxHash;
}

function optionalString(value: TxReceiptLike["blockNumber"] | TxReceiptLike["gasUsed"]) {
  return value == null ? undefined : String(value);
}

const pendingReceiptPolls = new Map<string, PendingReceiptEntry>();
let receiptPollTimer: ReturnType<typeof setInterval> | null = null;
let receiptPollInFlight = false;
const sendTxLogger = logger.child({ component: "send_tx" });

// Global transaction sniper instance (initialized on first use)
let globalSniper: TransactionSniper | null = null;

async function getSniper(): Promise<TransactionSniper> {
  if (!globalSniper) {
    globalSniper = await createSniperFromConfig();
  }
  return globalSniper;
}

export function classifySubmissionError(error: unknown) {
  const message = String((error as { shortMessage?: string; message?: string } | null | undefined)?.shortMessage
    ?? (error as { message?: string } | null | undefined)?.message
    ?? error
    ?? "").toLowerCase();

  if (message.includes("nonce too low") || message.includes("nonce too high") || message.includes("already known")) {
    return "nonce";
  }
  if (message.includes("insufficient funds")) {
    return "funds";
  }
  if (message.includes("execution reverted")) {
    return "revert";
  }
  if (message.includes("intrinsic gas too low") || message.includes("gas required exceeds allowance")) {
    return "gas";
  }
  return "transient";
}

function stopReceiptPollerIfIdle() {
  if (pendingReceiptPolls.size === 0 && receiptPollTimer) {
    clearInterval(receiptPollTimer);
    receiptPollTimer = null;
  }
}

function clearTrackedReceipt(txHash: string | null | undefined) {
  if (!txHash) return;
  pendingReceiptPolls.delete(txHash);
  stopReceiptPollerIfIdle();
}

type TimeoutApi = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  timeoutApi: TimeoutApi = globalThis,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = timeoutApi.setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) timeoutApi.clearTimeout(timer);
  }
}

export function hasTrackedPendingTx(fromAddress?: string | null | undefined) {
  if (!fromAddress) return pendingReceiptPolls.size > 0;
  const account = fromAddress.toLowerCase();
  for (const entry of pendingReceiptPolls.values()) {
    if (entry.fromAddress.toLowerCase() === account) return true;
  }
  return false;
}

/**
 * Get all pool addresses touched by pending transactions for a given account.
 * Returns an empty array if no pending transactions exist.
 */
export function getPendingPools(fromAddress?: string | null | undefined): string[] {
  const pools = new Set<string>();
  for (const entry of pendingReceiptPolls.values()) {
    if (fromAddress && entry.fromAddress.toLowerCase() !== fromAddress.toLowerCase()) continue;
    for (const pool of entry.touchedPools) {
      pools.add(pool.toLowerCase());
    }
  }
  return [...pools];
}

async function pollTrackedReceipt(entry: PendingReceiptEntry) {
  try {
    const receipt = await entry.publicClient.getTransactionReceipt({ hash: asTxHash(entry.txHash) });
    const pollEntry = stageFromBuiltTx(`poll_${entry.txHash}`, entry.builtTx, entry.txHash);
    if (receipt?.status === "reverted") {
      sendTxLogger.warn({ txHash: entry.txHash }, "Transaction reverted after submission");
      logAttemptStage({ ...pollEntry, stage: "receipt_result", outcome: "reverted", txHash: entry.txHash });
      logFailure(entry.txHash, entry.builtTx, receipt);
    } else {
      logAttemptStage({ ...pollEntry, stage: "receipt_result", outcome: "confirmed", txHash: entry.txHash });
      sendTxLogger.info(
        { txHash: entry.txHash, blockNumber: receipt.blockNumber?.toString?.() },
        "Transaction confirmed via poller"
      );
    }
    // Update gas estimation multiplier based on actual vs estimated gas
    const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : null;
    const gasLimit = entry.builtTx.gasLimit ? Number(entry.builtTx.gasLimit) : null;
    if (gasUsed && gasLimit) {
      updateGasEstimateMultiplier(gasUsed, gasLimit);
    }
    clearTrackedReceipt(entry.txHash);
    return;
  } catch {
    // Receipt not found yet.
  }

  try {
    await entry.publicClient.getTransaction({ hash: asTxHash(entry.txHash) });
    entry.lastSeenAt = Date.now();
    entry.missCount = 0;
    return;
  } catch {
    entry.missCount++;
  }

  const ageMs = Date.now() - entry.submittedAt;
  // Use adaptive drop threshold: smaller profits get shorter grace period
  const profit = expectedProfitWei(entry.builtTx);
  const adaptiveDropAfterMs = profit <= PROFIT_TINY_WEI
    ? Math.min(RECEIPT_DROP_AFTER_MS, 25_000)  // 25s for tiny profits
    : RECEIPT_DROP_AFTER_MS;                    // 45s standard

  if (ageMs < adaptiveDropAfterMs || entry.missCount < RECEIPT_MISS_THRESHOLD) {
    return;
  }

  sendTxLogger.warn({ txHash: entry.txHash, ageMs, missCount: entry.missCount }, "Transaction appears dropped from mempool");
  logAttemptStage({
    ...stageFromBuiltTx(`poll_${entry.txHash}`, entry.builtTx, entry.txHash),
    stage: "receipt_result",
    outcome: "dropped",
    txHash: entry.txHash,
    error: `receipt not found after ${ageMs}ms and ${entry.missCount} misses`,
  });
  entry.nonceManager?.markDropped?.(entry.fromAddress);
  clearTrackedReceipt(entry.txHash);
}

async function pollPendingReceipts() {
  if (receiptPollInFlight || pendingReceiptPolls.size === 0) return;
  receiptPollInFlight = true;
  try {
    const now = Date.now();
    // Only poll entries that have had enough time since their last attempt
    // (implements adaptive per-entry polling with exponential backoff)
    for (const [hash, entry] of [...pendingReceiptPolls.entries()]) {
      const elapsedMs = now - entry.lastSeenAt;
      const minDelayMs = receiptPollDelayMs(entry.pollAttempt);
      if (elapsedMs < minDelayMs) continue;
      entry.pollAttempt++;
      await pollTrackedReceipt(entry);
    }
  } finally {
    receiptPollInFlight = false;
    stopReceiptPollerIfIdle();
  }
}

function trackSubmittedTx(txHash: string, builtTx: BuiltTx, fromAddress: string, publicClient: PublicClientLike, touchedPools: string[] = [], nonceManager?: NonceManagerLike | null) {
  pendingReceiptPolls.set(txHash, {
    txHash,
    builtTx,
    fromAddress,
    touchedPools,
    publicClient: publicClient ?? undefined,
    nonceManager: nonceManager ?? undefined,
    submittedAt: Date.now(),
    missCount: 0,
    lastSeenAt: Date.now(),
    pollAttempt: 0,
  });

  if (!receiptPollTimer) {
    // Use adaptive initial interval — shorter for quick detection
    const initialIntervalMs = 1000; // Start polling aggressively at 1s
    receiptPollTimer = setInterval(() => {
      void pollPendingReceipts();
    }, initialIntervalMs);
    receiptPollTimer.unref?.();
  }
}

// ─── Dry run ──────────────────────────────────────────────────

/**
 * Simulate the transaction via eth_call before submitting.
 */
async function dryRun(
  tx: BuiltTx,
  fromAddress: string,
  _publicClient: PublicClientLike  // kept for signature compat; simulation now uses gas_estimator
): Promise<DryRunResult> {
  try {
    // Fix #6: simulate via the dedicated GAS_ESTIMATION_RPC_URL rather than the
    // shared rotation pool. This prevents a bad simulation endpoint from being
    // penalised on the general read path, and allows use of simulation-quality
    // nodes (Tenderly, Alchemy Simulation API) for pre-flight checking.
    const { simulateCall } = await import("./gas_estimator.ts");
    await simulateCall({
      to:    tx.to    as `0x${string}`,
      data:  tx.data  as `0x${string}`,
      from:  fromAddress as `0x${string}`,
      value: tx.value ?? 0n,
      blockTag: "pending",
    });
    return { success: true, error: null };
  } catch (err: unknown) {
    const { getRevertReason } = await import('../utils/get_revert_reason.js');

    const betterReason = await getRevertReason(
      null, // reason already extracted by simulateCall; no second eth_call needed
      {
        to:    tx.to   as `0x${string}`,
        data:  tx.data as `0x${string}`,
        from:  fromAddress as `0x${string}`,
        value: tx.value ?? 0n,
      },
      String((err as any)?.shortMessage ?? (err as any)?.message ?? err)
    );

    return { success: false, error: betterReason };
  }
}

function rawTxHash(rawTx: string) {
  return keccak256(rawTx as `0x${string}`);
}

async function submitSignedTransactionsIndividually(
  rawTxs: RawTransaction[],
  builtTxs: BuiltTx[],
  context: {
    fromAddress: string;
    publicClient: PublicClientLike;
    nonceManager?: NonceManagerLike | null;
    sendPrivateTxFn: (rawTx: RawTransaction, options: { allowPublicFallback: boolean }) => Promise<SubmissionResult>;
    allowPublicFallback: boolean;
  },
) : Promise<SendTxBundleResult> {
  const { fromAddress, publicClient, nonceManager, sendPrivateTxFn, allowPublicFallback } = context;
  const txHashes: string[] = [];
  let firstError: string | null = null;

  // Submit all transactions in parallel for maximum speed
  const results = await Promise.allSettled(
    rawTxs.map((rawTx) => sendPrivateTxFn(rawTx, { allowPublicFallback }))
  );

  for (let index = 0; index < results.length; index++) {
    const settled = results[index];
    if (settled.status === "rejected") {
      if (!firstError) {
        firstError = `Submission ${index} failed: ${settled.reason?.message ?? String(settled.reason)}`;
      }
      continue;
    }

    const result = settled.value;
    if (!result.submitted || !result.txHash) {
      if (!firstError) {
        firstError = result.error || `sendPrivateTx: tx ${index} submission failed`;
      }
      continue;
    }

    txHashes.push(result.txHash);
    nonceManager?.confirm?.(fromAddress);
    trackSubmittedTx(result.txHash, builtTxs[index], fromAddress, publicClient, [], nonceManager);
  }

  if (firstError || txHashes.length === 0) {
    return {
      submitted: false,
      confirmed: false,
      txHashes,
      error: firstError ?? "All transactions failed to submit",
    };
  }

  return {
    submitted: true,
    confirmed: false,
    txHashes,
    submissionMode: "individual_parallel",
  };
}

// ─── Submission ───────────────────────────────────────────────

/**
 * Sign and send a transaction.
 *
 * @param {Object} builtTx         Transaction from buildArbTx()
 * @param {Object} config
 * @param {string} config.privateKey       0x-prefixed hex private key
 * @param {import('./nonce_manager.ts').NonceManager} [config.nonceManager]
 * @param {Object} [options]
 */
export async function sendTx(builtTx: BuiltTx, config: SendTxConfig, options: SendTxOptions = {}): Promise<SendTxResult> {
  const {
    privateKey,
    nonceManager,
  } = config;

  const {
    dryRunFirst = DEFAULT_DRY_RUN,
    submitTx = true,
    awaitReceipt = true,
    receiptTimeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    allowPublicFallback = true,
    publicClient: publicClientOverride,
    accountFromPrivateKey = defaultAccountFromPrivateKey,
    signTransactionFn = signTransaction,
    sendPrivateTxFn = sendPrivateTx,
    sleepFn = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (!privateKey) throw new Error("sendTx: privateKey required");

  const account = accountFromPrivateKey(privateKey);
  const fromAddress = account.address;
  const publicClient = (publicClientOverride ?? executionClient) as PublicClientLike;

  const attemptId = nextAttemptId();
  const baseEntry = stageFromBuiltTx(attemptId, builtTx);
  logAttemptStage({ ...baseEntry, stage: "dry_run_start", ...baseEntry.meta as Record<string, unknown> });

  // 1. Dry run (skip if pre-execution assessment already verified)
  let dryRunResult: DryRunResult = { success: true, error: null };
  if (dryRunFirst && !options.skipDryRun) {
    dryRunResult = await dryRun(builtTx, fromAddress, publicClient);
    if (!dryRunResult.success) {
      logAttemptStage({ ...baseEntry, stage: "dry_run_result", outcome: "dry_run_failed", error: dryRunResult.error ?? undefined });
      sendTxLogger.warn({ error: dryRunResult.error, fromAddress }, "Dry run failed");
      return {
        submitted: false,
        confirmed: false,
        dryRun: dryRunResult,
        error: `Dry run failed: ${dryRunResult.error}`,
      };
    }
    logAttemptStage({ ...baseEntry, stage: "dry_run_result", outcome: "submitted" });
    sendTxLogger.debug({ fromAddress }, "Dry run passed");
  }

  if (!submitTx) {
    return {
      submitted: false,
      confirmed: false,
      dryRun: dryRunResult,
    };
  }

  // 2. Resolve nonce
  let nonce: bigint | number | undefined;
  if (nonceManager) {
    nonce = await nonceManager.next(fromAddress);
  }

  logAttemptStage({ ...baseEntry, stage: "sign_start", nonce: nonce != null ? Number(nonce) : undefined });

  // 3. Sign the transaction
  let rawTx: RawTransaction;
  try {
    rawTx = await signTransactionFn(builtTx, privateKey, nonce, 137);
    logAttemptStage({ ...baseEntry, stage: "sign_result", outcome: "submitted", nonce: nonce != null ? Number(nonce) : undefined });
  } catch (err: unknown) {
    if (nonceManager?.revert) nonceManager.revert(fromAddress);
    const error = err as { message?: unknown } | null | undefined;
    const errorMsg = `Sign failed: ${String(error?.message ?? err)}`;
    logAttemptStage({ ...baseEntry, stage: "sign_result", outcome: "sign_failed", error: errorMsg, nonce: nonce != null ? Number(nonce) : undefined });
    return {
      submitted: false,
      confirmed: false,
      dryRun: dryRunResult,
      error: errorMsg,
    };
  }

  // 4. Submit via multi-endpoint sniper (parallel submission)
let txHash: string | null = null;
let submitError: string | null = null;
const tSubmissionStart = Date.now();

// Track nonce usage to prevent duplicate submissions.
// Retained across the fallback loop to ensure no stale nonce is reused
// with a freshly signed rawTx.
const usedNonces = new Set<bigint | number>();
let _nonceResult = nonce;
if (_nonceResult != null) {
  usedNonces.add(_nonceResult);
}

logAttemptStage({ ...baseEntry, stage: "submit_start", nonce: nonce != null ? Number(nonce) : undefined });

try {
  // Use TransactionSniper for parallel multi-endpoint submission
  const sniper = await getSniper();
  const result = sniper.hasPrivateEndpoints
    ? await sniper.submitPrivate(rawTx as Hex)
    : await sniper.submit(rawTx as Hex);

  txLatency.observe({ stage: "submission" }, Date.now() - tSubmissionStart);

  if (!result.success) {
    const errorMsg = "error" in result ? String(result.error) : "TransactionSniper: all endpoints failed";
    throw new Error(errorMsg);
  }

  txHash = result.hash as `0x${string}`;
  const endpointResults: AttemptEndpointResult[] = (result as { allAttempts?: (AttemptEndpointResult | { hash?: string; endpoint: string; latencyMs: number; error?: unknown })[] }).allAttempts?.map(a => ({
    endpoint: a.endpoint,
    latencyMs: a.latencyMs,
    error: "error" in a ? String(a.error) : undefined,
    hash: "hash" in a ? a.hash as string : undefined,
  })) ?? [];
  logAttemptStage({
    ...baseEntry,
    stage: "submit_result",
    outcome: "submitted",
    txHash,
    nonce: nonce != null ? Number(nonce) : undefined,
    endpoint: result.endpoint,
    latencyMs: result.latencyMs,
    endpointResults,
  });
  sendTxLogger.info({
    txHash,
    endpoint: result.endpoint,
    latencyMs: result.latencyMs,
    attempt: 1
  }, "Transaction submitted via multi-endpoint sniper");

  if (nonceManager?.confirm) nonceManager.confirm(fromAddress);
  trackSubmittedTx(txHash, builtTx, fromAddress, publicClient, options.touchedPools ?? [], nonceManager);
  submitError = null;
} catch (err: unknown) {
  const error = err as { shortMessage?: unknown; message?: unknown } | null | undefined;
  submitError = String(error?.shortMessage ?? error?.message ?? err);
  logAttemptStage({ ...baseEntry, stage: "submit_result", outcome: "submission_failed", error: submitError, nonce: nonce != null ? Number(nonce) : undefined });
  sendTxLogger.warn({ error: submitError }, "Sniper submission failed, trying fallback");

  logAttemptStage({ ...baseEntry, stage: "fallback_start", error: submitError, nonce: nonce != null ? Number(nonce) : undefined });
  for (let attempt = 0; attempt < MAX_SUBMISSION_RETRIES; attempt++) {
    try {
      const retryNonce = nonceManager
        ? await nonceManager.next(fromAddress)
        : undefined;
      if (retryNonce != null) {
        if (usedNonces.has(retryNonce)) {
          sendTxLogger.warn({ retryNonce, attempt: attempt + 1 }, "Re-requested stale nonce, retrying");
          logAttemptStage({
            ...baseEntry, stage: "fallback_attempt", outcome: "skipped",
            nonce: Number(retryNonce), error: "stale nonce reused",
          });
          continue;
        }
        usedNonces.add(retryNonce);
      }
      const retryRawTx = await signTransactionFn(builtTx, privateKey, retryNonce, 137);
      logAttemptStage({
        ...baseEntry, stage: "fallback_attempt", outcome: "submitted",
        nonce: retryNonce != null ? Number(retryNonce) : undefined,
      });
      const result = await sendPrivateTxFn(retryRawTx, { allowPublicFallback });
    
      if (!result.submitted) {
        throw new Error(result.error || "sendPrivateTx: no method succeeded");
      }
      if (!result.txHash) {
        throw new Error("sendPrivateTx: submitted without txHash");
      }

      txHash = result.txHash;
      logAttemptStage({ ...baseEntry, stage: "submit_result", outcome: "submitted", txHash, nonce: undefined, endpoint: result.method, error: undefined });
      sendTxLogger.info({ txHash, method: result.method, attempt: attempt + 1 }, "Transaction submitted (fallback)");

      if (nonceManager?.confirm) nonceManager.confirm(fromAddress);
      trackSubmittedTx(txHash, builtTx, fromAddress, publicClient, options.touchedPools ?? [], nonceManager);
      submitError = null;
      break;
    } catch (fallbackErr: unknown) {
      const fallbackError = fallbackErr as { shortMessage?: unknown; message?: unknown } | null | undefined;
      submitError = String(fallbackError?.shortMessage ?? fallbackError?.message ?? fallbackErr);
      const errorCategory = classifySubmissionError(fallbackErr);
      logAttemptStage({ ...baseEntry, stage: "fallback_attempt", outcome: "submission_failed", error: submitError, errorCategory, nonce: undefined });
      sendTxLogger.warn({ error: submitError, attempt: attempt + 1 }, "Fallback attempt failed");

      if (errorCategory !== "transient") {
        if (nonceManager?.resync && errorCategory === "nonce") {
          try {
            if (nonceManager.recoverFromNonceTooHigh) {
              await nonceManager.recoverFromNonceTooHigh(fromAddress, 1);
            } else {
              nonceManager.resync(fromAddress);
            }
          } catch {
            nonceManager.resync(fromAddress);
          }
        }
        break;
      }

      await sleepFn(500 * (attempt + 1));
    }
  }
}

  if (!txHash) {
    if (nonceManager?.revert) nonceManager.revert(fromAddress);
    return {
      submitted: false,
      confirmed: false,
      dryRun: dryRunResult,
      error: submitError,
    };
  }

  if (!awaitReceipt) {
    return {
      submitted: true,
      confirmed: false,
      txHash,
      dryRun: dryRunResult,
    };
  }

  // Use profit-weighted adaptive timeout
  const adaptiveTimeout = adaptiveReceiptTimeoutMs(builtTx);
  const effectiveTimeout = receiptTimeoutMs === DEFAULT_RECEIPT_TIMEOUT_MS
    ? adaptiveTimeout
    : receiptTimeoutMs;

  try {
    const tConfirmationStart = Date.now();
    const receipt = await withTimeout(
      publicClient.waitForTransactionReceipt({ hash: asTxHash(txHash) }),
      effectiveTimeout,
      "Receipt timeout",
    ) as TxReceiptLike;

    // Metric: confirmation latency
    txLatency.observe({ stage: "confirmation" }, Date.now() - tConfirmationStart);

    const confirmed = receipt.status === "success";
    clearTrackedReceipt(txHash);
    if (!confirmed) {
      sendTxLogger.warn({ txHash }, "Transaction reverted");
      logAttemptStage({ ...baseEntry, stage: "receipt_result", outcome: "reverted", txHash });
      logFailure(txHash, builtTx, receipt);
    } else {
      logAttemptStage({ ...baseEntry, stage: "receipt_result", outcome: "confirmed", txHash });
      sendTxLogger.info({ txHash, blockNumber: receipt.blockNumber?.toString?.() }, "Transaction confirmed");
    }

    return {
      submitted: true,
      confirmed,
      txHash,
      receipt,
      dryRun: dryRunResult,
    };
  } catch (err: unknown) {
    const message = String((err as { message?: unknown } | null | undefined)?.message ?? err);
    sendTxLogger.warn({ txHash, error: message }, "Receipt wait failed");
    logAttemptStage({ ...baseEntry, stage: "receipt_result", outcome: "receipt_timeout", txHash, error: message });
    return {
      submitted: true,
      confirmed: false,
      txHash,
      dryRun: dryRunResult,
      error: message,
    };
  }
}

export async function sendTxBundle(builtTxs: BuiltTx[], config: SendTxConfig, options: SendTxBundleOptions = {}): Promise<SendTxBundleResult> {
  const {
    privateKey,
    nonceManager,
  } = config;

  const {
    dryRunFirst = DEFAULT_DRY_RUN,
    submitTx = true,
    awaitReceipt = false,
    receiptTimeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    allowPublicFallback = true,
    publicClient: publicClientOverride,
    accountFromPrivateKey = defaultAccountFromPrivateKey,
    signTransactionFn = signTransaction,
    sendPrivateBundleFn = sendPrivateBundle,
    sendPrivateTxFn = sendPrivateTx,
  } = options;

  if (!privateKey) throw new Error("sendTxBundle: privateKey required");
  if (!Array.isArray(builtTxs) || builtTxs.length === 0) {
    throw new Error("sendTxBundle: builtTxs required");
  }

  const account = accountFromPrivateKey(privateKey);
  const fromAddress = account.address;
  const publicClient = (publicClientOverride ?? executionClient) as PublicClientLike;
  const attemptEntries = builtTxs.map((builtTx) => stageFromBuiltTx(nextAttemptId("bundle_tx"), builtTx));

  if (dryRunFirst) {
    for (const entry of attemptEntries) {
      logAttemptStage({ ...entry, stage: "dry_run_start" });
    }
    const dryRunResults = await mapWithConcurrency(
      builtTxs,
      builtTxs.length,
      (builtTx) => dryRun(builtTx, fromAddress, publicClient),
    );
    dryRunResults.forEach((result, index) => {
      logAttemptStage({
        ...attemptEntries[index],
        stage: "dry_run_result",
        outcome: result.success ? "submitted" : "dry_run_failed",
        error: result.success ? undefined : result.error ?? undefined,
      });
    });
    const failedDryRun = dryRunResults.find((result) => !result.success);
    if (failedDryRun) {
      sendTxLogger.warn(
        { event: "bundle_dry_run_failed", error: failedDryRun.error, bundleSize: builtTxs.length },
        "Bundle dry run failed"
      );
      return {
        submitted: false,
        confirmed: false,
        error: `Bundle dry run failed: ${failedDryRun.error}`,
      };
    }
  }

  if (!submitTx) {
    for (const entry of attemptEntries) {
      logAttemptStage({ ...entry, stage: "final", outcome: "skipped", error: "submitTx disabled" });
    }
    return {
      submitted: false,
      confirmed: false,
      txHashes: [],
    };
  }

  const reservedNonces: bigint[] = [];
  try {
    if (nonceManager) {
      // Fix #9: if nonceManager.next() throws partway through, the outer catch
      // will revert exactly reservedNonces.length times — matching what was
      // actually reserved. Do NOT pre-fill the array or use builtTxs.length in
      // the catch block; always use reservedNonces.length.
      for (let i = 0; i < builtTxs.length; i++) {
        reservedNonces.push(BigInt(await nonceManager.next(fromAddress)));
      }
    } else {
      const startingNonce = BigInt(await publicClient.getTransactionCount({
        address: asTxHash(fromAddress),
        blockTag: "pending",
      }));
      for (let i = 0; i < builtTxs.length; i++) {
        reservedNonces.push(startingNonce + BigInt(i));
      }
    }

    const rawTxs: RawTransaction[] = await Promise.all(
      builtTxs.map(async (builtTx, index) => {
        const nonce = reservedNonces[index];
        logAttemptStage({ ...attemptEntries[index], stage: "sign_start", nonce: Number(nonce) });
        try {
          const rawTx = await signTransactionFn(builtTx, privateKey, nonce, 137);
          logAttemptStage({ ...attemptEntries[index], stage: "sign_result", outcome: "submitted", nonce: Number(nonce) });
          return rawTx;
        } catch (err: unknown) {
          const errorMsg = `Sign failed: ${String((err as { message?: unknown } | null | undefined)?.message ?? err)}`;
          logAttemptStage({ ...attemptEntries[index], stage: "sign_result", outcome: "sign_failed", error: errorMsg, nonce: Number(nonce) });
          throw err;
        }
      })
    );
    for (const entry of attemptEntries) {
      logAttemptStage({ ...entry, stage: "submit_start" });
    }
    const blockNumber = BigInt(await publicClient.getBlockNumber()) + 1n;
    const tSubmissionStart = Date.now();

    const result = await sendPrivateBundleFn(rawTxs, { blockNumber });
    txLatency.observe({ stage: "submission" }, Date.now() - tSubmissionStart);

    let txHashes: string[] = rawTxs.map(rawTxHash);
    let bundleHash = result.bundleHash;

    if (!result.submitted && result.retryIndividually) {
      sendTxLogger.warn(
        {
          event: "bundle_fallback_individual",
          error: result.error,
          bundleSize: builtTxs.length,
          blockNumber: blockNumber.toString(),
        },
        "Bundle relay unavailable; falling back to individual private submissions"
      );
      const fallbackResult = await submitSignedTransactionsIndividually(rawTxs, builtTxs, {
        fromAddress,
        publicClient,
        nonceManager,
        sendPrivateTxFn,
        allowPublicFallback,
      });
      if (!fallbackResult.submitted) {
        // Revert any nonces not consumed by the individual fallback.
        // submitSignedTransactionsIndividually reverts nonces for un-sent txs
        // internally, but we also call resync here for nonce-error scenarios.
        if (nonceManager?.resync && classifySubmissionError(fallbackResult.error) === "nonce") {
          nonceManager.resync(fromAddress);
        }
        for (const entry of attemptEntries) {
          logAttemptStage({ ...entry, stage: "submit_result", outcome: "submission_failed", error: fallbackResult.error ?? undefined });
        }
        return fallbackResult;
      }
      txHashes = fallbackResult.txHashes ?? [];
      txHashes.forEach((hash, index) => {
        logAttemptStage({ ...attemptEntries[index], stage: "submit_result", outcome: "submitted", txHash: hash, endpoint: "individual_fallback" });
      });
      bundleHash = undefined;
    } else if (!result.submitted) {
      throw new Error(result.error || "sendPrivateBundle: no method succeeded");
    } else {
      txHashes.forEach((hash, index) => {
        logAttemptStage({ ...attemptEntries[index], stage: "submit_result", outcome: "submitted", txHash: hash, endpoint: "bundle", latencyMs: Date.now() - tSubmissionStart });
      });
      if (nonceManager?.confirm) {
        for (let i = 0; i < builtTxs.length; i++) {
          nonceManager.confirm(fromAddress);
        }
      }

      for (let i = 0; i < txHashes.length; i++) {
        trackSubmittedTx(txHashes[i], builtTxs[i], fromAddress, publicClient, [], nonceManager);
      }
    }

    if (!awaitReceipt) {
      return {
        submitted: true,
        confirmed: false,
        txHashes,
        bundleHash,
      };
    }

    try {
      const receipts = await withTimeout(
        Promise.all(txHashes.map((hash) => publicClient.waitForTransactionReceipt({ hash: asTxHash(hash) }))),
        receiptTimeoutMs,
        "Bundle receipt timeout",
      ) as TxReceiptLike[];

      for (const hash of txHashes) clearTrackedReceipt(hash);
      const confirmed = receipts.every((receipt) => receipt?.status === "success");
      receipts.forEach((receipt, index) => {
        const hash = txHashes[index];
        logAttemptStage({
          ...attemptEntries[index],
          stage: "receipt_result",
          outcome: receipt?.status === "success" ? "confirmed" : "reverted",
          txHash: hash,
        });
      });

      return {
        submitted: true,
        confirmed,
        txHashes,
        receipts,
        bundleHash,
      };
    } catch (err: unknown) {
      const message = String((err as { message?: unknown } | null | undefined)?.message ?? err);
      sendTxLogger.warn({ txHashes, error: message }, "Bundle receipt wait failed");
      txHashes.forEach((hash, index) => {
        logAttemptStage({ ...attemptEntries[index], stage: "receipt_result", outcome: "receipt_timeout", txHash: hash, error: message });
      });
      return {
        submitted: true,
        confirmed: false,
        txHashes,
        bundleHash,
        error: message,
      };
    }
  } catch (err: unknown) {
    const errorMessage = String((err as { message?: unknown } | null | undefined)?.message ?? err);
    if (nonceManager?.revert) {
      for (let i = 0; i < reservedNonces.length; i++) {
        nonceManager.revert(fromAddress);
      }
      if (nonceManager.resync && classifySubmissionError(err) === "nonce") {
        nonceManager.resync(fromAddress);
      }
    }
    for (const entry of attemptEntries) {
      logAttemptStage({ ...entry, stage: "submit_result", outcome: "submission_failed", error: errorMessage, errorCategory: classifySubmissionError(err) });
    }
    return {
      submitted: false,
      confirmed: false,
      error: errorMessage,
    };
  }
}

// ─── Failure logging ──────────────────────────────────────────

function logFailure(txHash: string, builtTx: BuiltTx, receipt: TxReceiptLike | null | undefined) {
  const entry = {
    timestamp: new Date().toISOString(),
    txHash,
    blockNumber: optionalString(receipt?.blockNumber),
    gasUsed: optionalString(receipt?.gasUsed),
    meta: builtTx.meta,
  };
  sendTxLogger.error(entry, "Transaction failure details");
}

export const __sendTxTest = {
  withTimeout,
};
