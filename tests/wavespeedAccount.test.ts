import test from "node:test";
import assert from "node:assert/strict";

import { extractWaveSpeedBalanceSummary } from "../src/wavespeedAccount.ts";

test("extractWaveSpeedBalanceSummary reads remaining credits from top-level payload", () => {
  const summary = extractWaveSpeedBalanceSummary({
    credits: 18.75,
    account_level: "bronze",
  });

  assert.deepEqual(summary, {
    remainingCredits: 18.75,
    planName: "bronze",
  });
});

test("extractWaveSpeedBalanceSummary reads nested remaining credits variants", () => {
  const summary = extractWaveSpeedBalanceSummary({
    data: {
      wallet: {
        available_credits: 6,
      },
      accountLevel: "silver",
    },
  });

  assert.deepEqual(summary, {
    remainingCredits: 6,
    planName: "silver",
  });
});

test("extractWaveSpeedBalanceSummary falls back when no credit field exists", () => {
  const summary = extractWaveSpeedBalanceSummary({
    data: {
      user: {
        email: "ops@example.com",
      },
    },
  });

  assert.deepEqual(summary, {
    remainingCredits: undefined,
    planName: undefined,
  });
});

test("extractWaveSpeedBalanceSummary reads official balance payload shape", () => {
  const summary = extractWaveSpeedBalanceSummary({
    code: 200,
    message: "Success",
    data: {
      balance: 395.5,
    },
  });

  assert.deepEqual(summary, {
    remainingCredits: 395.5,
    planName: undefined,
  });
});
