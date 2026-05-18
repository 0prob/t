/**
 * src/math/swap_math.js — Single-tick-range swap computation
 *
 * JavaScript BigInt port of Uniswap V3's SwapMath.sol.
 * Computes the result of a swap within a single tick price range.
 */

import { mulDiv, mulDivRoundingUp } from "./full_math.ts";
import { getAmount0Delta, getAmount1Delta, getNextSqrtPriceFromInput, getNextSqrtPriceFromOutput } from "./sqrt_price_math.ts";

/**
 * Computes the result of swapping some amount in (or out) within a single tick range.
 *
 * This is a direct port of SwapMath.computeSwapStep from Solidity.
 *
 * @param {bigint} sqrtRatioCurrentX96  Current sqrt price
 * @param {bigint} sqrtRatioTargetX96   Target sqrt price (next initialized tick boundary)
 * @param {bigint} liquidity            Usable liquidity in this range
 * @param {bigint} amountRemaining      Remaining input (+) or output (-) amount
 * @param {bigint} feePips              Fee in hundredths of a bip (e.g. 3000n = 0.3%)
 * @returns {{ sqrtRatioNextX96: bigint, amountIn: bigint, amountOut: bigint, feeAmount: bigint }}
 */
export function computeSwapStep(
  sqrtRatioCurrentX96: bigint,
  sqrtRatioTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): { sqrtRatioNextX96: bigint; amountIn: bigint; amountOut: bigint; feeAmount: bigint } {
  const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
  const exactIn = amountRemaining >= 0n;

  let sqrtRatioNextX96: bigint = 0n;
  let amountIn: bigint = 0n;
  let amountOut: bigint = 0n;
  let feeAmount: bigint = 0n;

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(amountRemaining, 1000000n - feePips, 1000000n);

    amountIn = zeroForOne
      ? getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);

    if (amountRemainingLessFee >= amountIn) {
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromInput(sqrtRatioCurrentX96, liquidity, amountRemainingLessFee, zeroForOne);
    }
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);

    if (-amountRemaining >= amountOut) {
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromOutput(sqrtRatioCurrentX96, liquidity, -amountRemaining, zeroForOne);
    }
  }

  const max = sqrtRatioTargetX96 === sqrtRatioNextX96;

  // Recompute amountIn / amountOut based on whether we reached the target
  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
  }

  // Cap the output amount to not exceed the remaining output amount
  if (!exactIn && amountOut > -amountRemaining) {
    amountOut = -amountRemaining;
  }

  // Calculate fee
  if (exactIn && sqrtRatioNextX96 !== sqrtRatioTargetX96) {
    // Didn't reach target — take remainder as fee
    feeAmount = amountRemaining - amountIn;
  } else {
    feeAmount = mulDivRoundingUp(amountIn, feePips, 1000000n - feePips);
  }

  return { sqrtRatioNextX96, amountIn, amountOut, feeAmount };
}
