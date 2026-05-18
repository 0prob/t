import http from "http";
import { createRootLogger } from "./logger.ts";
const logger = createRootLogger({ level: "info" });

// ─── Lightweight metric primitives (no prom-client dependency) ────

type LabelObj = Record<string, unknown>;

interface LabelledCounter {
  inc(value?: number): void;
}
interface LabelledHistogram {
  observe(value: number): void;
}
interface LabelledGauge {
  set(value: number): void;
}

export interface Metric {
  name: string;
  _collect(): { type: string; values: Array<{ labels: string; value?: number; buckets?: number[]; counts?: number[] }> } | null;
}

const _metricRegistry: Metric[] = [];

export class Counter {
  private _values = new Map<string, number>();
  private _labelNames: string[];
  name: string;

  constructor(_opts: { name: string; help: string; labelNames?: string[] }) {
    this.name = _opts.name;
    this._labelNames = _opts.labelNames ?? [];
    _metricRegistry.push(this);
  }

  inc(labelsOrLabelObj?: string | LabelObj | number, value?: number) {
    const key = this._labelKey(labelsOrLabelObj, value);
    const incBy = typeof labelsOrLabelObj === "number" ? labelsOrLabelObj : (value ?? 1);
    this._values.set(key, (this._values.get(key) ?? 0) + incBy);
  }

  labels(...args: string[]): LabelledCounter {
    const labelObj: LabelObj = {};
    for (let i = 0; i < this._labelNames.length && i < args.length; i++) {
      labelObj[this._labelNames[i]] = args[i];
    }
    const key = JSON.stringify(labelObj);
    return {
      inc: (v) => {
        this._values.set(key, (this._values.get(key) ?? 0) + (v ?? 1));
      },
    };
  }

  private _labelKey(labelsOrLabelObj: string | LabelObj | number | undefined, _value: number | undefined): string {
    if (typeof labelsOrLabelObj === "object" && labelsOrLabelObj != null) return JSON.stringify(labelsOrLabelObj);
    return "{}";
  }

  _collect() {
    return { type: "counter" as const, values: [...this._values.entries()].map(([k, v]) => ({ labels: k, value: v })) };
  }
}

export class Histogram {
  private _labelNames: string[];
  private _buckets: number[];
  private _counts: Map<string, number[]>;
  name: string;

  constructor(opts: { name: string; help: string; labelNames?: string[]; buckets?: number[] }) {
    this.name = opts.name;
    this._labelNames = opts.labelNames ?? [];
    this._buckets = (opts.buckets ?? []).slice();
    this._counts = new Map();
    _metricRegistry.push(this);
  }

  observe(labelsOrLabelObj?: string | LabelObj | number, value?: number) {
    const key = typeof labelsOrLabelObj === "object" && labelsOrLabelObj != null ? JSON.stringify(labelsOrLabelObj) : "{}";
    const val = typeof labelsOrLabelObj === "number" ? labelsOrLabelObj : (value ?? 0);
    let counts = this._counts.get(key);
    if (!counts) {
      counts = new Array(this._buckets.length + 1).fill(0);
      this._counts.set(key, counts);
    }
    for (let i = 0; i < this._buckets.length; i++) {
      if (val <= this._buckets[i]) {
        counts[i]++;
        return;
      }
    }
    counts[this._buckets.length]++;
  }

  labels(...args: string[]): LabelledHistogram {
    const labelObj: LabelObj = {};
    for (let i = 0; i < this._labelNames.length && i < args.length; i++) {
      labelObj[this._labelNames[i]] = args[i];
    }
    const key = JSON.stringify(labelObj);
    const buckets = this._buckets;
    return {
      observe: (v) => {
        let counts = this._counts.get(key);
        if (!counts) {
          counts = new Array(buckets.length + 1).fill(0);
          this._counts.set(key, counts);
        }
        for (let i = 0; i < buckets.length; i++) {
          if (v <= buckets[i]) {
            counts[i]++;
            return;
          }
        }
        counts[buckets.length]++;
      },
    };
  }

  _collect() {
    const values: Array<{ labels: string; buckets: number[]; counts: number[] }> = [];
    for (const [labels, counts] of this._counts) {
      values.push({ labels, buckets: this._buckets, counts: counts.slice() });
    }
    return { type: "histogram" as const, values };
  }
}

