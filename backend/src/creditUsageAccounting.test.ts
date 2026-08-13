import assert from "node:assert/strict";
import test from "node:test";
import {
  balanceDeltaCredits,
  COMPANY_BALANCE_DELTA_SOURCE,
  creditAccountingSource,
  creditsSpentForAccounting,
  isCreditExemptJob,
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

// Still Images presets run on pods that report no usage, so the only figure they
// ever carried was a flat per-preset estimate. Counting an estimate as spend
// inflates every total it reaches, so they are exempt and display "--".

test("still image jobs count as zero however their credits were recorded", () => {
  const stillImage = { stillImage: { categoryId: "reference-generator", settings: {} } };

  // A tracked estimate, the usual shape for these.
  assert.equal(
    creditsSpentForAccounting({
      workflowOptions: stillImage,
      creditsUsed: 10,
      creditUsage: { total_estimated_credits: 10, source: "credit_tracker:runtime_price" },
    }),
    0,
  );

  // Even a measured company-balance delta, which outranks everything else for a
  // normal job, must not put a still image job back into the totals.
  assert.equal(
    creditsSpentForAccounting({
      workflowOptions: stillImage,
      creditsActual: 17,
      creditsActualSource: COMPANY_BALANCE_DELTA_SOURCE,
    }),
    0,
  );
});

test("animation jobs are unaffected by the still image exemption", () => {
  assert.equal(
    creditsSpentForAccounting({
      workflowOptions: { save: { shotNumber: "0007" } },
      creditsUsed: 32,
      creditUsage: { total_estimated_credits: 32, source: "credit_tracker:runtime_price" },
    }),
    32,
  );
});

test("isCreditExemptJob keys off the still image marker, not the model name", () => {
  // Same marker jobSection uses, so the exemption and the workspace split can
  // never disagree about what a still image job is.
  assert.equal(isCreditExemptJob({ workflowOptions: { stillImage: { categoryId: "qwen-edit", settings: {} } } }), true);
  assert.equal(isCreditExemptJob({ workflowOptions: { save: { cameraNumber: "0001" } } }), false);
  assert.equal(isCreditExemptJob({}), false);
});
