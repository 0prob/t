import type { CompatDatabase } from "./connection.ts";

export function upsertTokenMeta(db: CompatDatabase, address: string, symbol: string, name: string, decimals: number) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.statement(
    "upsertTokenMeta",
    `INSERT INTO token_meta (address, symbol, name, decimals, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       symbol     = COALESCE(?, token_meta.symbol),
       name       = COALESCE(?, token_meta.name),
       decimals   = ?,
       updated_at = ?`,
  );
  return stmt.run(address, symbol, name, decimals, now, symbol, name, decimals, now);
}

export function getTokenMeta(db: CompatDatabase, address: string) {
  const stmt = db.statement("getTokenMeta", `SELECT * FROM token_meta WHERE address = ?`);
  return (stmt.get(address) as Record<string, unknown> | undefined) ?? null;
}

export function getAllTokenMeta(db: CompatDatabase) {
  const rows = db.statement("getAllTokenMeta", `SELECT * FROM token_meta ORDER BY address`).all() as Record<string, unknown>[];
  return rows;
}

export function upsertPoolFeeTier(db: CompatDatabase, poolAddress: string, tokenAddress: string, feeTier: number) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.statement(
    "upsertPoolFeeTier",
    `INSERT INTO pool_fees (pool_address, token_address, fee_tier, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pool_address) DO UPDATE SET
       token_address = ?,
       fee_tier      = ?,
       updated_at    = ?`,
  );
  return stmt.run(poolAddress, tokenAddress, feeTier, now, tokenAddress, feeTier, now);
}

export function getPoolFeeTier(db: CompatDatabase, poolAddress: string) {
  const stmt = db.statement("getPoolFeeTier", `SELECT * FROM pool_fees WHERE pool_address = ?`);
  return (stmt.get(poolAddress) as Record<string, unknown> | undefined) ?? null;
}
