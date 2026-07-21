import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
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

test("replaceAll rejects a job with embedded media (symmetric with the JSON writer)", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    assert.throws(
      () => store.replaceAll([job("job_bad", { prompt: "data:image/png;base64,AAAA" } as Partial<Job>)]),
      /embedded media/i,
    );
    assert.equal(store.count(), 0, "the bad row must not be persisted");
    store.close();
  });
});

test("replaceAll rejects an oversized string field", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    assert.throws(
      () => store.replaceAll([job("job_big", { prompt: "x".repeat(100_001) } as Partial<Job>)]),
      /oversized metadata string|metadata/i,
    );
    store.close();
  });
});

test("readonly open of a missing file throws instead of fabricating an empty store", () => {
  const missing = path.join(os.tmpdir(), `momi-nope-${Date.now()}.sqlite`);
  assert.throws(() => openSqliteJobStore(missing, "jobs", { readonly: true }));
  assert.equal(existsSync(missing), false, "must not create the file");
});

test("a readonly store cannot be written", async () => {
  await withStore((dbPath) => {
    const writable = openSqliteJobStore(dbPath, "jobs"); // create + seed
    writable.replaceAll([job("job_1")]);
    writable.close();
    const ro = openSqliteJobStore(dbPath, "jobs", { readonly: true });
    assert.deepEqual(ro.loadAll().map((j) => j.id), ["job_1"]);
    assert.throws(() => ro.replaceAll([job("job_2")]), /read-only/i);
    ro.close();
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

// --- Per-row writes (foundation for the web/worker split) ---

test("insertJob assigns increasing seq and loadAll returns newest-first", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.insertJob(job("job_1"));
    store.insertJob(job("job_2"));
    store.insertJob(job("job_3"));
    assert.deepEqual(store.loadAll().map((j) => j.id), ["job_3", "job_2", "job_1"]);
    assert.equal(store.count(), 3);
    store.close();
  });
});

test("loadById reads one job without reloading the full store", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.insertJob(job("job_1", { status: "running" }));
    store.insertJob(job("job_2"));

    assert.equal(store.loadById("job_1")?.status, "running");
    assert.equal(store.loadById("missing"), undefined);
    store.close();
  });
});

test("incremental reads return inserts, updates, and tombstones after a revision", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    const initial = store.loadSnapshot();
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.jobs, []);

    store.insertJob(job("job_1", { status: "queued" }));
    const inserted = store.loadChanges(initial.revision);
    assert.ok(inserted.revision > initial.revision);
    assert.deepEqual(inserted.upserts.map((item) => item.id), ["job_1"]);
    assert.deepEqual(inserted.deletedIds, []);

    store.applyToJob("job_1", (current) => {
      current.title = "Edited on API worker";
    });
    const updated = store.loadChanges(inserted.revision);
    assert.ok(updated.revision > inserted.revision);
    assert.equal(updated.upserts[0]?.title, "Edited on API worker");
    assert.deepEqual(updated.deletedIds, []);

    store.deleteJob("job_1");
    const deleted = store.loadChanges(updated.revision);
    assert.ok(deleted.revision > updated.revision);
    assert.deepEqual(deleted.upserts, []);
    assert.deepEqual(deleted.deletedIds, ["job_1"]);
    store.close();
  });
});

test("reinserting a deleted id clears its tombstone for incremental readers", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.insertJob(job("job_1"));
    const beforeDelete = store.loadSnapshot().revision;
    store.deleteJob("job_1");
    store.insertJob(job("job_1", { status: "queued" }));

    const changes = store.loadChanges(beforeDelete);
    assert.deepEqual(changes.deletedIds, []);
    assert.equal(changes.upserts[0]?.id, "job_1");
    assert.equal(changes.upserts[0]?.status, "queued");
    store.close();
  });
});

test("updateJob rewrites content, preserves order, and reports missing ids", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.insertJob(job("job_1", { status: "running" }));
    store.insertJob(job("job_2"));
    assert.equal(store.updateJob(job("job_1", { status: "completed" })), true);
    assert.equal(store.updateJob(job("ghost")), false);
    assert.deepEqual(store.loadAll().map((j) => j.id), ["job_2", "job_1"]);
    assert.equal(store.loadAll().find((j) => j.id === "job_1")?.status, "completed");
    store.close();
  });
});

