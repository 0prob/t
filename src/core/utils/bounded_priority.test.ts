import { describe, it, expect } from "vitest";
import { takeTopNBy } from "./bounded_priority.ts";

describe("takeTopNBy", () => {
  it("returns empty array for empty input", () => {
    expect(takeTopNBy([], 5, (a, b) => a - b)).toEqual([]);
  });
  it("returns empty array for limit <= 0", () => {
    expect(takeTopNBy([1, 2, 3], 0, (a, b) => a - b)).toEqual([]);
  });
  it("returns sorted top N (ascending)", () => {
    expect(takeTopNBy([5, 2, 8, 1, 9, 3], 3, (a, b) => a - b)).toEqual([1, 2, 3]);
  });
  it("works with object items", () => {
    const items = [{ p: 5 }, { p: 1 }, { p: 9 }, { p: 3 }];
    expect(takeTopNBy(items, 2, (a, b) => b.p - a.p)).toEqual([{ p: 9 }, { p: 5 }]);
  });
  it("works with generators", () => {
    function* gen() { yield 5; yield 1; yield 9; yield 3; }
    expect(takeTopNBy(gen(), 2, (a, b) => a - b)).toEqual([1, 3]);
  });
});
