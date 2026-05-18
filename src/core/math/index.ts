/**
 * src/math/index.js — Math module barrel export
 */

// Full precision math
export { mulDiv, mulDivRoundingUp, divRoundingUp } from "./full_math.ts";

// Tick ↔ sqrtPrice conversions
export { MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, getSqrtRatioAtTick, getTickAtSqrtRatio } from "./tick_math.ts";

// Sqrt price math
export {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
  getNextSqrtPriceFromAmount0RoundingUp,
  getNextSqrtPriceFromAmount1RoundingDown,
} from "./sqrt_price_math.ts";

// Single-tick swap computation
export { computeSwapStep } from "./swap_math.ts";

// V3 swap simulator
export { simulateV3Swap, quoteV3 } from "./uniswap_v3.ts";

// V2 swap simulator
export { getV2AmountOut, getV2AmountIn, simulateV2Swap, quoteV2 } from "./uniswap_v2.ts";

// Curve math
export { getCurveAmountOut, getCurveAmountIn, simulateCurveSwap } from "./curve.ts";

// Balancer math
export { getBalancerAmountOut, getBalancerAmountIn, simulateBalancerSwap } from "./balancer.ts";

// WOOFi sPMM math
export { getWoofiAmountOut, getWoofiFeeRate, getWoofiEdgeFeeBps, simulateWoofiSwap } from "./woofi.ts";

// DODO vPMM math
export {
  DODO_RSTATE_ONE,
  DODO_RSTATE_ABOVE_ONE,
  DODO_RSTATE_BELOW_ONE,
  getDodoAmountOut,
  getDodoGrossAmountOut,
  simulateDodoSwap,
} from "./dodo.ts";
