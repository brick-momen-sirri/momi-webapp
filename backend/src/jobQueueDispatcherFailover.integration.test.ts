import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Job } from "./types.js";

// A restarted dispatcher must not erase recent active rows during takeover;
// those rows continue consuming the SQL global cap until their RunPod timeout.

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-dispatcher-failover-it-"));
const jobsJsonPath = path.join(tempDir, "jobs.json");
const jobsSqlitePath = path.join(tempDir, "jobs.sqlite");

process.env.ROLE = "dispatcher";
process.env.GENERATION_BACKEND = "runpod";
process.env.RUNPOD_SUBMISSION_MODE = "async";
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
const recentActive = job("job_prior_dispatcher", {
  status: "running",
  startedAt: new Date().toISOString(),
});
seeded.insertJob(recentActive);
const expiredAt = Date.now() - 1;
seeded.tryAcquireDispatcherLease({
  ownerId: "prior-host:123:prior-owner",
  ownerPid: 123,
  ownerHost: "prior-host",
  heartbeatAt: expiredAt - 100,
  expiresAt: expiredAt,
  now: expiredAt - 200,
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

test("lease takeover preserves recent active jobs in the global cap", async () => {
  await jobQueue.loadJobs();

  assert.equal(jobQueue.getJob(recentActive.id)?.status, "running");
  assert.equal(jobQueue.getQueueSnapshot().runpodActive, 1);
  assert.equal(jobQueue.getQueueSnapshot().dispatcher.heldByThisProcess, true);

  const reader = openSqliteJobStore(jobsSqlitePath, "jobs", { readonly: true });
  assert.equal(reader.loadById(recentActive.id)?.status, "running");
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