export class Gauge {
  private _values = new Map<string, number>();
  name: string;

  constructor(_opts: { name: string; help: string; labelNames?: string[] }) {
    this.name = _opts.name;
    _metricRegistry.push(this);
  }

  set(value: number) {
    this._values.set("{}", value);
  }

  labels(...args: string[]): LabelledGauge {
    const key = JSON.stringify(args);
    return { set: (v) => this._values.set(key, v) };
  }

  _collect() {
    return { type: "gauge" as const, values: [...this._values.entries()].map(([k, v]) => ({ labels: k, value: v })) };
  }
}

// ─── Metrics Definitions ───────────────────────────────────────

export const pathsEvaluated = new Counter({
  name: "arb_paths_evaluated_total",
  help: "Total number of arbitrage paths evaluated",
  labelNames: ["pass"],
});
export const arbsFound = new Counter({
  name: "arb_opportunities_found_total",
  help: "Total number of profitable arbitrage opportunities found",
  labelNames: ["pass"],
});
export const candidateShortlistSize = new Histogram({
  name: "arb_candidate_shortlist_size",
  help: "Number of candidates shortlisted for optimization",
  buckets: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144],
});
export const candidateOptimizedCount = new Histogram({
  name: "arb_candidate_optimized_count",
  help: "Number of shortlisted candidates that were optimized",
  buckets: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144],
});
export const candidateProfitableCount = new Histogram({
  name: "arb_candidate_profitable_count",
  help: "Number of profitable candidates remaining after assessment",
  buckets: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144],
});
export const candidateProfitableYield = new Histogram({
  name: "arb_candidate_profitable_yield_ratio",
  help: "Profitable candidates divided by shortlisted candidates",
  buckets: [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1],
});
export const txAttempted = new Counter({
  name: "arb_tx_attempted_total",
  help: "Total number of transaction attempts",
  labelNames: ["pass"],
});
export const txSuccessful = new Counter({
  name: "arb_tx_successful_total",
  help: "Total number of successful transactions",
  labelNames: ["pass"],
});
export const txReverted = new Counter({
  name: "arb_tx_reverted_total",
  help: "Total number of reverted transactions",
  labelNames: ["pass"],
});
export const profitAccumulator = new Histogram({
  name: "arb_profit_accumulated_wei",
  help: "Accumulated profit in wei",
  buckets: [1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21],
});
export const txLatency = new Histogram({
  name: "arb_tx_latency_ms",
  help: "Transaction latency in milliseconds",
  labelNames: ["stage"],
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});
export const gasPriceGwei = new Gauge({ name: "arb_gas_price_gwei", help: "Current gas price in gwei" });
export const rpcErrors = new Counter({
  name: "arb_rpc_errors_total",
  help: "Total number of RPC errors encountered",
  labelNames: ["method"],
});
export const rpcSwitches = new Counter({
  name: "arb_rpc_switches_total",
  help: "Total number of RPC endpoint switches",
  labelNames: ["reason"],
});
export const rpcLatencyMs = new Histogram({
  name: "arb_rpc_latency_ms",
  help: "RPC endpoint probe latency in milliseconds",
  labelNames: ["endpoint"],
  buckets: [10, 50, 100, 250, 500, 1000],
});
export const registryInvalidPools = new Gauge({
  name: "arb_registry_invalid_pools",
  help: "Number of active pools that failed metadata validation",
});
export const watcherHealth = new Gauge({ name: "arb_watcher_health", help: "Watcher health status (1 healthy, 0 unhealthy)" });
export const watcherHalts = new Counter({
  name: "arb_watcher_halts_total",
  help: "Total number of watcher halts by reason category",
  labelNames: ["reason_category"],
});
export const watcherLastHaltBlock = new Gauge({
  name: "arb_watcher_last_halt_block",
  help: "Most recent block height associated with a watcher halt",
});
export const watcherIntegrityErrorStreak = new Gauge({
  name: "arb_watcher_integrity_error_streak",
  help: "Consecutive watcher integrity error streak",
});
export const watcherPollLagBlocks = new Gauge({ name: "arb_watcher_poll_lag_blocks", help: "HyperSync watcher lag in blocks" });
export const watcherLogsPerSecond = new Gauge({ name: "arb_watcher_logs_per_second", help: "Decoded HyperSync logs processed per second" });
export const watcherDecodeMs = new Histogram({
  name: "arb_watcher_decode_ms",
  help: "Time spent decoding HyperSync logs in milliseconds",
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});
export const watcherStateCommitMs = new Histogram({
  name: "arb_watcher_state_commit_ms",
  help: "Time spent mutating and committing watcher state in milliseconds",
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});
export const predictiveCacheTrackedPaths = new Gauge({
  name: "arb_predictive_cache_tracked_paths",
  help: "Number of paths tracked in predictive shadow state cache",
});
export const predictiveCacheCycleTime = new Histogram({
  name: "arb_predictive_cache_cycle_time_ms",
  help: "Time spent in predictive cache pre-computation cycle in milliseconds",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
});
export const predictiveCacheHitRate = new Gauge({
  name: "arb_predictive_cache_hit_rate",
  help: "Ratio of cache hits to total path requests (0-1)",
});
export const txSubmissionLatency = new Histogram({
  name: "arb_tx_submission_latency_ms",
  help: "Transaction submission latency in milliseconds by endpoint type",
  labelNames: ["endpoint_type", "success"],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});
