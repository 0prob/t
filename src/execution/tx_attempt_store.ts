/**
 * src/execution/tx_attempt_store.ts — Persistent transaction attempt log
 *
 * Writes every AttemptLogEntry to a `tx_attempts` SQLite table so that
 * failed, dropped, or reverted transactions can be diagnosed offline.
 *
 * Usage:
 *   import { TxAttemptStore } from "./tx_attempt_store.ts";
 *   import { setAttemptLogSink } from "./attempt_log.ts";
 *
 *   const store = new TxAttemptStore(DB_PATH);
 *   setAttemptLogSink(store.write.bind(store));
 */

import { CompatDatabase } from "../db/sqlite.ts";
import type { AttemptLogEntry } from "./attempt_log.ts";

// ─── Schema ───────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tx_attempts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id     TEXT    NOT NULL,
    stage          TEXT    NOT NULL,
    outcome        TEXT,
    tx_hash        TEXT,
    nonce          INTEGER,
    endpoint       TEXT,
    latency_ms     INTEGER,
    error          TEXT,
    error_category TEXT,
    gas_limit      TEXT,
    gas_price      TEXT,
    profit_wei     TEXT,
    route_summary  TEXT,
    endpoint_results TEXT,  -- JSON
    meta           TEXT,    -- JSON (private keys already redacted upstream)
    recorded_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tx_attempts_attempt_id  ON tx_attempts(attempt_id);
  CREATE INDEX IF NOT EXISTS idx_tx_attempts_tx_hash     ON tx_attempts(tx_hash);
  CREATE INDEX IF NOT EXISTS idx_tx_attempts_outcome     ON tx_attempts(outcome);
  CREATE INDEX IF NOT EXISTS idx_tx_attempts_recorded_at ON tx_attempts(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_tx_attempts_stage       ON tx_attempts(stage);
`;

// ─── Store ────────────────────────────────────────────────────

export class TxAttemptStore {
  private db: CompatDatabase;
  private _open = false;

  constructor(dbPath: string) {
    this.db = new CompatDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_SQL);
    this.db.exec(INDEXES_SQL);
    this._open = true;
  }

  /**
   * Persist one AttemptLogEntry row. Silently swallows errors — logging
   * failures must never interrupt the hot execution path.
   */
  write(entry: AttemptLogEntry): void {
    if (!this._open) return;
    try {
      this.db.prepare(`
        INSERT INTO tx_attempts (
          attempt_id, stage, outcome, tx_hash, nonce, endpoint,
          latency_ms, error, error_category, gas_limit, gas_price,
          profit_wei, route_summary, endpoint_results, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.attemptId,
        entry.stage,
        entry.outcome ?? null,
        entry.txHash ?? null,
        entry.nonce != null ? entry.nonce : null,
        entry.endpoint ?? null,
        entry.latencyMs != null ? entry.latencyMs : null,
        entry.error ?? null,
        entry.errorCategory ?? null,
        entry.gasLimit ?? null,
        entry.gasPrice ?? null,
        entry.profitWei ?? null,
        entry.routeSummary ?? null,
        entry.endpointResults ? JSON.stringify(entry.endpointResults) : null,
        entry.meta ? JSON.stringify(entry.meta) : null,
      );
    } catch {
      // Intentionally silent — tx_attempts is diagnostic infra, not critical path
    }
  }

  // ─── Query helpers ─────────────────────────────────────────

  /** All stages for a given attempt_id, in insertion order. */
  getAttempt(attemptId: string): unknown[] {
    return this.db.prepare(
      "SELECT * FROM tx_attempts WHERE attempt_id = ? ORDER BY id ASC"
    ).all(attemptId);
  }

  /** Most recent N final outcomes, useful for quick health checks. */
  getRecentOutcomes(limit = 50): unknown[] {
    return this.db.prepare(`
      SELECT attempt_id, outcome, tx_hash, profit_wei, route_summary,
             error, error_category, recorded_at
      FROM   tx_attempts
      WHERE  stage = 'final' OR outcome IN (
               'dry_run_failed','sign_failed','submission_failed',
               'reverted','receipt_timeout','dropped','confirmed'
             )
      ORDER  BY id DESC
      LIMIT  ?
    `).all(limit);
  }

  /** All failed attempts in the last N minutes. */
  getRecentFailures(windowMinutes = 60): unknown[] {
    return this.db.prepare(`
      SELECT *
      FROM   tx_attempts
      WHERE  outcome IN (
               'dry_run_failed','sign_failed','submission_failed',
               'reverted','receipt_timeout','dropped'
             )
        AND  recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' minutes')
      ORDER  BY id DESC
    `).all(`-${windowMinutes}`);
  }

  /** Full history for a tx hash (all stages, across any attempt_id). */
  getByTxHash(txHash: string): unknown[] {
    return this.db.prepare(
      "SELECT * FROM tx_attempts WHERE tx_hash = ? ORDER BY id ASC"
    ).all(txHash);
  }

  /**
   * Outcome summary counts over the last N minutes.
   * Returns rows: { outcome, count }
   */
  getOutcomeSummary(windowMinutes = 60): unknown[] {
    return this.db.prepare(`
      SELECT outcome, COUNT(*) as count
      FROM   tx_attempts
      WHERE  outcome IS NOT NULL
        AND  recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' minutes')
      GROUP  BY outcome
      ORDER  BY count DESC
    `).all(`-${windowMinutes}`);
  }

  /** Prune rows older than retentionDays (default 7). Call periodically to bound DB growth. */
  prune(retentionDays = 7): number {
    const result = this.db.prepare(`
      DELETE FROM tx_attempts
      WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' days')
    `).run(`-${retentionDays}`) as { changes?: number };
    return result?.changes ?? 0;
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.db.close();
  }
}