test("applyToJob does an atomic read-modify-write and no-ops on missing ids", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.insertJob(job("job_1", { status: "queued" }));
    const updated = store.applyToJob("job_1", (j) => { j.status = "canceled"; });
    assert.equal(updated?.status, "canceled");
    assert.equal(store.loadAll()[0].status, "canceled");
    assert.equal(store.applyToJob("ghost", (j) => j), undefined);
    store.close();
  });
});

test("deleteJob removes a row and reports whether it existed", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    store.insertJob(job("job_1"));
    store.insertJob(job("job_2"));
    assert.equal(store.deleteJob("job_1"), true);
    assert.equal(store.deleteJob("job_1"), false);
    assert.deepEqual(store.loadAll().map((j) => j.id), ["job_2"]);
    store.close();
  });
});

test("per-row writes enforce the no-embedded-media contract", async () => {
  await withStore((dbPath) => {
    const store = openSqliteJobStore(dbPath);
    assert.throws(() => store.insertJob(job("bad", { prompt: "data:image/png;base64,AAAA" } as Partial<Job>)), /embedded media/i);
    store.insertJob(job("job_1"));
    assert.throws(() => store.updateJob(job("job_1", { prompt: "data:video/mp4;base64,AAAA" } as Partial<Job>)), /embedded media/i);
    assert.equal(store.count(), 1);
    store.close();
  });
});

test("a reader observes another connection's writes via data_version", async () => {
  await withStore((dbPath) => {
    const writer = openSqliteJobStore(dbPath, "jobs");
    writer.insertJob(job("job_seed"));
    const reader = openSqliteJobStore(dbPath, "jobs", { readonly: true });

    const v0 = reader.dataVersion();
    assert.deepEqual(reader.loadAll().map((j) => j.id), ["job_seed"]);
    // The reader's own repeated reads never move its data_version.
    assert.equal(reader.dataVersion(), v0);

    // Another connection commits -> the reader's data_version changes, which is
    // the signal to reload.
    writer.insertJob(job("job_new"));
    const v1 = reader.dataVersion();
    assert.notEqual(v1, v0, "data_version must change after another connection commits");
    assert.deepEqual(reader.loadAll().map((j) => j.id).sort(), ["job_new", "job_seed"]);

    writer.close();
    reader.close();
  });
});

test("concurrent per-row inserts from two connections keep all rows and unique seq", async () => {
  await withStore((dbPath) => {
    // Two independent connections to the SAME file — the multi-process model.
    const a = openSqliteJobStore(dbPath, "jobs");
    const b = openSqliteJobStore(dbPath, "jobs");
    a.insertJob(job("job_a1"));
    b.insertJob(job("job_b1")); // interleaved writer must not clobber a's row
    a.insertJob(job("job_a2"));
    b.insertJob(job("job_b2"));
    a.close();
    b.close();

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.prepare("SELECT id, seq FROM jobs ORDER BY seq").all() as Array<{ id: string; seq: number }>;
    raw.close();

    // No clobber: all four rows survive.
    assert.deepEqual(rows.map((r) => r.id).sort(), ["job_a1", "job_a2", "job_b1", "job_b2"]);
    // DB-authoritative seq: every seq is unique (no cross-connection collision).
    assert.equal(new Set(rows.map((r) => r.seq)).size, 4);
  });
});

test("dispatcher lease is exclusive, renewable, expiring, and owner-safe", async () => {
  await withStore((dbPath) => {
    const a = openSqliteJobStore(dbPath, "jobs");
    const b = openSqliteJobStore(dbPath, "jobs");
    const ownerA = {
      ownerId: "host-a:100:lease-a",
      ownerPid: 100,
      ownerHost: "host-a",
      heartbeatAt: 1_000,
      expiresAt: 2_000,
    };
    const ownerB = {
      ownerId: "host-b:200:lease-b",
      ownerPid: 200,
      ownerHost: "host-b",
      heartbeatAt: 1_100,
      expiresAt: 2_100,
    };

    assert.equal(a.tryAcquireDispatcherLease({ ...ownerA, now: 1_000 }), true);
    assert.equal(b.tryAcquireDispatcherLease({ ...ownerB, now: 1_100 }), false);
    assert.deepEqual(b.readDispatcherLease(), ownerA);

    const renewedA = { ...ownerA, heartbeatAt: 1_500, expiresAt: 2_500 };
    assert.equal(a.renewDispatcherLease(renewedA), true);
    assert.equal(b.tryAcquireDispatcherLease({ ...ownerB, now: 2_100 }), false);

    const acquiredB = { ...ownerB, heartbeatAt: 2_500, expiresAt: 3_500 };
    assert.equal(b.tryAcquireDispatcherLease({ ...acquiredB, now: 2_500 }), true);
    assert.equal(a.renewDispatcherLease({ ...renewedA, heartbeatAt: 2_600, expiresAt: 3_600 }), false);
    assert.equal(a.releaseDispatcherLease(ownerA.ownerId), false);
    assert.equal(b.releaseDispatcherLease(ownerB.ownerId), true);
    assert.equal(a.readDispatcherLease(), undefined);

    a.close();
    b.close();
  });
});

