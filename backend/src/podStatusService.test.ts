import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRunpodHealth } from "./podStatusService.js";

test("normalizes aggregate RunPod health response", () => {
  const stats = normalizeRunpodHealth({
    workers: {
      idle: 2,
      ready: 2,
      running: 1,
      unhealthy: 1,
      initializing: 1,
    },
    jobs: {
      inQueue: 3,
      inProgress: 1,
      completed: 12,
      failed: 2,
    },
  });

  assert.equal(stats.workers.available, 3);
  assert.equal(stats.workers.idle, 2);
  assert.equal(stats.workers.running, 1);
  assert.equal(stats.workers.unavailable, 1);
  assert.equal(stats.workers.initializing, 1);
  assert.equal(stats.jobs.queued, 3);
  assert.equal(stats.jobs.running, 1);
});

test("normalizes list-based worker and job states", () => {
  const stats = normalizeRunpodHealth({
    workers: [
      { id: "w1", status: "IDLE" },
      { id: "w2", status: "RUNNING" },
      { id: "w3", status: "THROTTLED" },
    ],
    jobs: [
      { id: "j1", state: "IN_QUEUE" },
      { id: "j2", state: "IN_PROGRESS" },
    ],
  });

  assert.equal(stats.workers.available, 2);
  assert.equal(stats.workers.idle, 1);
  assert.equal(stats.workers.running, 1);
  assert.equal(stats.workers.throttled, 1);
  assert.equal(stats.jobs.queued, 1);
  assert.equal(stats.jobs.running, 1);
});
