import { describe, it, expect, vi } from "vitest";
import { Backrunner } from "./backrunner.ts";
import type { LargeSwapSignal, BackrunnerOptions } from "./backrunner.ts";
import type { FoundCycle, SwapEdge } from "./finder.ts";
import type { Address } from "../../core/types/common.ts";

describe("Backrunner", () => {
  it("returns candidate for profitable dislocation across two pools", () => {
    const WETH = "0x1" as Address;
    const USDC = "0x2" as Address;
    const POOL_A = "0xpoolA" as Address; // pool that receives the large swap (dislocated)
    const POOL_B = "0xpoolB" as Address; // normal pool with balanced reserves

    // Both pools start with the same balanced reserves.
    // Pool A gets dislocated by a large WETH->USDC swap.
    const baseState: Record<string, unknown> = {
      token0: WETH,
      token1: USDC,
      reserve0: 10n ** 20n, // 100 WETH
      reserve1: 300_000_000_000n, // 300,000 USDC
    };

    const stateCache = new Map([
      [POOL_A.toLowerCase(), { ...baseState }],
      [POOL_B.toLowerCase(), { ...baseState }],
    ]);

    // Cycle: WETH->USDC on pool B (normal rates), then USDC->WETH on pool A (dislocated, cheap WETH)
    const edge1: SwapEdge = {
      poolAddress: POOL_B,
      protocol: "UNISWAP_V2",
      tokenIn: WETH,
      tokenOut: USDC,
      feeBps: 30n,
    };
    const edge2: SwapEdge = {
      poolAddress: POOL_A,
      protocol: "UNISWAP_V2",
      tokenIn: USDC,
      tokenOut: WETH,
      feeBps: 30n,
    };

    const cycle: FoundCycle = {
      startToken: WETH,
      edges: [edge1, edge2],
      hopCount: 2,
      logWeight: 0.006,
      cumulativeFeeBps: 60n,
    };

    const signal: LargeSwapSignal = {
      txHash: "0xtx",
      poolAddress: POOL_A,
      tokenIn: WETH,
      tokenOut: USDC,
      estimatedSwapSize: 10n ** 19n, // 10 WETH
    };

    const enumerateFn = vi.fn(() => [cycle]);

    const options: BackrunnerOptions = {
      minProfitMaticWei: 1n,
      gasPriceWei: 30_000_000_000n,
      tokenToMaticRate: 500_000_000_000n,
      maxHops: 2,
    };

    const runner = new Backrunner(options);
    const result = runner.evaluate(signal, stateCache, enumerateFn);

    expect(result).not.toBeNull();
    expect(result!.signal.txHash).toBe("0xtx");
    expect(result!.cycle.edges).toHaveLength(2);
    expect(result!.cycle.edges[0].poolAddress).toBe(POOL_B);
    expect(result!.cycle.edges[1].poolAddress).toBe(POOL_A);
    expect(result!.result.profit).toBeGreaterThan(0n);
    expect(result!.assessment.shouldExecute).toBe(true);
  });
});
