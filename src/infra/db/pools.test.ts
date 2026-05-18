import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, CompatDatabase } from "./connection.ts";
import { ensureSchema } from "./schema.ts";
import {
  upsertPoolMeta,
  getPoolMeta,
  getAllActivePools,
  getPoolsByProtocol,
  updatePoolStatus,
  upsertPoolState,
  getPoolState,
} from "./pools.ts";

describe("pools", () => {
  let db: CompatDatabase;

  beforeEach(() => {
    db = createInMemoryDatabase();
    ensureSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("upserts and retrieves pool meta", () => {
    upsertPoolMeta(db, {
      address: "0xabc",
      protocol: "UNISWAP_V3",
      tokens: ["0xaaa", "0xbbb"],
      block: 100,
      tx: "0xtx1",
      metadata: { fee: 3000 },
      status: "active",
    });
    const pool = getPoolMeta(db, "0xabc");
    expect(pool).not.toBeNull();
    expect(pool?.pool_address).toBe("0xabc");
    expect(pool?.protocol).toBe("UNISWAP_V3");
    expect(pool?.block).toBe(100);
  });

  it("upsert updates existing pool", () => {
    upsertPoolMeta(db, {
      address: "0xabc",
      protocol: "UNISWAP_V2",
      tokens: ["0xaaa", "0xbbb"],
      block: 100,
      tx: "0xtx1",
      metadata: {},
      status: "active",
    });
    upsertPoolMeta(db, {
      address: "0xabc",
      protocol: "UNISWAP_V3",
      tokens: ["0xaaa", "0xbbb"],
      block: 200,
      tx: "0xtx2",
      metadata: { fee: 500 },
      status: "active",
    });
    const pool = getPoolMeta(db, "0xabc");
    expect(pool?.protocol).toBe("UNISWAP_V3");
    expect(pool?.block).toBe(200);
  });

  it("returns all active pools", () => {
    upsertPoolMeta(db, {
      address: "0xaaa",
      protocol: "V2",
      tokens: ["0x1", "0x2"],
      block: 1,
      tx: "",
      metadata: {},
      status: "active",
    });
    upsertPoolMeta(db, {
      address: "0xbbb",
      protocol: "V3",
      tokens: ["0x1", "0x3"],
      block: 2,
      tx: "",
      metadata: {},
      status: "removed",
    });
    const active = getAllActivePools(db);
    expect(active).toHaveLength(1);
    expect(active[0].pool_address).toBe("0xaaa");
  });

  it("filters pools by protocol", () => {
    upsertPoolMeta(db, {
      address: "0xa",
      protocol: "V2",
      tokens: ["0x1", "0x2"],
      block: 1,
      tx: "",
      metadata: {},
      status: "active",
    });
    upsertPoolMeta(db, {
      address: "0xb",
      protocol: "V3",
      tokens: ["0x1", "0x3"],
      block: 2,
      tx: "",
      metadata: {},
      status: "active",
    });
    const v2Pools = getPoolsByProtocol(db, "V2");
    expect(v2Pools).toHaveLength(1);
    expect(v2Pools[0].pool_address).toBe("0xa");
  });

  it("marks pool as removed when updating status", () => {
    upsertPoolMeta(db, {
      address: "0xabc",
      protocol: "V2",
      tokens: ["0x1", "0x2"],
      block: 100,
      tx: "0xtx",
      metadata: {},
      status: "active",
    });
    updatePoolStatus(db, "0xabc", "removed", 999);
    const pool = getPoolMeta(db, "0xabc");
    expect(pool?.status).toBe("removed");
    expect(pool?.removed_block).toBe(999);
  });

  it("upserts and retrieves pool state", () => {
    upsertPoolMeta(db, {
      address: "0xabc",
      protocol: "UNISWAP_V2",
      tokens: ["0x1", "0x2"],
      block: 100,
      tx: "0xtx",
      metadata: {},
      status: "active",
    });
    upsertPoolState(db, "0xabc", 200, { reserve0: "1000", reserve1: "2000" });
    const state = getPoolState(db, "0xabc");
    expect(state).not.toBeNull();
    expect(state?.last_updated_block).toBe(200);
    expect(state?.state_data).toHaveProperty("reserve0");
  });
});
