import { describe, it, expect } from "vitest";
import { normalizeEvmAddress, isEvmAddress, normalizeProtocolKey, isRecord, isPolygonSystemContract, ZERO_ADDRESS, isFastEvmAddress } from "./identity.ts";

describe("normalizeEvmAddress", () => {
  it("lowercases and validates valid addresses", () => {
    expect(normalizeEvmAddress("0xABCdef1234567890abcDEF1234567890abcdEF12"))
      .toBe("0xabcdef1234567890abcdef1234567890abcdef12");
  });
  it("trims whitespace", () => {
    expect(normalizeEvmAddress("  0xABCdef1234567890abcDEF1234567890abcdEF12  "))
      .toBe("0xabcdef1234567890abcdef1234567890abcdef12");
  });
  it("returns null for non-strings", () => {
    expect(normalizeEvmAddress(123)).toBeNull();
    expect(normalizeEvmAddress(null)).toBeNull();
    expect(normalizeEvmAddress(undefined)).toBeNull();
  });
  it("returns null for wrong length", () => {
    expect(normalizeEvmAddress("0xabc")).toBeNull();
    expect(normalizeEvmAddress("0x" + "a".repeat(41))).toBeNull();
  });
  it("returns null for non-hex characters", () => {
    expect(normalizeEvmAddress("0x" + "z".repeat(40))).toBeNull();
  });
  it("returns null for zero address by default", () => {
    expect(normalizeEvmAddress(ZERO_ADDRESS)).toBeNull();
  });
  it("allows zero address when option set", () => {
    expect(normalizeEvmAddress(ZERO_ADDRESS, { allowZero: true })).toBe(ZERO_ADDRESS);
  });
});

describe("isFastEvmAddress", () => {
  it("returns true for valid lowercase hex", () => {
    expect(isFastEvmAddress("0xabcdef1234567890abcdef1234567890abcdef12")).toBe(true);
  });
  it("returns true for valid uppercase hex", () => {
    expect(isFastEvmAddress("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(true);
  });
  it("returns false for wrong length", () => {
    expect(isFastEvmAddress("0xabc")).toBe(false);
  });
});

describe("normalizeProtocolKey", () => {
  it("uppercases and trims", () => {
    expect(normalizeProtocolKey("  uniswap_v2  ")).toBe("UNISWAP_V2");
  });
  it("handles null and undefined", () => {
    expect(normalizeProtocolKey(null)).toBe("");
    expect(normalizeProtocolKey(undefined)).toBe("");
  });
});

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });
  it("returns false for primitives", () => {
    expect(isRecord(42)).toBe(false);
    expect(isRecord("hello")).toBe(false);
  });
});

describe("isPolygonSystemContract", () => {
  it("detects 0x02-0x0f prefix system contracts", () => {
    expect(isPolygonSystemContract("0x0200000000000000000000000000000000000000")).toBe(true);
    expect(isPolygonSystemContract("0x0f00000000000000000000000000000000000000")).toBe(true);
    expect(isPolygonSystemContract("0x0000000000000000000000000000000000001010")).toBe(false);
  });
  it("returns false for user contracts", () => {
    expect(isPolygonSystemContract("0xabcdef1234567890abcdef1234567890abcdef12")).toBe(false);
  });
});

describe("isEvmAddress", () => {
  it("matches normalizeEvmAddress validity", () => {
    expect(isEvmAddress("0xabcdef1234567890abcdef1234567890abcdef12")).toBe(true);
    expect(isEvmAddress("not an address")).toBe(false);
  });
});
