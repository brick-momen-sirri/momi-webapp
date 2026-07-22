import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  backupLabel,
  buildAzcopyDest,
  rotateBackups,
  backupOneDatabase,
  runBackupCycle,
  runAzcopy,
} from "./sqliteBackupService.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "momi-sqlite-backup-"));
}

function makeWalDatabase(filePath: string) {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

test("backupLabel is filesystem-safe and lexically sortable", () => {
  const a = backupLabel(Date.parse("2026-07-22T10:00:00.000Z"));
  const b = backupLabel(Date.parse("2026-07-22T10:05:00.000Z"));
  assert.doesNotMatch(a, /[:.]/);
  assert.ok(a < b, "later timestamps must sort after earlier ones lexically");
});

test("buildAzcopyDest inserts a dated prefix before the SAS query string", () => {
  const dest = buildAzcopyDest("https://acct.blob.core.windows.net/backups?sv=2024&sig=abc", "momi/2026-07-22", "jobs-x.sqlite");
  assert.equal(dest, "https://acct.blob.core.windows.net/backups/momi/2026-07-22/jobs-x.sqlite?sv=2024&sig=abc");
});

test("buildAzcopyDest works without a query string", () => {
  const dest = buildAzcopyDest("https://acct.blob.core.windows.net/backups", "p", "f.sqlite");
  assert.equal(dest, "https://acct.blob.core.windows.net/backups/p/f.sqlite");
});

test("backupOneDatabase captures WAL-resident rows that a plain file copy would lose", async () => {
  // The real risk only exists while the writer connection stays OPEN, exactly
  // like the live dispatcher process: closing the last connection to a WAL
  // database makes SQLite auto-checkpoint on close, which would erase the very
  // scenario this test needs. So the source db is deliberately kept open across
  // both the naive copy and the real backup, and only closed at the very end.
  const dir = await tempDir();
  const sourcePath = path.join(dir, "jobs.sqlite");
  const db = makeWalDatabase(sourcePath);
  try {
    db.prepare("INSERT INTO items (id, value) VALUES (1, 'checkpointed')").run();
    db.pragma("wal_checkpoint(PASSIVE)"); // this row is now in the main file
    db.prepare("INSERT INTO items (id, value) VALUES (2, 'wal-only')").run(); // deliberately not checkpointed

    // A naive copy of just the .sqlite file (ignoring -wal), taken while the
    // writer is still open, must lose the second row.
    const naiveCopyPath = path.join(dir, "naive-copy.sqlite");
    await fs.copyFile(sourcePath, naiveCopyPath);
    const naive = new Database(naiveCopyPath, { readonly: true });
    const naiveRows = naive.prepare("SELECT id FROM items ORDER BY id").all();
    naive.close();
    assert.deepEqual(naiveRows.map((r) => r.id), [1], "sanity check: naive file copy must miss the WAL-only row");

    const result = await backupOneDatabase({ name: "jobs", sourcePath }, dir, "label1");
    assert.equal(result.ok, true);
    assert.equal(result.integrity, "ok");
    assert.ok(result.snapshotPath);

    const snapshot = new Database(result.snapshotPath!, { readonly: true });
    const rows = snapshot.prepare("SELECT id, value FROM items ORDER BY id").all();
    snapshot.close();
    assert.deepEqual(rows, [
      { id: 1, value: "checkpointed" },
      { id: 2, value: "wal-only" },
    ], "the online backup must include WAL-only rows the naive copy missed");

    // No leftover .tmp file.
    const files = await fs.readdir(dir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
  } finally {
    db.close();
  }
});

test("backupOneDatabase leaves no -wal/-shm sidecars behind after a successful backup", async () => {
  // The online backup API copies the source's header verbatim, so the tmp
  // snapshot still claims WAL mode even though it's a static, single-owner
  // file. Opening it (even read-only) to verify integrity would otherwise
  // materialize tmpPath-wal/-shm sidecars that fs.rename never carries over to
  // destPath -- they'd orphan under the old tmp name forever, invisible to
  // rotation (which only matches "*.sqlite"), leaking disk every single cycle.
  const dir = await tempDir();
  const sourcePath = path.join(dir, "jobs.sqlite");
  makeWalDatabase(sourcePath).close();

  const result = await backupOneDatabase({ name: "jobs", sourcePath }, dir, "label1");
  assert.equal(result.ok, true);

  // Scope the assertion to the SNAPSHOT's own name prefix, not the source
  // database's (whatever the source connection's own close-time WAL behavior
  // is is a separate concern from the bug being guarded here).
  const snapshotFiles = (await fs.readdir(dir)).filter((f) => f.startsWith("jobs-label1")).sort();
  assert.deepEqual(snapshotFiles, ["jobs-label1.sqlite"], "only the finished snapshot may remain -- no .tmp, no -wal, no -shm");
});

test("backupOneDatabase fails cleanly when the source file does not exist", async () => {
  const dir = await tempDir();
  const result = await backupOneDatabase({ name: "missing", sourcePath: path.join(dir, "nope.sqlite") }, dir, "label1");
  assert.equal(result.ok, false);
  assert.ok(result.error);
  const files = await fs.readdir(dir).catch(() => []);
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "no leftover tmp file on failure");
});

test("rotateBackups keeps only the newest N snapshots per database name", async () => {
  const dir = await tempDir();
  const labels = ["2026-07-20T00-00-00-000Z", "2026-07-21T00-00-00-000Z", "2026-07-22T00-00-00-000Z", "2026-07-22T01-00-00-000Z"];
  for (const label of labels) {
    await fs.writeFile(path.join(dir, `jobs-${label}.sqlite`), "x");
  }
  // An unrelated database's file must never be touched by jobs' rotation.
  await fs.writeFile(path.join(dir, "app-state-2020-01-01T00-00-00-000Z.sqlite"), "x");

  const removed = await rotateBackups(dir, "jobs", 2);
  assert.equal(removed.length, 2);
  const remaining = (await fs.readdir(dir)).filter((f) => f.startsWith("jobs-"));
  assert.deepEqual(remaining.sort(), [`jobs-${labels[2]}.sqlite`, `jobs-${labels[3]}.sqlite`].sort());
  assert.ok((await fs.readdir(dir)).includes("app-state-2020-01-01T00-00-00-000Z.sqlite"));
});

test("rotateBackups is a no-op when the directory does not exist yet", async () => {
  const dir = path.join(os.tmpdir(), `momi-sqlite-backup-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const removed = await rotateBackups(dir, "jobs", 2);
  assert.deepEqual(removed, []);
});

test("runBackupCycle snapshots every target, rotates, and writes a status file", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  const dbAPath = path.join(dir, "a.sqlite");
  const dbBPath = path.join(dir, "b.sqlite");
  makeWalDatabase(dbAPath).close();
  makeWalDatabase(dbBPath).close();

  const cycle = await runBackupCycle({
    targets: [
      { name: "a", sourcePath: dbAPath },
      { name: "b", sourcePath: dbBPath },
    ],
    stagingDir,
    retention: 5,
    label: "fixed-label",
  });

  assert.equal(cycle.ok, true);
  assert.equal(cycle.uploaded, false); // no uploader configured
  assert.equal(cycle.results.length, 2);
  assert.ok(cycle.results.every((r) => r.ok));

  const status = JSON.parse(await fs.readFile(cycle.statusPath, "utf8"));
  assert.equal(status.ok, true);
  assert.equal(status.results.length, 2);
});

test("runBackupCycle calls the uploader with exactly the successful snapshot paths, and marks results uploaded", async () => {
  const dir = await tempDir();
  const dbPath = path.join(dir, "a.sqlite");
  makeWalDatabase(dbPath).close();
  const uploadedFiles: string[] = [];

  const cycle = await runBackupCycle({
    targets: [{ name: "a", sourcePath: dbPath }],
    stagingDir: path.join(dir, "staging"),
    retention: 5,
    label: "fixed-label",
    uploader: async (files) => {
      uploadedFiles.push(...files);
    },
  });

  assert.equal(cycle.ok, true);
  assert.equal(cycle.uploaded, true);
  assert.equal(uploadedFiles.length, 1);
  assert.match(uploadedFiles[0], /a-fixed-label\.sqlite$/);
  assert.equal(cycle.results[0].uploaded, true);
});

test("runBackupCycle reports ok=false when the uploader fails, without throwing", async () => {
  const dir = await tempDir();
  const dbPath = path.join(dir, "a.sqlite");
  makeWalDatabase(dbPath).close();

  const cycle = await runBackupCycle({
    targets: [{ name: "a", sourcePath: dbPath }],
    stagingDir: path.join(dir, "staging"),
    retention: 5,
    label: "fixed-label",
    uploader: async () => {
      throw new Error("network unreachable");
    },
  });

  assert.equal(cycle.ok, false);
  assert.equal(cycle.uploaded, false);
  assert.equal(cycle.results[0].ok, true, "the local snapshot itself still succeeded");
  assert.equal(cycle.results[0].uploaded, undefined);
});

test("runBackupCycle is ok=false when any target's snapshot fails, and still snapshots the rest", async () => {
  const dir = await tempDir();
  const dbPath = path.join(dir, "a.sqlite");
  makeWalDatabase(dbPath).close();

  const cycle = await runBackupCycle({
    targets: [
      { name: "a", sourcePath: dbPath },
      { name: "missing", sourcePath: path.join(dir, "nope.sqlite") },
    ],
    stagingDir: path.join(dir, "staging"),
    retention: 5,
    label: "fixed-label",
  });

  assert.equal(cycle.ok, false);
  assert.equal(cycle.results.find((r) => r.name === "a")?.ok, true);
  assert.equal(cycle.results.find((r) => r.name === "missing")?.ok, false);
});

// --- Regression tests for the adversarial-review findings ---

test("backupOneDatabase returns ok=false (never a thrown rejection) when an unexpected FS error hits its setup step", async () => {
  // A real Windows scenario: something (AV scanner, search indexer, a lingering
  // handle from a prior crashed run) leaves an unexpected directory sitting at
  // the .tmp path. fs.rm(path, {force:true}) without {recursive:true} throws
  // ERR_FS_EISDIR for a directory regardless of `force` -- `force` only
  // suppresses ENOENT. Before the fix, this call sat OUTSIDE backupOneDatabase's
  // try/catch, so it escaped as a rejected promise instead of a clean result.
  const dir = await tempDir();
  const sourcePath = path.join(dir, "jobs.sqlite");
  makeWalDatabase(sourcePath).close();
  const label = "label1";
  const tmpPath = path.join(dir, `jobs-${label}.sqlite.tmp`);
  await fs.mkdir(tmpPath);

  const result = await backupOneDatabase({ name: "jobs", sourcePath }, dir, label);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("runBackupCycle isolates a malformed target from the rest of the cycle and still rotates", async () => {
  const dir = await tempDir();
  const stagingDir = path.join(dir, "staging");
  const goodPath = path.join(dir, "good.sqlite");
  makeWalDatabase(goodPath).close();

  // Pre-seed 3 stale "good" snapshots so we can prove rotation still ran even
  // though the sibling target throws before backupOneDatabase's own try/catch
  // even begins (accessing `.name` on a null target).
  await fs.mkdir(stagingDir, { recursive: true });
  for (const label of ["2020-01-01T00-00-00-000Z", "2020-01-02T00-00-00-000Z", "2020-01-03T00-00-00-000Z"]) {
    await fs.writeFile(path.join(stagingDir, `good-${label}.sqlite`), "x");
  }

  const cycle = await runBackupCycle({
    targets: [
      null as unknown as { name: string; sourcePath: string },
      { name: "good", sourcePath: goodPath },
    ],
    stagingDir,
    retention: 1,
    label: "fixed-label",
  });

  assert.equal(cycle.ok, false);
  assert.equal(cycle.results.length, 2);
  const good = cycle.results.find((r) => r.name === "good");
  const bad = cycle.results.find((r) => r.name !== "good");
  assert.equal(good?.ok, true, "the sibling target must still be attempted and succeed");
  assert.equal(bad?.ok, false);
  assert.ok(bad?.error, "the malformed-target error must be captured, not thrown");

  const remainingGood = (await fs.readdir(stagingDir)).filter((f) => f.startsWith("good-"));
  assert.equal(remainingGood.length, 1, "rotation must still run for the healthy target (retention=1)");
  assert.equal(remainingGood[0], "good-fixed-label.sqlite", "the newest snapshot, not a stale one, must survive rotation");
});

test("a failing cycle's alert reaches a configured webhook, not just the console", async () => {
  const received: unknown[] = [];
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
  const webhookUrl = `http://127.0.0.1:${address.port}/hook`;

  try {
    const dir = await tempDir();
    const dbPath = path.join(dir, "a.sqlite");
    makeWalDatabase(dbPath).close();

    await runBackupCycle({
      targets: [{ name: "a", sourcePath: dbPath }],
      stagingDir: path.join(dir, "staging"),
      retention: 5,
      label: "fixed-label",
      uploader: async () => {
        throw new Error("network unreachable");
      },
      webhookUrl,
      role: "dispatcher",
    });

    // The webhook POST is fire-and-forget; give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.ok(received.length >= 1, "the webhook must receive at least one alert POST");
  const rules = received.map((event) => (event as { rule: string }).rule);
  assert.ok(rules.includes("backup_upload_failed"), `expected backup_upload_failed among ${JSON.stringify(rules)}`);
  const first = received[0] as { role: string; severity: string; detail: string };
  assert.equal(first.role, "dispatcher");
  assert.equal(first.severity, "critical");
});

test("runAzcopy rejects on a timeout instead of hanging forever on a stuck child", async () => {
  const slowScript = "setTimeout(() => {}, 10000);"; // never voluntarily exits within the test's patience
  const startedAt = Date.now();
  await assert.rejects(
    runAzcopy(process.execPath, ["-e", slowScript], 300),
    /timed out after 300ms/,
  );
  assert.ok(Date.now() - startedAt < 5000, "must reject promptly by killing the child, not by waiting it out");
});

test("runAzcopy drains stdout so a chatty child cannot block on a full OS pipe buffer", async () => {
  // Comfortably larger than a default OS pipe buffer (commonly 64KB). Without
  // draining stdout, the child's write() blocks once the buffer fills and it
  // never reaches process.exit(0) -- this test would then hit the timeout
  // below and fail, which is exactly the hang this regression test guards.
  const chattyScript = 'process.stdout.write("x".repeat(5 * 1024 * 1024)); process.exit(0);';
  await runAzcopy(process.execPath, ["-e", chattyScript], 5000);
});
