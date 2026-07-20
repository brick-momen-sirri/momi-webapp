import assert from "node:assert/strict";
import test from "node:test";
import {
  balanceDeltaCredits,
  COMPANY_BALANCE_DELTA_SOURCE,
  creditAccountingSource,
  creditsSpentForAccounting,
} from "./creditUsageAccounting.js";

test("company balance delta is preferred over tracker usage", () => {
  const job = {
    creditsActual: 17,
    creditsActualSource: COMPANY_BALANCE_DELTA_SOURCE,
    creditsUsed: 20,
    creditUsage: {
      total_estimated_credits: 20,
      source: "credit_tracker:runtime_price",
    },
  };

  assert.equal(creditsSpentForAccounting(job), 17);
  assert.equal(creditAccountingSource(job), COMPANY_BALANCE_DELTA_SOURCE);
});

test("tracker usage counts when no balance delta is available", () => {
  const job = {
    creditsUsed: 32.1733,
    creditUsage: {
      total_estimated_credits: 32.1733,
      source: "credit_tracker:runtime_price",
    },
  };

  assert.equal(creditsSpentForAccounting(job), 32.17);
  assert.equal(creditAccountingSource(job), "credit_tracker:runtime_price");
});

test("local fallback estimates are not counted as actual spend", () => {
  const job = {
    creditsUsed: 443,
    creditUsage: {
      total_estimated_credits: 443,
      source: "local_kling_estimate",
    },
  };

  assert.equal(creditsSpentForAccounting(job), 0);
  assert.equal(creditAccountingSource(job), "local_kling_estimate:not_counted");
});

test("legacy stored credits count when no credit usage payload exists", () => {
  assert.equal(creditsSpentForAccounting({ creditsUsed: 14.7 }), 14.7);
});

test("balance deltas require matching sources and a lower after balance", () => {
  assert.equal(
    balanceDeltaCredits(
      { creditsLeft: 100, source: "http://127.0.0.1:8160/abuomar_credit", capturedAt: "2026-07-15T10:00:00.000Z" },
      { creditsLeft: 82.5, source: "http://127.0.0.1:8160/abuomar_credit", capturedAt: "2026-07-15T10:02:00.000Z" },
    ),
    17.5,
  );
  assert.equal(
    balanceDeltaCredits(
      { creditsLeft: 100, source: "source-a", capturedAt: "2026-07-15T10:00:00.000Z" },
      { creditsLeft: 82, source: "source-b", capturedAt: "2026-07-15T10:02:00.000Z" },
    ),
    undefined,
  );
  assert.equal(
    balanceDeltaCredits(
      { creditsLeft: 82, source: "source-a", capturedAt: "2026-07-15T10:00:00.000Z" },
      { creditsLeft: 100, source: "source-a", capturedAt: "2026-07-15T10:02:00.000Z" },
    ),
    undefined,
  );
});
