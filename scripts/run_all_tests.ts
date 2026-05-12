import assert from "node:assert/strict";

import { computeProfit } from "../src/arb/profit_compute.ts";
import { expectedProfitWei } from "../src/execution/send_tx.ts";
import type { BuiltTx } from "../src/execution/build_tx.ts";

function testComputeProfitConvertsGasToStartTokenUnits() {
  const assessment = computeProfit(
    {
      amountIn: 1_000_000n,
      amountOut: 1_020_000n,
      profit: 20_000n,
      totalGas: 100_000,
      hopCount: 2,
    },
    {
      gasPriceWei: 30_000_000_000n,
      tokenToMaticRate: 1_000_000_000_000n,
      slippageBps: 0n,
      revertRiskBps: 0n,
      minNetProfit: 0n,
    },
  );

  assert.equal(assessment.gasCostWei, 3_000_000_000_000_000n);
  assert.equal(assessment.gasCostInTokens, 3_000n);
  assert.equal(assessment.netProfitAfterGas, 17_000n);
  assert.equal(assessment.shouldExecute, true);
}

function testComputeProfitRejectsUnprofitableAfterGas() {
  const assessment = computeProfit(
    {
      amountIn: 1_000_000n,
      amountOut: 1_002_000n,
      profit: 2_000n,
      totalGas: 100_000,
      hopCount: 2,
    },
    {
      gasPriceWei: 30_000_000_000n,
      tokenToMaticRate: 1_000_000_000_000n,
      slippageBps: 0n,
      revertRiskBps: 0n,
      minNetProfit: 0n,
    },
  );

  assert.equal(assessment.gasCostInTokens, 3_000n);
  assert.equal(assessment.netProfitAfterGas, -1_000n);
  assert.equal(assessment.shouldExecute, false);
}

function testExecutionProfitUsesNormalizedWeiMetadata() {
  const tx = {
    meta: {
      expectedProfit: "1000",
      expectedProfitWei: "1000000000000000000",
    },
  } as BuiltTx;

  assert.equal(expectedProfitWei(tx), 1_000_000_000_000_000_000n);
}

function testExecutionProfitFallsBackForLegacyMetadata() {
  const tx = {
    meta: {
      expectedProfit: "12345",
    },
  } as BuiltTx;

  assert.equal(expectedProfitWei(tx), 12_345n);
}

testComputeProfitConvertsGasToStartTokenUnits();
testComputeProfitRejectsUnprofitableAfterGas();
testExecutionProfitUsesNormalizedWeiMetadata();
testExecutionProfitFallsBackForLegacyMetadata();

import "./test_profitability_scenarios.ts";
