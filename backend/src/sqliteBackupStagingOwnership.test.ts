import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { ensureStagingOwnership, newestSnapshotBytes, readStagingOwner, runBackupCycle } from "./sqliteBackupService.js";

// Regression cover for the 2026-08-05 incident.
//
// `SQLITE_BACKUP_STAGING_DIR` defaults to a directory anchored to the REPO
// (config.ts), while every database path is independently overridable. The
// topology load test overrides the database paths to a throwaway directory and
// inherited the default staging directory, so twelve of its cycles wrote
// snapshots of near-empty databases into production backup history and rotated
// twelve hours of genuine snapshots out to honour the retention count.
//
// Nothing detected it: an empty database is perfectly intact, so every one of
// those snapshots reported `integrity_check: ok` and looked identical to a real
// backup. The guard below is therefore about IDENTITY, not integrity.

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "momi-backup-ownership-"));
}

function makeDatabase(filePath: string, rows = 0) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO items (value) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`row-${i}`);
  db.close();
  return filePath;
}

/** Runs `body` against a throwaway webhook and returns the alerts it received. */
async function collectAlerts(body: (webhookUrl: string) => Promise<void>) {
  const received: { rule: string; detail: string; role: string }[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await body(`http://127.0.0.1:${address.port}/hook`);
    await new Promise((resolve) => setTimeout(resolve, 300)); // webhook POSTs are fire-and-forget
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return received;
}

const ruleNames = (alerts: { rule: string }[]) => alerts.map((alert) => alert.rule);

test("the first cycle claims the staging directory, and repeat cycles are not conflicts", async () => {
  const dir = await tempDir();
  const dbPath = makeDatabase(path.join(dir, "data", "jobs.sqlite"));
  const stagingDir = path.join(dir, "staging");

  const first = await ensureStagingOwnership(stagingDir, [{ name: "jobs", sourcePath: dbPath }]);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.claimed, true);

  const owner = await readStagingOwner(stagingDir);
  assert.ok(owner, "the claim must be persisted");
  assert.equal(owner.sourceDirs.length, 1);

  const second = await ensureStagingOwnership(stagingDir, [{ name: "jobs", sourcePath: dbPath }]);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.claimed, false, "the directory is already owned by these databases");
});

test("a database added inside the already-owned data directory is allowed", async () => {
  const dir = await tempDir();
  const dataDir = path.join(dir, "data");
  const jobsPath = makeDatabase(path.join(dataDir, "jobs.sqlite"));
  const statePath = makeDatabase(path.join(dataDir, "app-state.sqlite"));
  const stagingDir = path.join(dir, "staging");

  await ensureStagingOwnership(stagingDir, [{ name: "jobs", sourcePath: jobsPath }]);
  const verdict = await ensureStagingOwnership(stagingDir, [
    { name: "jobs", sourcePath: jobsPath },
    { name: "app-state", sourcePath: statePath },
  ]);

  assert.equal(verdict.ok, true, "switching a driver to sqlite is a normal config change, not a conflict");
});

test("a cycle from a foreign data directory is refused and writes nothing at all", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  const productionDb = makeDatabase(path.join(dir, "production", "jobs.sqlite"), 2000);
  const harnessDb = makeDatabase(path.join(dir, "harness", "jobs.sqlite")); // the empty throwaway of a test run

  await runBackupCycle({
    targets: [{ name: "jobs", sourcePath: productionDb }],
    stagingDir,
    retention: 2,
    label: "2026-08-05T09-00-00-000Z",
  });
  const statusBefore = await fs.readFile(path.join(stagingDir, "backup-status.json"), "utf8");

  const alerts = await collectAlerts(async (webhookUrl) => {
    const cycle = await runBackupCycle({
      targets: [{ name: "jobs", sourcePath: harnessDb }],
      stagingDir,
      retention: 2,
      label: "2026-08-05T10-43-30-871Z",
      webhookUrl,
      role: "load-test",
    });
    assert.equal(cycle.ok, false, "a foreign data directory must never produce a successful cycle");
  });

  assert.ok(
    alerts.some((a) => a.rule === "backup_staging_conflict"),
    `expected a conflict alert, got ${JSON.stringify(ruleNames(alerts))}`,
  );

  const snapshots = (await fs.readdir(stagingDir)).filter((file) => file.endsWith(".sqlite"));
  assert.deepEqual(snapshots, ["jobs-2026-08-05T09-00-00-000Z.sqlite"], "no foreign snapshot may be written");
  assert.equal(
    await fs.readFile(path.join(stagingDir, "backup-status.json"), "utf8"),
    statusBefore,
    "a conflicted cycle must not overwrite the owning deployment's status file either",
  );
});

