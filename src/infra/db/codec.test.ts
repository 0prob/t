import { describe, it, expect } from "vitest";
import {
  stringifyWithBigInt,
  parseJson,
  rehydrateStateData,
  rehydrateV3Ticks,
  normalizeAddressForDb,
} from "./codec.ts";

describe("codec", () => {
  describe("stringifyWithBigInt", () => {
    it("converts bigint to string", () => {
      const result = JSON.parse(stringifyWithBigInt({ value: 123456789012345678901234567890n }));
      expect(result.value).toBe("123456789012345678901234567890");
    });

    it("converts Map to object", () => {
      const m = new Map([["a", 1], ["b", 2]]);
      const result = JSON.parse(stringifyWithBigInt({ map: m }));
      expect(result.map).toEqual({ a: 1, b: 2 });
    });

    it("handles plain objects unchanged", () => {
      const result = JSON.parse(stringifyWithBigInt({ hello: "world", num: 42 }));
      expect(result).toEqual({ hello: "world", num: 42 });
    });
  });

  describe("parseJson", () => {
    it("parses valid JSON", () => {
      expect(parseJson('{"a":1}', null)).toEqual({ a: 1 });
    });

    it("returns fallback on invalid JSON", () => {
      expect(parseJson("not json", [])).toEqual([]);
    });

    it("returns fallback on null input", () => {
      expect(parseJson(null, "default")).toBe("default");
    });

    it("returns non-string value as-is", () => {
      expect(parseJson(42, null)).toBe(42);
    });
  });

  describe("rehydrateStateData", () => {
    it("converts string fields to bigint for V2 protocol", () => {
      const data = { reserve0: "1000", reserve1: "2000", fee: "30", feeDenominator: "10000" };
      const result = rehydrateStateData("UNISWAP_V2", data) as Record<string, unknown>;
      expect(result.reserve0).toBe(1000n);
      expect(result.reserve1).toBe(2000n);
      expect(result.fee).toBe(30n);
      expect(result.feeDenominator).toBe(10000n);
    });

    it("converts string fields to bigint for V3 protocol", () => {
      const data = { sqrtPriceX96: "1000000000000000", liquidity: "500000", fee: "3000" };
      const result = rehydrateStateData("UNISWAP_V3", data) as Record<string, unknown>;
      expect(result.sqrtPriceX96).toBe(1000000000000000n);
      expect(result.liquidity).toBe(500000n);
    });

    it("handles plain objects without bigint fields", () => {
      const data = { name: "test", value: 42 };
      const result = rehydrateStateData("UNISWAP_V2", data) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.value).toBe(42);
    });
  });

  describe("rehydrateV3Ticks", () => {
    it("reconstructs Map from array entries", () => {
      const ticks = [
        [-100, { liquidityGross: "1000", liquidityNet: "500" }],
        [0, { liquidityGross: "2000", liquidityNet: "-500" }],
      ];
      const result = rehydrateV3Ticks(ticks);
      expect(result.size).toBe(2);
      expect(result.get(-100)?.liquidityGross).toBe(1000n);
      expect(result.get(0)?.liquidityNet).toBe(-500n);
    });

    it("returns empty Map for null input", () => {
      expect(rehydrateV3Ticks(null).size).toBe(0);
    });
  });

  describe("normalizeAddressForDb", () => {
    it("lowercases address", () => {
      expect(normalizeAddressForDb("0xABC123")).toBe("0xabc123");
    });

    it("handles null-like values", () => {
      expect(normalizeAddressForDb(null)).toBe("");
    });
  });
});
