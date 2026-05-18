import { describe, it, expect } from "vitest";
import { WatcherFilter } from "./filter.ts";

describe("WatcherFilter", () => {
  it("adds and retrieves addresses", () => {
    const f = new WatcherFilter();
    f.add(["0xabc", "0xDEF"]);
    expect(f.getAll()).toContain("0xabc");
    expect(f.getAll()).toContain("0xdef");
  });

  it("deduplicates addresses", () => {
    const f = new WatcherFilter();
    f.add(["0xabc"]);
    f.add(["0xabc"]);
    expect(f.size).toBe(1);
  });

  it("removes addresses", () => {
    const f = new WatcherFilter();
    f.add(["0xabc"]);
    f.remove(["0xabc"]);
    expect(f.size).toBe(0);
  });

  it("chunks large address sets", () => {
    const f = new WatcherFilter();
    const addrs = Array.from({ length: 30_000 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
    f.add(addrs);
    expect(f.getChunks().length).toBeGreaterThan(1);
  });
});
