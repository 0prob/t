import type { FoundCycle } from "./finder.ts";
import type { RouteStateCache } from "../../core/types/route.ts";
import { simulateHop } from "./simulator.ts";
import { simulateRoute } from "./simulator.ts";
import { computeProfit } from "../../core/assessment/profit.ts";
import { FlashLoanSource } from "../../core/types/execution.ts";
import type { ProfitAssessment } from "../../core/types/execution.ts";

export interface LargeSwapSignal {
  txHash: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  estimatedSwapSize: bigint;
  protocol?: string;
}

export interface BackrunCandidate {
  signal: LargeSwapSignal;
  cycle: FoundCycle;
  result: {
    profit: bigint;
    amountIn: bigint;
    totalGas: number;
  };
  assessment: ProfitAssessment;
}

export interface BackrunnerOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRate: bigint;
  maxHops: number;
}

/**
 * Backrunner evaluates whether a large pending swap creates an arbitrage opportunity.
 *
 * Strategy:
 * 1. Given a large swap on a pool, the post-swap reserves will be imbalanced
 * 2. This creates an opportunity to trade back through the same pool or via other pools
 * 3. We search for 2-hop cycles (A->B->A) involving the affected pool
 */
export class Backrunner {
  constructor(private options: BackrunnerOptions) {}

  evaluate(
    signal: LargeSwapSignal,
    stateCache: RouteStateCache,
    enumerateCyclesFn: (startToken: string, maxHops: number) => FoundCycle[],
  ): BackrunCandidate | null {
    // Step 1: Get current pool state
    const poolAddr = signal.poolAddress.toLowerCase();
    const state = stateCache.get(poolAddr);
    if (!state) return null;

    // Step 2: Estimate post-swap state
    const simulatedSwap = simulateHop(
      {
        poolAddress: signal.poolAddress,
        tokenIn: signal.tokenIn,
        tokenOut: signal.tokenOut,
        protocol: signal.protocol ?? "UNISWAP_V2",
        zeroForOne: true,
        stateRef: state,
      },
      signal.estimatedSwapSize,
      stateCache,
    );
    if (!simulatedSwap) return null;

    // Step 3: Build a temporary state cache with the post-swap reserves
    // For V2 pools, the post-swap state has (reserve0 + amountIn, reserve1 - amountOut)
    // when zeroForOne=true (tokenIn === token0)
    const tempCache = new Map(stateCache);
    const reserve0 = (state as Record<string, unknown>).reserve0 as bigint | undefined;
    const reserve1 = (state as Record<string, unknown>).reserve1 as bigint | undefined;
    if (reserve0 !== undefined && reserve1 !== undefined) {
      tempCache.set(poolAddr, {
        ...state,
        reserve0: reserve0 + signal.estimatedSwapSize,
        reserve1: reserve1 - simulatedSwap.amountOut,
      });
    }

    // Step 4: Search for arb cycles involving the affected tokens
    const cycles = enumerateCyclesFn(signal.tokenIn, this.options.maxHops);
    const relevantCycles = cycles.filter((c) =>
      c.edges.some((e) => e.poolAddress.toLowerCase() === poolAddr)
    );

    // Step 5: Simulate each relevant cycle with the dislocated state
    for (const cycle of relevantCycles) {
      try {
        const result = simulateRoute(cycle.edges, 10n ** 18n, tempCache);
        const assessment = computeProfit({
          grossProfitInTokens: result.profit,
          amountInTokens: result.amountIn,
          gasUnits: result.totalGas,
          gasPriceWei: this.options.gasPriceWei,
          tokenToMaticRate: this.options.tokenToMaticRate,
          hopCount: cycle.hopCount,
          minProfitMaticWei: this.options.minProfitMaticWei,
          flashLoanSource: FlashLoanSource.BALANCER,
        });
        if (assessment.shouldExecute) {
          return {
            signal,
            cycle,
            result: { profit: result.profit, amountIn: result.amountIn, totalGas: result.totalGas },
            assessment,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}
