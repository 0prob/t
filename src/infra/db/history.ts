import type { CompatDatabase } from "./connection.ts";

export function recordExecution(
  db: CompatDatabase,
  routeKey: string,
  profit: string,
  gasCost: string,
  success: number,
  details: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.statement(
    "recordExecution",
    `INSERT INTO arb_history (route_key, profit, gas_cost, executed_at, success, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return stmt.run(routeKey, profit, gasCost, now, success, details);
}

export function getRecentHistory(db: CompatDatabase, limit: number = 50) {
  const stmt = db.statement(
    "getRecentHistory",
    `SELECT * FROM arb_history ORDER BY executed_at DESC LIMIT ?`,
  );
  return stmt.all(limit) as Record<string, unknown>[];
}

export function getExecutionStats(db: CompatDatabase, sinceMs: number) {
  const stmt = db.statement(
    "getExecutionStats",
    `SELECT
       COUNT(*) as total,
       SUM(success) as successes,
       AVG(CASE WHEN success THEN CAST(profit AS REAL) ELSE NULL END) as avg_profit,
       SUM(CASE WHEN success THEN CAST(profit AS REAL) ELSE 0 END) as total_profit
     FROM arb_history
     WHERE executed_at >= ?`,
  );
  const row = stmt.get(sinceMs) as Record<string, unknown> | undefined;
  return {
    total: Number(row?.total ?? 0),
    successes: Number(row?.successes ?? 0),
    avg_profit: row?.avg_profit ?? null,
    total_profit: row?.total_profit ?? 0,
  };
}
