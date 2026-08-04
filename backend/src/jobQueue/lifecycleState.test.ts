import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCancellationSettlement,
  assertJobCanBeArchived,
  isExpiredOrphan,
  isTerminalJobStatus,
  markJobCompleted,
  normalizeInterruptedRunpodJob,
} from "./lifecycleState.js";
import type { Job } from "../types.js";

test("terminal status classification matches the persisted Job contract", () => {
  assert.equal(isTerminalJobStatus("queued"), false);
  assert.equal(isTerminalJobStatus("sending"), false);
  assert.equal(isTerminalJobStatus("running"), false);
  assert.equal(isTerminalJobStatus("completed"), true);
  assert.equal(isTerminalJobStatus("failed"), true);
  assert.equal(isTerminalJobStatus("canceled"), true);
});

test("restart safely requeues only a preparing, unacknowledged submission", () => {
  const job = activeJob({ status: "sending", runpodSubmissionState: "preparing", startedAt: "old" });
  assert.equal(normalizeInterruptedRunpodJob(job, { shouldNormalize: true, now: "2026-08-04T12:00:00.000Z" }), true);
  assert.equal(job.status, "queued");
  assert.equal(job.startedAt, undefined);
  assert.equal(job.completedAt, undefined);
  assert.equal(job.runpodSubmissionState, undefined);
});

test("restart fails an ambiguous unacknowledged submission but never resubmits an acknowledged ID", () => {
  const ambiguous = activeJob({ status: "running", runpodSubmissionState: "submitting" });
  assert.equal(normalizeInterruptedRunpodJob(ambiguous, { shouldNormalize: true, now: "2026-08-04T12:00:00.000Z" }), true);
  assert.equal(ambiguous.status, "failed");
  assert.match(ambiguous.errorMessage ?? "", /backend restarted/i);
  assert.equal(ambiguous.creditsUsed, 0);

  const acknowledged = activeJob({ status: "running", runpodJobId: "rp_1", runpodSubmissionState: "submitted" });
  assert.equal(normalizeInterruptedRunpodJob(acknowledged, { shouldNormalize: true, now: "later" }), false);
  assert.equal(acknowledged.status, "running");
});

test("a recent prior-owner execution stays active until takeover normalization is allowed", () => {
  const recent = activeJob({ status: "sending", runpodSubmissionState: "submitting" });
  assert.equal(normalizeInterruptedRunpodJob(recent, { shouldNormalize: false, now: "later" }), false);
  assert.equal(recent.status, "sending");
});

test("cancellation before completion wins and duplicate settlement is idempotent", () => {
  const job = activeJob({ status: "running", cancelRequested: true });
  assert.equal(applyCancellationSettlement(job, "2026-08-04T12:00:00.000Z", "CANCELLED"), true);
  assert.equal(job.status, "canceled");
  assert.equal(job.runpodStatus, "CANCELLED");
  assert.equal(markJobCompleted(job, "later"), false);
  assert.equal(applyCancellationSettlement(job, "later"), false);
  assert.equal(job.completedAt, "2026-08-04T12:00:00.000Z");
});

test("completion immediately before cancellation remains completed", () => {
  const job = activeJob({ status: "running" });
  assert.equal(markJobCompleted(job, "2026-08-04T12:00:00.000Z"), true);
  job.cancelRequested = true;
  assert.equal(applyCancellationSettlement(job, "later"), false);
  assert.equal(job.status, "completed");
});

test("orphan classification excludes active executions and non-active statuses", () => {
  const old = activeJob({ status: "running", startedAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(isExpiredOrphan(old, false, Date.parse("2026-08-04T11:00:00.000Z")), true);
  assert.equal(isExpiredOrphan(old, true, Date.parse("2026-08-04T11:00:00.000Z")), false);
  assert.equal(isExpiredOrphan(activeJob({ status: "queued" }), false, 0), false);
});

test("archive membership accepts only terminal jobs", () => {
  assert.doesNotThrow(() => assertJobCanBeArchived(activeJob({ status: "completed" })));
  assert.throws(
    () => assertJobCanBeArchived(activeJob({ status: "running" })),
    (error: unknown) => {
      return error instanceof Error && /cancel the job/i.test(error.message) && "statusCode" in error && error.statusCode === 409;
    },
  );
});

function activeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_lifecycle",
    projectId: "prj_1",
    userId: "usr_1",
    modelId: "model_1",
    modelName: "Model",
    category: "image_generation",
    inputType: "text_only",
    status: "queued",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "image",
    projectFolderPath: "C:\\projects\\one",
    workflowPath: "workflow.json",
    createdAt: "2026-08-04T09:00:00.000Z",
    ...overrides,
  };
}
