import type { CompatDatabase } from "./connection.ts";

export function saveCheckpoint(db: CompatDatabase, id: string, blockNumber: number, blockHash: string) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.statement(
    "saveCheckpoint",
    `INSERT INTO checkpoints (id, block_number, block_hash, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  return stmt.run(id, blockNumber, blockHash, now);
}

export function getCheckpoint(db: CompatDatabase, id: string) {
  const stmt = db.statement("getCheckpoint", `SELECT * FROM checkpoints WHERE id = ?`);
  return (stmt.get(id) as Record<string, unknown> | undefined) ?? null;
}

export function getLatestCheckpoint(db: CompatDatabase) {
  const stmt = db.statement(
    "getLatestCheckpoint",
    `SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 1`,
  );
  return (stmt.get() as Record<string, unknown> | undefined) ?? null;
}

export function rollbackToCheckpoint(db: CompatDatabase, checkpointId: string) {
  const checkpoint = getCheckpoint(db, checkpointId);
  if (!checkpoint) return { poolsRemoved: 0, statesRemoved: 0 };

  const blockNumber = checkpoint.block_number as number;
  const removeState = db.statement(
    "rollbackRemoveState",
    `DELETE FROM pool_state WHERE last_updated_block >= ?`,
  );
  const removePools = db.statement(
    "rollbackRemovePools",
    `UPDATE pools SET status = 'removed', removed_block = ? WHERE created_block >= ?`,
  );

  return db.transaction(() => {
    const stateResult = removeState.run(blockNumber);
    const poolResult = removePools.run(blockNumber, blockNumber);
    return {
      poolsRemoved: Number(poolResult.changes ?? 0),
      statesRemoved: Number(stateResult.changes ?? 0),
    };
  })();
}

export function getBlockRangeForReorg(db: CompatDatabase, fromCheckpoint: string, toBlock: number) {
  const stmt = db.statement(
    "getBlockRangeForReorg",
    `SELECT * FROM checkpoints WHERE id = ? AND block_number <= ?`,
  );
  return stmt.get(fromCheckpoint, toBlock) as Record<string, unknown> | undefined;
}
