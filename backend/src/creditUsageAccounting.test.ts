import assert from "node:assert/strict";
import test from "node:test";
import {
  balanceDeltaCredits,
  COMPANY_BALANCE_DELTA_SOURCE,
  creditAccountingSource,
  creditsSpentForAccounting,
  hasMeasuredSpend,
  isCountedCreditUsage,
  isCreditExemptJob,
  isUnpricedCreditUsage,
} from "./creditUsageAccounting.js";
import { POD_RUNTIME_SOURCE } from "./podRuntimeCost.js";

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

// Still Images presets run on pods that report no usage, so an unmeasured run
// carries nothing but a flat per-preset estimate. Counting an estimate as spend
// inflates every total it reaches, so such a run stays exempt and displays "--".
// A measured one does not: pod runtime and the balance delta are both
// measurements, and leaving those out understates real spend and keeps the pods
// invisible, which is the problem the exemption was covering for.

test("an unmeasured still image job counts as zero however its credits were recorded", () => {
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

  // A creditsActual from any other source is a projection, not a measurement, so
  // it must not put an exempt job back into the totals either.
  assert.equal(
    creditsSpentForAccounting({
      workflowOptions: stillImage,
      creditsActual: 17,
      creditsActualSource: "local_estimate",
    }),
    0,
  );
});

test("a measured still image job counts for what was measured", () => {
  const stillImage = { stillImage: { categoryId: "pro-upscaler", settings: {} } };

  // Priced from the worker time RunPod reported for this job.
  assert.equal(
    creditsSpentForAccounting({
      workflowOptions: stillImage,
      creditsActual: 41,
      creditsActualSource: POD_RUNTIME_SOURCE,
    }),
    41,
  );

  // The balance delta is the other measurement, and outranks everything else.
  assert.equal(
    creditsSpentForAccounting({
      workflowOptions: stillImage,
      creditsActual: 17,
      creditsActualSource: COMPANY_BALANCE_DELTA_SOURCE,
    }),
    17,
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

test("a measured cost lifts the still image exemption, so it stops being an uncosted run", () => {
  const measured = {
    workflowOptions: { stillImage: { categoryId: "qwen-edit" as const, settings: {} } },
    creditsActual: 9,
    creditsActualSource: POD_RUNTIME_SOURCE,
  };
  assert.equal(isCreditExemptJob(measured), false);
  assert.equal(hasMeasuredSpend(measured), true);

  // Zero is not a measurement: podRuntimeCredits never returns it, so a zero here
  // came from somewhere else and the job stays exempt.
  assert.equal(isCreditExemptJob({ ...measured, creditsActual: 0 }), true);
});

test("a tracker block that priced nothing is not counted as a measured zero", () => {
  // What the tracker returns for a node it has no pricing rule for: the run is
  // there, with its duration, and every figure on it is zero. Reported as spend it
  // reads as "this was free", which is how 199 gpt-image jobs came to claim zero
  // while the company balance fell ~142 credits a run.
  const job = {
    creditUsage: {
      total_estimated_credits: 0,
      total_estimated_usd: 0,
      source: "credit_tracker:prompt_scan",
      rows: [
        {
          node_id: "268",
          class_type: "OpenAIGPTImage1",
          pricing_mode: "unknown",
          duration_seconds: 145.88,
          total_estimated_credits: 0,
          total_estimated_usd: 0,
        },
      ],
    },
  };

  assert.equal(creditsSpentForAccounting(job), 0);
  assert.equal(creditAccountingSource(job), "credit_tracker:prompt_scan:unpriced");
  assert.equal(isUnpricedCreditUsage(job.creditUsage), true);
  assert.equal(isCountedCreditUsage(job.creditUsage), false);
});

test("one priced row is enough to count the block, whatever the rest report", () => {
  const creditUsage = {
    total_estimated_credits: 0,
    source: "credit_tracker:prompt_scan",
    rows: [
      { node_id: "1", pricing_mode: "unknown", total_estimated_credits: 0 },
      { node_id: "2", pricing_mode: "fixed_per_run", total_estimated_credits: 12 },
    ],
  };

  assert.equal(isUnpricedCreditUsage(creditUsage), false);
  assert.equal(isCountedCreditUsage(creditUsage), true);
  // The total is the tracker's own; a row that disagrees with it is not re-summed
  // here, so the job still books what the tracker said it did.
  assert.equal(creditsSpentForAccounting({ creditUsage }), 0);
});

test("a usd-only block is priced, even with zero credits", () => {
  assert.equal(
    isUnpricedCreditUsage({ total_estimated_credits: 0, total_estimated_usd: 0.42, source: "credit_tracker:runtime_price" }),
    false,
  );
});

test("a measured figure survives an unpriced tracker block", () => {
  // Pod runtime priced the worker time; the tracker having no rule for the node
  // does not undo that.
  const job = {
    creditsActual: 9.5,
    creditsActualSource: POD_RUNTIME_SOURCE,
    creditUsage: { total_estimated_credits: 0, source: "credit_tracker:prompt_scan" },
  };

  assert.equal(creditsSpentForAccounting(job), 9.5);
  assert.equal(creditAccountingSource(job), POD_RUNTIME_SOURCE);
});
