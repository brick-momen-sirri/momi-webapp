import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteJobStore } from "./sqliteJobStore.js";
import type { Job } from "./types.js";

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    projectId: "prj_1",
    userId: "usr_1",
    status: "completed",
    createdAt: "2026-07-20T00:00:00.000Z",
    resultUrls: [],
    thumbnailUrls: [],
    ...overrides,
  } as Job;
}

async function withStore(run: (dbPath: string) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-sqlite-"));
  try {
    run(path.join(dir, "jobs.sqlite"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("replaceAll then loadAll round-trips jobs in order with full data", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    const input = [
      job("job_1", { prompt: "first", creditsUsed: 4 } as Partial<Job>),
      job("job_2", { status: "queued" }),
    ];
    store.replaceAll(input);

    const loaded = store.loadAll();
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded.map((j) => j.id), ["job_1", "job_2"]);
    assert.equal((loaded[0] as { prompt?: string }).prompt, "first");
    assert.equal(loaded[1].status, "queued");
    store.close();
  });
});

test("replaceAll upserts existing rows and prunes removed ones", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.replaceAll([job("job_1", { status: "queued" }), job("job_2"), job("job_3")]);
    assert.equal(store.count(), 3);

    // job_2 dropped, job_1 updated.
    store.replaceAll([job("job_1", { status: "completed" }), job("job_3")]);
    const loaded = store.loadAll();
    assert.deepEqual(loaded.map((j) => j.id).sort(), ["job_1", "job_3"]);
    assert.equal(loaded.find((j) => j.id === "job_1")?.status, "completed");
    assert.equal(store.count(), 2);
    store.close();
  });
});

test("data persists across store reopen (on-disk durability)", async () => {
  await withStore((dbPath) => {
    const first = openSqliteJobStore(dbPath);
    first.replaceAll([job("job_1"), job("job_2")]);
    first.close();

    const second = openSqliteJobStore(dbPath);
    assert.equal(second.count(), 2);
    assert.deepEqual(second.loadAll().map((j) => j.id), ["job_1", "job_2"]);
    second.close();
  });
});

test("a fresh store loads as empty", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    assert.deepEqual(store.loadAll(), []);
    assert.equal(store.count(), 0);
    store.close();
  });
});

test("re-syncing an unchanged array writes nothing (dirty-row diffing)", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    const jobs = [job("job_1"), job("job_2"), job("job_3")];
    assert.equal(store.replaceAll(jobs).written, 3);
    assert.deepEqual(store.replaceAll(jobs), { written: 0, deleted: 0 });
    store.close();
  });
});

test("only the changed job is written on a status transition", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.replaceAll([job("job_1", { status: "running" }), job("job_2"), job("job_3")]);
    const stats = store.replaceAll([job("job_1", { status: "completed" }), job("job_2"), job("job_3")]);
    assert.deepEqual(stats, { written: 1, deleted: 0 });
    assert.equal(store.loadAll().find((j) => j.id === "job_1")?.status, "completed");
    store.close();
  });
});

test("removing a job writes nothing but deletes one row", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.replaceAll([job("job_1"), job("job_2"), job("job_3")]);
    const stats = store.replaceAll([job("job_1"), job("job_3")]);
    assert.deepEqual(stats, { written: 0, deleted: 1 });
    assert.equal(store.count(), 2);
    store.close();
  });
});

test("prepended jobs keep newest-first order across syncs", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.replaceAll([job("job_1")]);
    store.replaceAll([job("job_2"), job("job_1")]); // job_2 prepended (newer)
    store.replaceAll([job("job_3"), job("job_2"), job("job_1")]); // job_3 prepended
    assert.deepEqual(store.loadAll().map((j) => j.id), ["job_3", "job_2", "job_1"]);
    store.close();
  });
});

test("seq is stable across reopen so order survives later updates", async () => {
  await withStore((dbPath) => {
    const first = openSqliteJobStore(dbPath);
    first.replaceAll([job("job_2"), job("job_1")]);
    first.close();

    const second = openSqliteJobStore(dbPath);
    second.replaceAll([job("job_2"), job("job_1", { status: "failed" })]);
    assert.deepEqual(second.loadAll().map((j) => j.id), ["job_2", "job_1"]);
    assert.equal(second.loadAll().find((j) => j.id === "job_1")?.status, "failed");
    second.close();
  });
});
