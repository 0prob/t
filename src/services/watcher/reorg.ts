import { detectReorg } from "../../state/reorg_detect.ts";
import type { CompatDatabase } from "../../infra/db/connection.ts";
import { getCheckpoint, saveCheckpoint } from "../../infra/db/checkpoints.ts";
import { upsertPoolState } from "../../infra/db/pools.ts";

export type RollbackGuard = Record<string, unknown>;

export type ReorgResult =
  | { reorgDetected: false }
  | {
      reorgDetected: true;
      reorgBlock: number;
      checkpointBlock: number;
      statesRemoved: number;
    };

export function checkReorg(
  db: CompatDatabase,
  registry: { getRollbackGuard?: () => unknown; setRollbackGuard?: (guard: RollbackGuard) => unknown },
  rollbackGuard: RollbackGuard | null | undefined,
): ReorgResult {
  if (!rollbackGuard) return { reorgDetected: false };
  const reorgBlock = detectReorg(registry, rollbackGuard);
  if (reorgBlock === false) {
    registry.setRollbackGuard?.(rollbackGuard);
    return { reorgDetected: false };
  }
  const checkpointBlock = Math.max(0, reorgBlock - 1);
  const statesRemoved = rollbackToBlock(db, "HYPERSYNC_WATCHER", checkpointBlock);
  registry.setRollbackGuard?.(rollbackGuard);
  return {
    reorgDetected: true,
    reorgBlock,
    checkpointBlock,
    statesRemoved,
  };
}

export function rollbackToBlock(db: CompatDatabase, checkpointKey: string, targetBlock: number): number {
  const checkpoint = getCheckpoint(db, checkpointKey);
  if (!checkpoint) return 0;
  const stmt = db.statement(
    "rollbackRemoveState",
    `DELETE FROM pool_state WHERE last_updated_block >= ?`,
  );
  const result = stmt.run(targetBlock);
  return Number(result.changes ?? 0);
}

export function saveWatcherCheckpoint(db: CompatDatabase, blockNumber: number, blockHash: string) {
  saveCheckpoint(db, "HYPERSYNC_WATCHER", blockNumber, blockHash);
}