export const txSubmissions = new Counter({
  name: "arb_tx_submissions_total",
  help: "Total transaction submissions by endpoint and result",
  labelNames: ["endpoint_type", "result"],
});

// ─── Telemetry helpers ─────────────────────────────────────────

export function recordPredictiveCacheTelemetry(payload: {
  trackedPaths?: number;
  hitRate?: number;
  staleness?: number;
  cycleTimeMs?: number;
}) {
  if (payload.trackedPaths != null) predictiveCacheTrackedPaths.set(payload.trackedPaths);
  if (payload.hitRate != null) predictiveCacheHitRate.set(Math.max(0, Math.min(1, payload.hitRate)));
  if (payload.cycleTimeMs != null) predictiveCacheCycleTime.observe(payload.cycleTimeMs);
}

export function recordTxSubmissionTelemetry(payload: {
  success: boolean;
  latencyMs: number;
  endpoint: string;
  method: string;
  error?: string;
}) {
  const endpointType = classifyEndpointType(payload.endpoint);
  const result = payload.success ? "success" : "failure";
  txSubmissionLatency.labels(endpointType, result).observe(payload.latencyMs);
  txSubmissions.labels(endpointType, result).inc();
}

function classifyEndpointType(url: string): string {
  if (!url || url === "all") return "unknown";
  const lower = url.toLowerCase();
  if (lower.includes("alchemy")) return "alchemy";
  if (lower.includes("quicknode")) return "quicknode";
  if (lower.includes("drpc")) return "drpc";
  if (lower.includes("publicnode")) return "publicnode";
  if (lower.includes("llamarpc")) return "llamarpc";
  if (lower.includes("ankr")) return "ankr";
  if (lower.includes("tenderly")) return "tenderly";
  if (lower.includes("onfinality")) return "onfinality";
  return "other";
}

export function recordWatcherPollTelemetry(payload: {
  pollLagBlocks?: unknown;
  logsPerSec?: unknown;
  decodeMs?: unknown;
  stateCommitMs?: unknown;
}) {
  const pollLag = Number(payload.pollLagBlocks);
  if (Number.isFinite(pollLag) && pollLag >= 0) watcherPollLagBlocks.set(pollLag);
  const logsPerSec = Number(payload.logsPerSec);
  if (Number.isFinite(logsPerSec) && logsPerSec >= 0) watcherLogsPerSecond.set(logsPerSec);
  const decodeMs = Number(payload.decodeMs);
  if (Number.isFinite(decodeMs) && decodeMs >= 0) watcherDecodeMs.observe(decodeMs);
  const stateCommitMs = Number(payload.stateCommitMs);
  if (Number.isFinite(stateCommitMs) && stateCommitMs >= 0) watcherStateCommitMs.observe(stateCommitMs);
}

export function classifyWatcherHaltReason(reason: unknown) {
  const message = String(reason ?? "").toLowerCase();
  if (message.includes("rollback guards")) return "rollback_guard";
  if (message.includes("nextblock") || message.includes("cursor") || message.includes("stalled at")) return "cursor";
  return "other";
}

