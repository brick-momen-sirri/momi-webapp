import assert from "node:assert/strict";
import test from "node:test";

import { commitQueuedJob } from "./queuedJobCommit.js";
import type { Job } from "../types.js";

test("publishes to the dispatcher only after durable persistence succeeds", async () => {
  const visible: Job[] = [];
  const persisted: Job[] = [];
  let notifications = 0;
  const job = queuedJob();

  await commitQueuedJob(job, {
    add: (value) => visible.push(value),
    remove: (id) => visible.splice(0, visible.length, ...visible.filter((value) => value.id !== id)),
    persist: async (value) => {
      assert.equal(visible.includes(value), true);
      persisted.push(value);
    },
    notifyDispatcher: () => {
      assert.equal(persisted.includes(job), true);
      notifications += 1;
    },
  });

  assert.deepEqual(visible, [job]);
  assert.deepEqual(persisted, [job]);
  assert.equal(notifications, 1);
});

test("removes the in-memory orphan and never dispatches after a persistence failure", async () => {
  const visible: Job[] = [];
  let notifications = 0;
  const job = queuedJob();

  await assert.rejects(
    commitQueuedJob(job, {
      add: (value) => visible.push(value),
      remove: (id) => visible.splice(0, visible.length, ...visible.filter((value) => value.id !== id)),
      persist: async () => {
        throw new Error("isolated database write failed");
      },
      notifyDispatcher: () => {
        notifications += 1;
      },
    }),
    /database write failed/i,
  );

  assert.deepEqual(visible, []);
  assert.equal(notifications, 0);
});

function queuedJob(): Job {
  return {
    id: "job_commit",
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
    createdAt: "2026-08-04T12:00:00.000Z",
  };
}
