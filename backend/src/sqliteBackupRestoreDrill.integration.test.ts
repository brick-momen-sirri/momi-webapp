import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openSqliteJobStore } from "./sqliteJobStore.js";
import { runBackupCycle } from "./sqliteBackupService.js";
import type { Job } from "./types.js";

// This is the restore drill described in docs/sqlite-dr-runbook.md, run for
// real against the actual application store code (not raw SQL) so the runbook
// is a proven procedure, not an assumed one: take a real backup of a real
// jobs.sqlite via the real store API, simulate total loss of the live database
// (main file + WAL + SHM all gone -- e.g. a failed disk), restore purely by
// copying the snapshot back into place, and confirm the application reads
// back the exact same data through openSqliteJobStore. If this test ever
// fails, the runbook's restore steps no longer work and must be re-verified
// before relying on them in a real incident.

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

test("restore drill: a database that never existed cannot be restored (documents the RPO gap, doesn't crash)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-restore-drill-"));
  try {
    const liveDbPath = path.join(dir, "jobs.sqlite");
    const stagingDir = path.join(dir, "staging");
    const cycle = await runBackupCycle({ targets: [{ name: "jobs", sourcePath: liveDbPath }], stagingDir, retention: 5, label: "t0" });
    assert.equal(cycle.ok, false, "there is nothing to back up yet, and that must be a visible failure, not silent success");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("restore drill: live jobs.sqlite is fully recoverable after simulated total loss", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-restore-drill-"));
  try {
    const liveDbPath = path.join(dir, "jobs.sqlite");
    const stagingDir = path.join(dir, "staging");

    // 1. Real application traffic through the real store API.
    const liveStore = openSqliteJobStore(liveDbPath);
    const original: Job[] = [
      job("job_1", { prompt: "a red car at sunset", creditsUsed: 4 } as Partial<Job>),
      job("job_2", { status: "queued", prompt: "a blue whale" }),
      job("job_3", { status: "failed", errorMessage: "RunPod timeout" } as Partial<Job>),
    ];
    liveStore.replaceAll(original);
    // Deliberately do NOT close liveStore yet -- the drill must prove recovery
    // works while the WAL still holds uncheckpointed state, exactly like a real
    // dispatcher that never voluntarily closes its connection.
    liveStore.checkpointWalPassive();
    liveStore.applyToJob("job_2", (current) => {
      current.status = "running";
      return current;
    });

    // 2. A real backup cycle, taken while the store above is still open.
    const cycle = await runBackupCycle({ targets: [{ name: "jobs", sourcePath: liveDbPath }], stagingDir, retention: 5, label: "t0" });
    assert.equal(cycle.ok, true);
    const snapshotPath = cycle.results[0].snapshotPath!;
    assert.ok(snapshotPath);

    // 3. Simulate total loss: the live database, its WAL, and its SHM are gone
    // (e.g. a failed disk, an accidental delete). Close the app's connection
    // first, the way a real incident would start with the process being down.
    liveStore.close();
    await fs.rm(liveDbPath, { force: true });
    await fs.rm(`${liveDbPath}-wal`, { force: true });
    await fs.rm(`${liveDbPath}-shm`, { force: true });
    const survivedLoss = await fs.access(liveDbPath).then(() => true, () => false);
    assert.equal(survivedLoss, false, "sanity check: the live db must actually be gone before restoring");

    // 4. The documented restore procedure: verify the snapshot, then copy it
    // into place at the live path. No -wal/-shm exist to worry about because
    // the backup service already ships a plain, non-WAL single file (see
    // sqliteBackupService.test.ts's sidecar-leak regression test).
    await fs.copyFile(snapshotPath, liveDbPath);

    // 5. Reopen through the real application store API and confirm the exact
    // pre-loss state is back, including the mutation made after the last
    // structural write (applyToJob), proving row-level per-op durability
    // survives the restore, not just the initial replaceAll.
    const restoredStore = openSqliteJobStore(liveDbPath);
    try {
      const restored = restoredStore.loadAll();
      assert.equal(restored.length, 3);
      assert.deepEqual(restored.map((j) => j.id).sort(), ["job_1", "job_2", "job_3"]);
      assert.equal(restored.find((j) => j.id === "job_1")?.prompt, "a red car at sunset");
      assert.equal(restored.find((j) => j.id === "job_2")?.status, "running", "the post-snapshot applyToJob mutation must have been captured by the backup");
      assert.equal(restored.find((j) => j.id === "job_3")?.errorMessage, "RunPod timeout");
    } finally {
      restoredStore.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
