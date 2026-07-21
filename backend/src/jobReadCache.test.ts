import assert from "node:assert/strict";
import test from "node:test";
import { mergeJobChangesById } from "./jobReadCache.js";
import type { Job } from "./types.js";

test("incremental merge preserves in-flight object identity and lifecycle fields", () => {
  const active = job("job_running", {
    status: "running",
    title: "Original title",
    resultUrls: ["/api/media?path=completion.mp4"],
  });
  const current = [active];
  const incoming = job("job_running", {
    status: "running",
    title: "Edited by API worker",
    resultUrls: [],
  });

  const merged = mergeJobChangesById(
    current,
    { revision: 2, upserts: [incoming], deletedIds: [], fullSnapshotRequired: false },
    new Set([active.id]),
  );

  assert.equal(merged[0], active, "the dispatcher must keep the same object across awaits");
  assert.equal(active.title, "Edited by API worker");
  assert.deepEqual(active.resultUrls, ["/api/media?path=completion.mp4"]);
  assert.equal(active.status, "running");
});

test("incremental merge prepends inserts and removes tombstoned non-active jobs", () => {
  const existing = job("job_existing");
  const removed = job("job_removed");
  const inserted = job("job_new", { createdAt: "2026-07-21T00:00:00.000Z" });

  const merged = mergeJobChangesById(
    [existing, removed],
    { revision: 3, upserts: [inserted], deletedIds: [removed.id], fullSnapshotRequired: false },
    new Set(),
  );

  assert.deepEqual(merged.map((item) => item.id), ["job_new", "job_existing"]);
  assert.equal(merged[1], existing);
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
