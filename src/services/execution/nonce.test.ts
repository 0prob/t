import { describe, it, expect, vi } from "vitest";
import { NonceManager } from "./nonce.ts";

describe("NonceManager", () => {
  it("initializes by fetching on-chain nonce", async () => {
    const fetchNonce = vi.fn().mockResolvedValue(5);
    const nm = new NonceManager("0xabc", fetchNonce);
    expect(fetchNonce).not.toHaveBeenCalled();
    await nm.initialize();
    expect(fetchNonce).toHaveBeenCalledWith("0xabc");
    expect(nm.expectedNextNonce).toBe(5);
  });

  it("getNextNonce increments locally", async () => {
    const fetchNonce = vi.fn().mockResolvedValue(10);
    const nm = new NonceManager("0xabc", fetchNonce);
    await nm.initialize();
    expect(nm.getNextNonce()).toBe(10);
    expect(nm.getNextNonce()).toBe(11);
    expect(nm.getNextNonce()).toBe(12);
    expect(nm.expectedNextNonce).toBe(13);
  });

  it("throws when not initialized", () => {
    const nm = new NonceManager("0xabc", () => Promise.resolve(0));
    expect(() => nm.getNextNonce()).toThrow("NonceManager not initialized");
  });

  it("confirmNonce updates local state", async () => {
    const fetchNonce = vi.fn().mockResolvedValue(7);
    const nm = new NonceManager("0xabc", fetchNonce);
    await nm.initialize();
    nm.getNextNonce(); // 7
    nm.getNextNonce(); // 8
    await nm.confirmNonce(8); // confirmed nonce 8
    expect(nm.expectedNextNonce).toBe(9); // 8 + 1 + 0 pending
  });

  it("resync re-fetches from chain", async () => {
    const fetchNonce = vi.fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5);
    const nm = new NonceManager("0xabc", fetchNonce);
    await nm.initialize();
    expect(nm.expectedNextNonce).toBe(3);
    await nm.resync();
    expect(nm.expectedNextNonce).toBe(5);
  });

  it("expectedNextNonce returns null before init", () => {
    const nm = new NonceManager("0xabc", () => Promise.resolve(0));
    expect(nm.expectedNextNonce).toBeNull();
  });
});
