import type { CompatDatabase } from "./connection.ts";

export const SCHEMA_VERSION = 2;

const TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS pools (
    address TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    tokens TEXT NOT NULL,
    created_block INTEGER NOT NULL,
    created_tx TEXT NOT NULL,
    metadata TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    removed_block INTEGER
  );

  CREATE TABLE IF NOT EXISTS pool_state (
    address TEXT PRIMARY KEY,
    last_updated_block INTEGER NOT NULL,
    state_data TEXT NOT NULL,
    FOREIGN KEY (address) REFERENCES pools(address)
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    block_number INTEGER NOT NULL,
    block_hash TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS rollback_guard (
    checkpoint_id TEXT PRIMARY KEY,
    guard_data TEXT
  );

  CREATE TABLE IF NOT EXISTS token_meta (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    decimals INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS pool_fees (
    pool_address TEXT PRIMARY KEY,
    token_address TEXT,
    fee_tier INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS arb_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_key TEXT,
    profit TEXT,
    gas_cost TEXT,
    executed_at INTEGER,
    success INTEGER,
    details TEXT
  );
`;

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_pools_protocol ON pools(protocol);
  CREATE INDEX IF NOT EXISTS idx_pools_status ON pools(status);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_block ON checkpoints(block_number);
  CREATE INDEX IF NOT EXISTS idx_arb_history_executed ON arb_history(executed_at);
`;

export function ensureSchema(db: CompatDatabase) {
  db.exec(TABLES_SQL);

  const currentVersion = db.pragmaGet<{ user_version: number }>("user_version")?.user_version ?? 0;

  if (currentVersion < 2) {
    applyMigrationV1ToV2(db);
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec(INDEXES_SQL);
}

function applyMigrationV1ToV2(db: CompatDatabase) {
}