export function setWatcherHealthy() {
  watcherHealth.set(1);
  watcherIntegrityErrorStreak.set(0);
}

export function recordWatcherHalt(payload: { reason?: unknown; consecutiveIntegrityPollErrors?: unknown; currentLastBlock?: unknown }) {
  watcherHealth.set(0);
  watcherIntegrityErrorStreak.set(Math.max(0, Number(payload?.consecutiveIntegrityPollErrors) || 0));
  watcherLastHaltBlock.set(Math.max(0, Number(payload?.currentLastBlock) || 0));
  watcherHalts.labels(classifyWatcherHaltReason(payload?.reason)).inc();
}

export function getMetrics() {
  return {
    registry_invalid_pools: registryInvalidPools,
    watcher_health: watcherHealth,
    watcher_halts_total: watcherHalts,
    watcher_last_halt_block: watcherLastHaltBlock,
    watcher_integrity_error_streak: watcherIntegrityErrorStreak,
    watcher_poll_lag_blocks: watcherPollLagBlocks,
    watcher_logs_per_second: watcherLogsPerSecond,
    watcher_decode_ms: watcherDecodeMs,
    watcher_state_commit_ms: watcherStateCommitMs,
  };
}

// ─── Metrics Server ────────────────────────────────────────────

let server: http.Server | null = null;

const allMetrics = () => [
  pathsEvaluated,
  arbsFound,
  txAttempted,
  txSuccessful,
  txReverted,
  txLatency,
  txSubmissionLatency,
  txSubmissions,
  rpcErrors,
  rpcSwitches,
  registryInvalidPools,
  candidateShortlistSize,
  candidateOptimizedCount,
  candidateProfitableCount,
  candidateProfitableYield,
  profitAccumulator,
  watcherHealth,
  watcherHalts,
  watcherLastHaltBlock,
  watcherIntegrityErrorStreak,
  watcherPollLagBlocks,
  watcherLogsPerSecond,
  watcherDecodeMs,
  watcherStateCommitMs,
  predictiveCacheTrackedPaths,
  predictiveCacheHitRate,
  predictiveCacheCycleTime,
  gasPriceGwei,
];

/** Render all registered metrics in Prometheus text format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const m of _metricRegistry) {
    const collected = m._collect();
    if (!collected) continue;
    const type = collected.type;
    if (type === "histogram") {
      for (const v of collected.values) {
        for (let i = 0; i < (v.buckets ?? []).length; i++) {
          lines.push(`${m.name}_bucket{le="${v.buckets![i]}"} ${v.counts![i]}`);
        }
        lines.push(`${m.name}_bucket{le="+Inf"} ${v.counts![v.counts!.length - 1]}`);
        lines.push(`${m.name}_count ${v.counts!.reduce((a: number, b: number) => a + b, 0)}`);
        lines.push(`${m.name}_sum ${0}`);
      }
    } else if (type === "counter" || type === "gauge") {
      for (const v of collected.values) {
        lines.push(`${m.name} ${v.value}`);
      }
    }
  }
  return lines.join("\n");
}

export function startMetricsServer(port = 9090) {
  if (server) return;
  const candidateServer = http.createServer(async (_req, res) => {
    try {
      const entries = allMetrics().flatMap((m: any) => {
        const collected = m._collect?.() ?? null;
        if (!collected) return [];
        return collected.values.map((v: any) => ({
          name: m.name ?? m.constructor.name,
          labels: v.labels,
          ...(collected.type === "histogram" ? { buckets: v.buckets, counts: v.counts } : { value: v.value }),
        }));
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ metrics: entries }, null, 2));
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
  });
  server = candidateServer;
  candidateServer.once("error", (err: NodeJS.ErrnoException) => {
    if (server === candidateServer) server = null;
    logger.warn(
      { event: "metrics_server_start_failed", port, code: err.code, err },
      `[metrics] Failed to start metrics server on port ${port}; continuing without HTTP endpoint`,
    );
  });
  candidateServer.listen(port, () => {
    logger.info(`[metrics] Metrics server listening on port ${port}`);
  });
}

export function stopMetricsServer() {
  if (server) {
    server.close();
    server = null;
  }
}
