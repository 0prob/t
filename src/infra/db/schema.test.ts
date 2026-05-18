import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, CompatDatabase } from "./connection.ts";
import { ensureSchema, SCHEMA_VERSION } from "./schema.ts";

describe("schema", () => {
  let db: CompatDatabase;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it("creates all tables", () => {
    ensureSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toContain("pools");
    expect(tableNames).toContain("pool_state");
    expect(tableNames).toContain("checkpoints");
    expect(tableNames).toContain("rollback_guard");
    expect(tableNames).toContain("token_meta");
    expect(tableNames).toContain("pool_fees");
    expect(tableNames).toContain("arb_history");
  });

  it("creates indexes", () => {
    ensureSchema(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_pools_protocol");
    expect(indexNames).toContain("idx_pools_status");
    expect(indexNames).toContain("idx_checkpoints_block");
    expect(indexNames).toContain("idx_arb_history_executed");
  });

  it("sets schema version", () => {
    ensureSchema(db);
    const version = db.pragmaGet<{ user_version: number }>("user_version");
    expect(version?.user_version).toBe(SCHEMA_VERSION);
  });

  it("is idempotent when run multiple times", () => {
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
    const version = db.pragmaGet<{ user_version: number }>("user_version");
    expect(version?.user_version).toBe(SCHEMA_VERSION);
  });

  it("pools table has correct columns", () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info(pools)").all() as { name: string; type: string; pk: number }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("address");
    expect(colNames).toContain("protocol");
    expect(colNames).toContain("tokens");
    expect(colNames).toContain("created_block");
    expect(colNames).toContain("created_tx");
    expect(colNames).toContain("metadata");
    expect(colNames).toContain("status");
    expect(colNames).toContain("removed_block");
    const addrCol = cols.find((c) => c.name === "address");
    expect(addrCol?.pk).toBe(1);
  });

  it("arb_history has autoincrement id", () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info(arb_history)").all() as { name: string; pk: number }[];
    const idCol = cols.find((c) => c.name === "id");
    expect(idCol?.pk).toBe(1);
  });
});
