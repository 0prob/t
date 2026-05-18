import { describe, it, expect } from "vitest";
import { mapWithConcurrency, chunk } from "./concurrency.ts";

describe("mapWithConcurrency", () => {
  it("returns empty array for empty input", async () => {
    const result = await mapWithConcurrency([], 4, async (x) => x);
    expect(result).toEqual([]);
  });
  it("maps items preserving order", async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });
  it("respects concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
  it("propagates errors", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow(/boom/);
  });
  it("handles concurrency=1 sequentially", async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (x) => {
      order.push(x);
      return x;
    });
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("chunk", () => {
  it("returns empty array for empty input", () => {
    expect(chunk([], 3)).toEqual([]);
  });
  it("splits into equal chunks", () => {
    expect(chunk([1, 2, 3, 4, 5, 6], 2)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
  it("handles uneven last chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns single chunk if size > length", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });
});
