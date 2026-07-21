import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Job } from "./types.js";

// Stage D runtime coverage: an idle dispatcher discovers API-created rows by
// polling, but its atomic SQL claim cannot exceed the DB-wide active count.

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-dispatcher-it-"));
const jobsJsonPath = path.join(tempDir, "jobs.json");
const jobsSqlitePath = path.join(tempDir, "jobs.sqlite");

process.env.ROLE = "dispatcher";
process.env.GENERATION_BACKEND = "runpod";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_ROW_LEVEL_WRITES = "true";
process.env.JOBS_STORE_PATH = jobsJsonPath;
process.env.JOBS_SQLITE_PATH = jobsSqlitePath;
process.env.JOBS_ARCHIVED_PATH = path.join(tempDir, "archived-items.json");
process.env.JOBS_ARCHIVED_SQLITE_PATH = path.join(tempDir, "archived-items.sqlite");
process.env.RUNPOD_MAX_CONCURRENT_JOBS = "1";
process.env.DISPATCHER_POLL_INTERVAL_MS = "20";
process.env.DISPATCHER_LEASE_HEARTBEAT_MS = "40";
process.env.DISPATCHER_LEASE_TTL_MS = "200";
process.env.DISPATCHER_WAL_CHECKPOINT_MS = "0";

writeFileSync(jobsJsonPath, "[]", "utf8");

const jobQueue = await import("./jobQueue.js");
const { openSqliteJobStore } = await import("./sqliteJobStore.js");
let writer: ReturnType<typeof openSqliteJobStore> | undefined;

after(() => {
  writer?.close();
  jobQueue.closeJobStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL handles briefly; the OS temp dir is transient.
  }
});

test("dispatcher poll discovers queued work and waits for a global SQL slot", async () => {
  await jobQueue.loadJobs();
  assert.equal(jobQueue.getQueueSnapshot().dispatcher.active, true);
  assert.equal(jobQueue.getQueueSnapshot().dispatcher.heldByThisProcess, true);

  writer = openSqliteJobStore(jobsSqlitePath);
  writer.insertJob(job("job_already_active", {
    status: "running",
    startedAt: new Date().toISOString(),
  }));
  writer.insertJob(job("job_waiting", { status: "queued", cancelRequested: true }));

  await delay(120);
  assert.equal(writer.loadById("job_waiting")?.status, "queued");
  assert.equal(writer.countActiveJobs(), 1);

  writer.applyToJob("job_already_active", (current) => {
    current.status = "completed";
    current.completedAt = new Date().toISOString();
  });

  const settled = await waitFor(() => writer?.loadById("job_waiting")?.status === "canceled", 1_000);
  assert.equal(settled, true, "the idle dispatcher should claim within one polling window");
  assert.ok(writer.loadById("job_waiting")?.startedAt, "the SQL claim records its start atomically");
  assert.equal(writer.countActiveJobs(), 0);
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
