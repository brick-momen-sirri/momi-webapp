import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Job } from "./types.js";

// Stage C integration coverage: a long-lived API process must observe writes
// committed by another SQLite connection without rebuilding unchanged objects.

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-data-version-it-"));
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

const initialJob = job("job_existing", { title: "Original title" });
writeFileSync(jobsJsonPath, JSON.stringify([initialJob]), "utf8");

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

test("getJobs incrementally merges commits from another SQLite connection", async () => {
  await jobQueue.loadJobs();
  const existingReference = jobQueue.getJob(initialJob.id);
  assert.ok(existingReference);

  writer = openSqliteJobStore(jobsSqlitePath);
  const inserted = job("job_inserted", { createdAt: "2026-07-21T00:00:00.000Z" });
  writer.insertJob(inserted);

  assert.deepEqual(jobQueue.getJobs().map((item) => item.id), [inserted.id, initialJob.id]);

  writer.applyToJob(initialJob.id, (current) => ({ ...current, title: "Edited externally" }));
  const refreshedExisting = jobQueue.getJob(initialJob.id);
  assert.equal(refreshedExisting, existingReference);
  assert.equal(refreshedExisting?.title, "Edited externally");

  writer.deleteJob(inserted.id);
  assert.deepEqual(jobQueue.getJobs().map((item) => item.id), [initialJob.id]);
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