test("an explicitly dead same-host lease can be replaced before its TTL", async () => {
  await withStore((dbPath) => {
    const a = openSqliteJobStore(dbPath, "jobs");
    const b = openSqliteJobStore(dbPath, "jobs");
    const deadOwner = {
      ownerId: "same-host:101:dead",
      ownerPid: 101,
      ownerHost: "same-host",
      heartbeatAt: 1_000,
      expiresAt: 20_000,
    };
    const replacement = {
      ownerId: "same-host:202:replacement",
      ownerPid: 202,
      ownerHost: "same-host",
      heartbeatAt: 1_100,
      expiresAt: 2_100,
    };

    assert.equal(a.tryAcquireDispatcherLease({ ...deadOwner, now: 1_000 }), true);
    assert.equal(b.tryAcquireDispatcherLease({ ...replacement, now: 1_100 }), false);
    assert.equal(b.tryAcquireDispatcherLease({
      ...replacement,
      now: 1_100,
      replaceOwnerId: deadOwner.ownerId,
    }), true);
    assert.deepEqual(a.readDispatcherLease(), replacement);

    a.close();
    b.close();
  });
});

test("atomic claims enforce the SQL-counted global concurrency cap", async () => {
  await withStore((dbPath) => {
    const a = openSqliteJobStore(dbPath, "jobs");
    const b = openSqliteJobStore(dbPath, "jobs");
    a.insertJob(job("job_old", { createdAt: "2026-07-20T00:00:00.000Z", status: "queued" }));
    a.insertJob(job("job_new", { createdAt: "2026-07-21T00:00:00.000Z", status: "queued" }));

    const first = a.claimNextQueuedJob("2026-07-21T01:00:00.000Z", 1);
    assert.equal(first?.id, "job_new");
    assert.equal(first?.status, "sending");
    assert.equal(a.countActiveJobs(), 1);
    assert.equal(b.claimNextQueuedJob("2026-07-21T01:00:01.000Z", 1), undefined);
    assert.equal(b.loadById("job_old")?.status, "queued");

    a.applyToJob(first!.id, (current) => {
      current.status = "completed";
      current.completedAt = "2026-07-21T01:01:00.000Z";
    });
    const second = b.claimNextQueuedJob("2026-07-21T01:01:01.000Z", 1);
    assert.equal(second?.id, "job_old");
    assert.equal(a.countActiveJobs(), 1);
    assert.equal(a.claimNextQueuedJob("2026-07-21T01:01:02.000Z", 1), undefined);

    a.close();
    b.close();
  });
});

test("atomic claim rejects a stale dispatcher after lease takeover", async () => {
  await withStore((dbPath) => {
    const a = openSqliteJobStore(dbPath, "jobs");
    const b = openSqliteJobStore(dbPath, "jobs");
    a.insertJob(job("job_queued", { status: "queued" }));
    const ownerA = {
      ownerId: "host:100:owner-a",
      ownerPid: 100,
      ownerHost: "host",
      heartbeatAt: 1_000,
      expiresAt: 2_000,
    };
    const ownerB = {
      ownerId: "host:200:owner-b",
      ownerPid: 200,
      ownerHost: "host",
      heartbeatAt: 2_000,
      expiresAt: 3_000,
    };
    assert.equal(a.tryAcquireDispatcherLease({ ...ownerA, now: 1_000 }), true);
    assert.equal(b.tryAcquireDispatcherLease({ ...ownerB, now: 2_000 }), true);

    assert.equal(
      a.claimNextQueuedJob("2026-07-21T01:00:00.000Z", 1, ownerA.ownerId, 2_001),
      undefined,
    );
    assert.equal(
      b.claimNextQueuedJob("2026-07-21T01:00:01.000Z", 1, ownerB.ownerId, 2_001)?.id,
      "job_queued",
    );

    a.close();
    b.close();
  });
});
