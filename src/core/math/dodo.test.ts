import { describe, it, expect } from "vitest";
import { simulateDodoSwap, DODO_RSTATE_ONE } from "./dodo.ts";

describe("simulateDodoSwap", () => {
  it("returns positive output for balanced pool at R=ONE", () => {
    const state = {
      baseReserve: 1_000_000_000_000_000_000n,
      quoteReserve: 1_000_000_000_000_000_000n,
      baseTarget: 1_000_000_000_000_000_000n,
      quoteTarget: 1_000_000_000_000_000_000n,
      i: 1_000_000_000_000_000_000n,
      k: 100_000_000_000_000_000n,
      rState: DODO_RSTATE_ONE,
      lpFeeRate: 0n,
      mtFeeRate: 0n,
    };
    const result = simulateDodoSwap(state, 1_000_000n, true);
    expect(result.amountOut).toBeGreaterThan(0n);
  });
});
