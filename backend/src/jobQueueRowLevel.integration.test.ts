import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Exercises the Stage A per-row write path (JOBS_ROW_LEVEL_WRITES=true) through
// real jobQueue mutations, asserting each change lands as a single SQLite row.
// Env is set before importing jobQueue; Node's test runner isolates each file
// in its own process.

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-rowlevel-it-"));
const jobsJsonPath = path.join(tempDir, "jobs.json");
const jobsSqlitePath = path.join(tempDir, "jobs.sqlite");

process.env.GENERATION_BACKEND = "runpod";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_ROW_LEVEL_WRITES = "true";
process.env.JOBS_STORE_PATH = jobsJsonPath;
process.env.JOBS_SQLITE_PATH = jobsSqlitePath;
process.env.JOBS_ARCHIVED_PATH = path.join(tempDir, "archived-items.json");
process.env.JOBS_ARCHIVED_SQLITE_PATH = path.join(tempDir, "archived-items.sqlite");

writeFileSync(
  jobsJsonPath,
  JSON.stringify([
    { id: "job_cancel_requested", projectId: "prj_1", userId: "usr_1", status: "running", cancelRequested: true, createdAt: "2026-07-20T00:03:00.000Z", resultUrls: [], thumbnailUrls: [] },
    { id: "job_queued", projectId: "prj_1", userId: "usr_1", status: "queued", createdAt: "2026-07-20T00:02:00.000Z", resultUrls: [], thumbnailUrls: [] },
    { id: "job_archived", projectId: "prj_1", userId: "usr_1", status: "completed", archivedAt: "2026-07-20T00:00:00.000Z", archivedBy: "usr_1", createdAt: "2026-07-20T00:00:00.000Z", resultUrls: [], thumbnailUrls: [] },
  ]),
  "utf8",
);

const jobQueue = await import("./jobQueue.js");
const { openSqliteJobStore } = await import("./sqliteJobStore.js");

function sqliteRows() {
  const store = openSqliteJobStore(jobsSqlitePath, "jobs", { readonly: true });
  try {
    return store.loadAll();
  } finally {
    store.close();
  }
}

after(() => {
  jobQueue.closeJobStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL handles briefly; the OS temp dir is transient.
  }
});

test("monolith cancellation requests are settled by the dispatcher path", async () => {
  await jobQueue.loadJobs();
  assert.equal(jobQueue.getJobs().length, 3);
  assert.equal(jobQueue.getJob("job_cancel_requested")?.status, "canceled");
  assert.equal(sqliteRows().find((j) => j.id === "job_cancel_requested")?.status, "canceled");

  await jobQueue.cancelJob("job_queued");

  // In-memory reflects it, and the SQLite row was updated per-row synchronously.
  assert.equal(jobQueue.getJobs().find((j) => j.id === "job_queued")?.status, "canceled");
  assert.equal(jobQueue.getJobs().find((j) => j.id === "job_queued")?.cancelRequested, true);
  const persisted = sqliteRows().find((j) => j.id === "job_queued");
  assert.equal(persisted?.status, "canceled");
  assert.equal(persisted?.cancelRequested, true);
});

test("permanentlyDeleteArchivedJob removes exactly that row", async () => {
  await jobQueue.permanentlyDeleteArchivedJob("job_archived");

  assert.equal(jobQueue.getJobs().find((j) => j.id === "job_archived"), undefined);
  const rows = sqliteRows();
  assert.deepEqual(rows.map((j) => j.id), ["job_cancel_requested", "job_queued"]);
  assert.equal(rows.find((j) => j.id === "job_queued")?.status, "canceled");
});
