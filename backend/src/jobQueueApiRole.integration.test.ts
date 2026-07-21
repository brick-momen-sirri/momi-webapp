import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Stage B role-ownership checks. An API-only process may request cancellation,
// but it must not normalize or directly transition lifecycle status fields.

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-api-role-it-"));
const jobsJsonPath = path.join(tempDir, "jobs.json");
const jobsSqlitePath = path.join(tempDir, "jobs.sqlite");

process.env.ROLE = "api";
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
    { id: "job_running", projectId: "prj_1", userId: "usr_1", status: "running", createdAt: "2026-07-20T00:02:00.000Z", resultUrls: [], thumbnailUrls: [] },
    { id: "job_queued", projectId: "prj_1", userId: "usr_1", status: "queued", createdAt: "2026-07-20T00:01:00.000Z", resultUrls: [], thumbnailUrls: [] },
  ]),
  "utf8",
);

const jobQueue = await import("./jobQueue.js");
const { openSqliteJobStore } = await import("./sqliteJobStore.js");

function sqliteJob(id: string) {
  const store = openSqliteJobStore(jobsSqlitePath, "jobs", { readonly: true });
  try {
    return store.loadById(id);
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

test("API-role boot leaves dispatcher-owned running status untouched", async () => {
  await jobQueue.loadJobs();

  assert.equal(jobQueue.getJob("job_running")?.status, "running");
  assert.equal(sqliteJob("job_running")?.status, "running");
});

test("API-role cancellation writes only cancelRequested", async () => {
  const canceled = await jobQueue.cancelJob("job_queued");

  assert.equal(canceled?.status, "queued");
  assert.equal(canceled?.cancelRequested, true);
  const persisted = sqliteJob("job_queued");
  assert.equal(persisted?.status, "queued");
  assert.equal(persisted?.cancelRequested, true);
  assert.equal(persisted?.completedAt, undefined);
});

test("live jobs cannot be archived by an API worker", async () => {
  await assert.rejects(
    jobQueue.archiveJob("job_running", "usr_1"),
    (error: unknown) => (
      error instanceof Error
      && "statusCode" in error
      && error.statusCode === 409
    ),
  );

  assert.equal(sqliteJob("job_running")?.archivedAt, undefined);
});