test("a burst of foreign cycles cannot rotate genuine snapshots out of the window", async () => {
  // The incident's actual damage. Retention 2 makes it provable in five cycles
  // rather than the fifty the production retention count would need.
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  const productionDb = makeDatabase(path.join(dir, "production", "jobs.sqlite"), 500);
  const harnessDb = makeDatabase(path.join(dir, "harness", "jobs.sqlite"));

  const targets = [{ name: "jobs", sourcePath: productionDb }];
  await runBackupCycle({ targets, stagingDir, retention: 2, label: "2026-08-05T08-00-00-000Z" });
  await runBackupCycle({ targets, stagingDir, retention: 2, label: "2026-08-05T09-00-00-000Z" });

  for (const label of ["2026-08-05T10-43-30-871Z", "2026-08-05T10-43-32-790Z", "2026-08-05T10-44-42-292Z"]) {
    await runBackupCycle({ targets: [{ name: "jobs", sourcePath: harnessDb }], stagingDir, retention: 2, label });
  }

  const snapshots = (await fs.readdir(stagingDir)).filter((file) => file.endsWith(".sqlite")).sort();
  assert.deepEqual(
    snapshots,
    ["jobs-2026-08-05T08-00-00-000Z.sqlite", "jobs-2026-08-05T09-00-00-000Z.sqlite"],
    "both genuine snapshots must survive",
  );
});

test("an unreadable ownership marker is reclaimed rather than wedging backups forever", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.writeFile(path.join(stagingDir, "staging-owner.json"), "{ this is not json", "utf8");
  const dbPath = makeDatabase(path.join(dir, "data", "jobs.sqlite"));

  const verdict = await ensureStagingOwnership(stagingDir, [{ name: "jobs", sourcePath: dbPath }]);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.claimed, true, "a corrupt marker must be re-claimed, never read as a conflict");
});

test("rotation never mistakes the ownership marker for a snapshot", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  const dbPath = makeDatabase(path.join(dir, "data", "jobs.sqlite"));

  for (const label of ["2026-08-05T08-00-00-000Z", "2026-08-05T09-00-00-000Z", "2026-08-05T10-00-00-000Z"]) {
    await runBackupCycle({ targets: [{ name: "jobs", sourcePath: dbPath }], stagingDir, retention: 1, label });
  }

  assert.ok(await readStagingOwner(stagingDir), "retention=1 must not sweep the marker away");
});

test("a snapshot that collapses in size is flagged and alerted, but still kept", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  const dbPath = makeDatabase(path.join(dir, "data", "jobs.sqlite"), 5000);
  const targets = [{ name: "jobs", sourcePath: dbPath }];

  const first = await runBackupCycle({ targets, stagingDir, retention: 5, label: "2026-08-05T08-00-00-000Z" });
  assert.equal(first.results[0]?.shrinkSuspect ?? false, false, "the first snapshot has nothing to compare against");

  const shrunk = new Database(dbPath);
  shrunk.exec("DELETE FROM items");
  shrunk.exec("VACUUM");
  shrunk.close();

  const alerts = await collectAlerts(async (webhookUrl) => {
    const second = await runBackupCycle({
      targets,
      stagingDir,
      retention: 5,
      label: "2026-08-05T09-00-00-000Z",
      webhookUrl,
    });
    // Deliberately not a failure: a genuine mass deletion still has to be
    // captured. The signal is for a human, the snapshot is for the restore.
    assert.equal(second.ok, true);
    assert.equal(second.results[0]?.shrinkSuspect, true);
  });

  assert.ok(
    alerts.some((a) => a.rule === "backup_shrink_suspect"),
    `expected a shrink alert, got ${JSON.stringify(ruleNames(alerts))}`,
  );
  const kept = (await fs.readdir(stagingDir)).filter((file) => file.endsWith(".sqlite"));
  assert.equal(kept.length, 2, "the suspect snapshot is reported, not discarded");
});

test("newestSnapshotBytes reads the latest snapshot for its own target only", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  await fs.mkdir(stagingDir, { recursive: true });
  assert.equal(await newestSnapshotBytes(stagingDir, "jobs"), null, "no snapshots yet");

  await fs.writeFile(path.join(stagingDir, "jobs-2026-08-05T08-00-00-000Z.sqlite"), "aaa");
  await fs.writeFile(path.join(stagingDir, "jobs-2026-08-05T09-00-00-000Z.sqlite"), "aaaaaaaaaa");
  await fs.writeFile(path.join(stagingDir, "app-state-2026-08-05T10-00-00-000Z.sqlite"), "z");

  assert.equal(await newestSnapshotBytes(stagingDir, "jobs"), 10, "the newest label wins, and app-state is not jobs");
});
