import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, CompatDatabase } from "./connection.ts";

describe("connection", () => {
  let db: CompatDatabase;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it("creates in-memory database and executes SQL", () => {
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO test VALUES (1, 'hello')");
    const row = db.prepare("SELECT name FROM test WHERE id = ?").get(1) as { name: string };
    expect(row.name).toBe("hello");
  });

  it("executes PRAGMA statements", () => {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    const mode = db.pragmaGet<{ synchronous: number }>("synchronous");
    expect(mode?.synchronous).toBe(1);
  });

  it("handles transaction rollback", () => {
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    const tx = db.transaction(() => {
      db.exec("INSERT INTO test VALUES (1)");
      throw new Error("rollback");
    });
    expect(() => tx()).toThrow("rollback");
    const count = db.prepare("SELECT COUNT(*) as c FROM test").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("caches prepared statements", () => {
    const s1 = db.prepare("SELECT 1 AS x");
    const s2 = db.prepare("SELECT 1 AS x");
    expect(s1).toBe(s2);
  });

  it("throws when using closed database", () => {
    db.close();
    expect(() => db.prepare("SELECT 1")).toThrow("database is closed");
  });

  it("supports named statement caching", () => {
    const s1 = db.statement("testKey", "SELECT 1 AS x");
    const s2 = db.statement("testKey", "SELECT 1 AS x");
    expect(s1).toBe(s2);
  });

  it("throws on named statement key collision", () => {
    db.statement("key", "SELECT 1 AS x");
    expect(() => db.statement("key", "SELECT 2 AS x")).toThrow("key collision");
  });

  it("supports nested transactions via savepoints", () => {
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    const outer = db.transaction(() => {
      db.exec("INSERT INTO test VALUES (1)");
      const inner = db.transaction(() => {
        db.exec("INSERT INTO test VALUES (2)");
      });
      inner();
    });
    outer();
    const rows = db.prepare("SELECT COUNT(*) as c FROM test").get() as { c: number };
    expect(rows.c).toBe(2);
  });

  it("rolls back nested transaction independently", () => {
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    const outer = db.transaction(() => {
      db.exec("INSERT INTO test VALUES (1)");
      const inner = db.transaction(() => {
        db.exec("INSERT INTO test VALUES (2)");
        throw new Error("inner fail");
      });
      expect(() => inner()).toThrow("inner fail");
    });
    outer();
    const rows = db.prepare("SELECT COUNT(*) as c FROM test").get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("rejects async transaction functions", () => {
    const tx = db.transaction(async () => {
      await Promise.resolve();
    });
    expect(() => tx()).toThrow("does not support async");
  });
});
