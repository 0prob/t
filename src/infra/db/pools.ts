import type { CompatDatabase } from "./connection.ts";
import { stringifyWithBigInt, parseJson, rehydrateStateData, poolRowToObject } from "./codec.ts";

export function upsertPoolMeta(db: CompatDatabase, pool: Record<string, unknown>) {
  const stmt = db.statement(
    "upsertPoolMeta",
    `INSERT INTO pools (address, protocol, tokens, created_block, created_tx, metadata, status, removed_block)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       protocol = excluded.protocol,
       tokens   = excluded.tokens,
       created_block = excluded.created_block,
       created_tx    = excluded.created_tx,
       metadata = excluded.metadata,
       status   = excluded.status,
       removed_block = excluded.removed_block`,
  );
  return stmt.run(
    pool.address as string,
    pool.protocol as string,
    stringifyWithBigInt(pool.tokens ?? []),
    (pool.block ?? pool.created_block ?? 0) as number,
    (pool.tx ?? "") as string,
    stringifyWithBigInt(pool.metadata ?? {}),
    (pool.status ?? "active") as string,
    (pool.removed_block ?? null) as number | null,
  );
}

export function getPoolMeta(db: CompatDatabase, address: string) {
  const stmt = db.statement("getPoolMeta", `SELECT * FROM pools WHERE address = ?`);
  const row = stmt.get(address) as Record<string, unknown> | undefined;
  return row ? poolRowToObject(row) : null;
}

export function getAllActivePools(db: CompatDatabase) {
  const rows = db
    .statement("getAllActivePools", `SELECT * FROM pools WHERE status = 'active' ORDER BY address`)
    .all() as Record<string, unknown>[];
  return rows.map(poolRowToObject);
}

export function getPoolsByProtocol(db: CompatDatabase, protocol: string) {
  const rows = db
    .statement("getPoolsByProtocol", `SELECT * FROM pools WHERE protocol = ? ORDER BY address`)
    .all(protocol) as Record<string, unknown>[];
  return rows.map(poolRowToObject);
}

export function updatePoolStatus(db: CompatDatabase, address: string, status: string, removedBlock?: number | null) {
  const stmt = db.statement(
    "updatePoolStatus",
    `UPDATE pools SET status = ?, removed_block = ? WHERE address = ?`,
  );
  return stmt.run(status, removedBlock ?? null, address);
}

export function upsertPoolState(db: CompatDatabase, address: string, block: number, state: unknown) {
  const stmt = db.statement(
    "upsertPoolState",
    `INSERT INTO pool_state (address, last_updated_block, state_data)
     VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       last_updated_block = excluded.last_updated_block,
       state_data         = excluded.state_data
     WHERE excluded.last_updated_block >= pool_state.last_updated_block`,
  );
  return stmt.run(address, block, stringifyWithBigInt(state));
}

export function getPoolState(db: CompatDatabase, address: string) {
  const row = db
    .statement("getPoolState", `SELECT p.protocol, s.* FROM pool_state s JOIN pools p ON p.address = s.address WHERE s.address = ?`)
    .get(address) as Record<string, unknown> | undefined;
  if (!row) return null;
  const protocol = String(row.protocol ?? "");
  const stateData = parseJson(row.state_data, null) as Record<string, unknown> | null;
  return {
    address: row.address as string,
    last_updated_block: row.last_updated_block as number,
    state_data: stateData ? rehydrateStateData(protocol, stateData) : null,
  };
}
