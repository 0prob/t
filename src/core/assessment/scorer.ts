import type { EvaluatedRoute, RouteSimulationResult } from "../types/route.ts";

export interface ScoringWeights {
  profitWeight: number;
  efficiencyWeight: number;
  gasWeight: number;
  hopPenalty: number;
  diversityBonus: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  profitWeight: 1.0,
  efficiencyWeight: 0.5,
  gasWeight: 0.2,
  hopPenalty: 0.1,
  diversityBonus: 0.05,
};

/**
 * Compute a composite score for ranking routes.
 * Higher score = better candidate.
 *
 * Pure function. Takes a result + weights, returns a number.
 */
export function scoreRoute(result: RouteSimulationResult, weights: ScoringWeights = DEFAULT_WEIGHTS): number {
  if (result.amountIn <= 0n) return -Infinity;
  const profit = Number(result.profit);
  const amountIn = Number(result.amountIn);
  const efficiency = amountIn > 0 ? profit / amountIn : 0;
  const gas = result.totalGas;
  const hops = result.hopCount;
  const uniqueProtocols = new Set(result.protocols).size;

  return (
    weights.profitWeight * Math.log10(Math.max(1, Math.abs(profit) + 1)) * Math.sign(profit)
    + weights.efficiencyWeight * efficiency * 100
    - weights.gasWeight * Math.log10(Math.max(1, gas))
    - weights.hopPenalty * hops
    + weights.diversityBonus * uniqueProtocols
  );
}

/** Rank a list of evaluated routes by score (highest first). */
export function rankRoutes(routes: EvaluatedRoute[], weights?: ScoringWeights): EvaluatedRoute[] {
  return [...routes].sort((a, b) => scoreRoute(b.result, weights) - scoreRoute(a.result, weights));
}
