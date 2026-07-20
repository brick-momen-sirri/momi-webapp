import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Exercises the JOB_STORE_DRIVER=sqlite path end-to-end through jobQueue:
// migration from jobs.json, interrupted-job normalization, persistence to
// SQLite, and reloading from SQLite. Env is set before importing jobQueue so
// config picks up the temp paths and the sqlite driver. (Node's test runner
// runs each test file in its own process, so this env is isolated.)

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-jobstore-it-"));
const jobsJsonPath = path.join(tempDir, "jobs.json");
const sqlitePath = path.join(tempDir, "jobs.sqlite");

process.env.GENERATION_BACKEND = "runpod";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_STORE_PATH = jobsJsonPath;
process.env.JOBS_SQLITE_PATH = sqlitePath;
process.env.JOBS_ARCHIVED_PATH = path.join(tempDir, "archived-items.json");

writeFileSync(
  jobsJsonPath,
  JSON.stringify([
    { id: "job_done", projectId: "prj_1", userId: "usr_1", status: "completed", createdAt: "2026-07-20T00:00:00.000Z", resultUrls: [], thumbnailUrls: [] },
    { id: "job_running", projectId: "prj_1", userId: "usr_1", status: "running", createdAt: "2026-07-20T00:01:00.000Z", resultUrls: [], thumbnailUrls: [] },
  ]),
  "utf8",
);

const jobQueue = await import("./jobQueue.js");
const { openSqliteJobStore } = await import("./sqliteJobStore.js");

after(() => {
  jobQueue.closeJobStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may still hold WAL handles briefly; the OS temp dir is transient.
  }
});

test("loadJobs migrates jobs.json into SQLite and normalizes interrupted jobs", async () => {
  await jobQueue.loadJobs();

  const loaded = jobQueue.getJobs();
  assert.equal(loaded.length, 2);
  // A RunPod job left "running" across a restart is reset to failed.
  assert.equal(loaded.find((job) => job.id === "job_running")?.status, "failed");
  assert.equal(loaded.find((job) => job.id === "job_done")?.status, "completed");
});

test("normalized state is persisted to the SQLite store", async () => {
  await jobQueue.flushPersistedJobs();

  const store = openSqliteJobStore(sqlitePath);
  const rows = store.loadAll();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((job) => job.id === "job_running")?.status, "failed");
  store.close();
});

test("subsequent loadJobs reads from SQLite rather than the JSON file", async () => {
  // Empty the JSON source. If jobs still load, they came from SQLite.
  writeFileSync(jobsJsonPath, "[]", "utf8");

  await jobQueue.loadJobs();
  const loaded = jobQueue.getJobs();
  assert.equal(loaded.length, 2);
  assert.equal(loaded.find((job) => job.id === "job_running")?.status, "failed");
});
