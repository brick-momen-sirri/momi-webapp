import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Job } from "./types.js";

// Regression for a gap found in review: the "preparing"/"submitting" job
// normalization used to run only inside loadJobs() (boot time). A live
// standby dispatcher that wins the lease mid-session -- because the prior
// owner's lease expired while its RunPod /run POST was still in flight --
// never went through loadJobs() again, so a job stuck without a runpodJobId
// was left orphaned forever instead of being requeued or failed. This test
// boots holding no lease (one is already held, validly, by another owner),
// then waits for the poll/heartbeat timers to win it after it expires, and
// asserts the orphaned job is normalized at that point, not just at boot.

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-dispatcher-handoff-it-"));
const jobsJsonPath = path.join(tempDir, "jobs.json");
const jobsSqlitePath = path.join(tempDir, "jobs.sqlite");

process.env.ROLE = "dispatcher";
process.env.GENERATION_BACKEND = "runpod";
process.env.RUNPOD_SUBMISSION_MODE = "async";
process.env.RUNPOD_TIMEOUT_MS = "50";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_ROW_LEVEL_WRITES = "true";
process.env.JOBS_STORE_PATH = jobsJsonPath;
process.env.JOBS_SQLITE_PATH = jobsSqlitePath;
process.env.JOBS_ARCHIVED_PATH = path.join(tempDir, "archived-items.json");
process.env.JOBS_ARCHIVED_SQLITE_PATH = path.join(tempDir, "archived-items.sqlite");
process.env.DISPATCHER_POLL_INTERVAL_MS = "20";
process.env.DISPATCHER_LEASE_HEARTBEAT_MS = "40";
process.env.DISPATCHER_LEASE_TTL_MS = "200";
process.env.DISPATCHER_WAL_CHECKPOINT_MS = "0";

writeFileSync(jobsJsonPath, "[]", "utf8");

const { openSqliteJobStore } = await import("./sqliteJobStore.js");
const seeded = openSqliteJobStore(jobsSqlitePath);
const orphaned = job("job_orphaned_submission", {
  status: "running",
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  runpodSubmissionState: "submitting",
});
seeded.insertJob(orphaned);

// Still valid at boot, held by a different process, expiring a few seconds
// later. This process must NOT win it during loadJobs() -- the takeover has
// to happen later, through the poll/heartbeat timers, to exercise the
// mid-session path instead of the already-covered boot path. The window is
// generous because loadJobs() runs after the dynamic import of jobQueue.js
// below, whose module-graph compile time (via tsx) is not free.
const priorLeaseExpiresAt = Date.now() + 4_000;
seeded.tryAcquireDispatcherLease({
  ownerId: "prior-host:123:prior-owner",
  ownerPid: 123,
  ownerHost: "prior-host",
  heartbeatAt: Date.now(),
  expiresAt: priorLeaseExpiresAt,
  now: Date.now(),
});
seeded.close();

const jobQueue = await import("./jobQueue.js");

after(() => {
  jobQueue.closeJobStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL handles briefly; the OS temp dir is transient.
  }
});

test("a mid-session lease takeover normalizes a job orphaned by the prior owner", async () => {
  await jobQueue.loadJobs();

  assert.ok(
    Date.now() < priorLeaseExpiresAt,
    "test setup: the prior lease must still have time left when loadJobs() runs -- increase the buffer above if this fails on a slow machine",
  );
  assert.equal(
    jobQueue.getQueueSnapshot().dispatcher.heldByThisProcess,
    false,
    "boot must not win a still-valid lease held by another owner",
  );
  assert.equal(jobQueue.getJob(orphaned.id)?.status, "running");

  const tookOver = await waitFor(() => jobQueue.getQueueSnapshot().dispatcher.heldByThisProcess, 8_000);
  assert.equal(tookOver, true, "the poll/heartbeat timer should win the lease once it expires");

  const reader = openSqliteJobStore(jobsSqlitePath, "jobs", { readonly: true });
  const normalized = await waitFor(() => reader.loadById(orphaned.id)?.status === "failed", 2_000);
  assert.equal(normalized, true, "the orphaned submission must be failed on takeover, not left running forever");
  assert.match(reader.loadById(orphaned.id)?.errorMessage ?? "", /restarted|retry/i);
  reader.close();
});

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    projectId: "prj_1",
    userId: "usr_1",
    modelId: "model_1",
    modelName: "Model",
    category: "image_generation",
    inputType: "text_only",
    status: "completed",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "image",
    projectFolderPath: "C:\\projects\\1234_Client_Project",
    workflowPath: "workflow.json",
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
