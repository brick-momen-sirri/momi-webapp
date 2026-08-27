import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  databaseNameFromSnapshot,
  ensureMirrorOwnership,
  isSameOrInside,
  mirrorSnapshots,
  pruneMirror,
  readMirrorOwner,
} from "./backupMirrorService.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "momi-backup-mirror-"));
}

async function writeSnapshot(dir: string, name: string, bytes = 64) {
  const filePath = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(bytes, 7));
  return filePath;
}

test("databaseNameFromSnapshot splits on the timestamp, not on the last dash", () => {
  // The label carries dashes of its own and `archived-items` carries one too, so
  // neither the first nor the last dash is the boundary.
  assert.equal(databaseNameFromSnapshot("jobs-2026-08-27T07-13-09-966Z.sqlite"), "jobs");
  assert.equal(databaseNameFromSnapshot("archived-items-2026-08-27T07-13-09-966Z.sqlite"), "archived-items");
  assert.equal(databaseNameFromSnapshot("app-state-2026-08-27T07-13-09-966Z.sqlite"), "app-state");
});

test("databaseNameFromSnapshot returns null for anything that is not one of our snapshots", () => {
  // This is what keeps pruning off files the process did not write, which
  // matters because the destination can be a shared network directory.
  for (const name of ["notes.txt", "jobs.sqlite", "backup-status.json", "jobs-latest.sqlite", "mirror-owner.json"]) {
    assert.equal(databaseNameFromSnapshot(name), null, name);
  }
});

test("isSameOrInside catches the staging directory and its children, not a sibling with a shared prefix", () => {
  const root = process.platform === "win32" ? "C:\\data\\backups" : "/data/backups";
  const child = path.join(root, "mirror");
  const sibling = `${root}-mirror`;
  assert.equal(isSameOrInside(root, root), true);
  assert.equal(isSameOrInside(child, root), true);
  assert.equal(isSameOrInside(sibling, root), false, "a name that merely starts the same is a different directory");
});

test("mirrorSnapshots refuses a destination inside the staging directory", async () => {
  const staging = await tempDir();
  const snapshot = await writeSnapshot(staging, "jobs-2026-08-27T07-13-09-966Z.sqlite");

  const result = await mirrorSnapshots({
    files: [snapshot],
    destinationDir: path.join(staging, "mirror"),
    sourceDirs: ["/data"],
    retention: 4,
    stagingDir: staging,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /staging directory/);
  assert.equal(result.files.length, 0, "nothing may be copied once the destination is refused");
});

test("mirrorSnapshots copies every snapshot and reports bytes", async () => {
  const staging = await tempDir();
  const dest = await tempDir();
  const a = await writeSnapshot(staging, "jobs-2026-08-27T07-13-09-966Z.sqlite", 128);
  const b = await writeSnapshot(staging, "app-state-2026-08-27T07-13-09-966Z.sqlite", 256);

  const result = await mirrorSnapshots({
    files: [a, b],
    destinationDir: dest,
    sourceDirs: ["/data"],
    retention: 4,
    stagingDir: staging,
  });

  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
  assert.deepEqual(
    result.files.map((entry) => [entry.file, entry.ok, entry.bytes]),
    [
      ["jobs-2026-08-27T07-13-09-966Z.sqlite", true, 128],
      ["app-state-2026-08-27T07-13-09-966Z.sqlite", true, 256],
    ],
  );
  const listed = await fs.readdir(dest);
  assert.ok(listed.includes("jobs-2026-08-27T07-13-09-966Z.sqlite"));
  assert.ok(listed.includes("app-state-2026-08-27T07-13-09-966Z.sqlite"));
});

test("mirrorSnapshots leaves no .part file behind, on success or on failure", async () => {
  const staging = await tempDir();
  const dest = await tempDir();
  const good = await writeSnapshot(staging, "jobs-2026-08-27T07-13-09-966Z.sqlite");
  const missing = path.join(staging, "app-state-2026-08-27T07-13-09-966Z.sqlite");

  const result = await mirrorSnapshots({
    files: [good, missing],
    destinationDir: dest,
    sourceDirs: ["/data"],
    retention: 4,
  });

  assert.equal(result.ok, false);
  const listed = await fs.readdir(dest);
  assert.deepEqual(
    listed.filter((file) => file.endsWith(".part")),
    [],
    "a truncated copy must never be left under a name the restore procedure trusts",
  );
});

test("mirrorSnapshots attempts every file even after one fails", async () => {
  // The Azure leg's original bug: `jobs` is first, so its failure meant the
  // other two were never attempted at all. Same list, same order.
  const staging = await tempDir();
  const dest = await tempDir();
  const missing = path.join(staging, "jobs-2026-08-27T07-13-09-966Z.sqlite");
  const present = await writeSnapshot(staging, "app-state-2026-08-27T07-13-09-966Z.sqlite", 32);

  const result = await mirrorSnapshots({
    files: [missing, present],
    destinationDir: dest,
    sourceDirs: ["/data"],
    retention: 4,
  });

  assert.equal(result.ok, false);
  assert.equal(result.files.length, 2, "both files must be reported");
  assert.equal(result.files[0].ok, false);
  assert.equal(result.files[1].ok, true, "a later file must still be copied");
  assert.match(result.error ?? "", /jobs-2026-08-27T07-13-09-966Z\.sqlite/);
  assert.ok((await fs.readdir(dest)).includes("app-state-2026-08-27T07-13-09-966Z.sqlite"));
});

test("mirrorSnapshots reports an unreachable destination as a leg failure rather than throwing", async () => {
  const staging = await tempDir();
  const snapshot = await writeSnapshot(staging, "jobs-2026-08-27T07-13-09-966Z.sqlite");
  // A file where a directory should be: mkdir recursive fails, which is the
  // shape of a share that was mapped at boot and is gone by the time a cycle
  // runs.
  const blocker = path.join(staging, "not-a-dir");
  await fs.writeFile(blocker, "x");

  const result = await mirrorSnapshots({
    files: [snapshot],
    destinationDir: path.join(blocker, "mirror"),
    sourceDirs: ["/data"],
    retention: 4,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not reachable or writable/);
});

test("mirrorSnapshots claims the destination, then refuses a different host", async () => {
  const staging = await tempDir();
  const dest = await tempDir();
  const snapshot = await writeSnapshot(staging, "jobs-2026-08-27T07-13-09-966Z.sqlite");

  const first = await mirrorSnapshots({
    files: [snapshot],
    destinationDir: dest,
    sourceDirs: ["/data"],
    retention: 4,
    host: "AZWEU1AI002",
  });
  assert.equal(first.ok, true);

  const owner = await readMirrorOwner(dest);
  assert.equal(owner?.host, "AZWEU1AI002");

  // Two hosts writing `jobs-*.sqlite` into one share would each prune to their
  // own retention count and evict the other's history. Both sets pass
  // integrity_check; nothing in the filenames would reveal it.
  const second = await mirrorSnapshots({
    files: [snapshot],
    destinationDir: dest,
    sourceDirs: ["/data"],
    retention: 4,
    host: "SOME-OTHER-HOST",
  });
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /claimed by host/);
});

test("ensureMirrorOwnership refuses a foreign source tree on the same host", async () => {
  const dest = await tempDir();
  const claimed = await ensureMirrorOwnership(dest, ["/data/prod"], { host: "H" });
  assert.equal(claimed.ok, true);

  const conflict = await ensureMirrorOwnership(dest, ["/tmp/throwaway"], { host: "H" });
  assert.equal(conflict.ok, false);
  assert.match(conflict.ok === false ? conflict.reason : "", /owned by/);

  // A target added in a directory already recorded is not a conflict.
  const same = await ensureMirrorOwnership(dest, ["/data/prod"], { host: "H" });
  assert.equal(same.ok, true);
});

test("ensureMirrorOwnership treats a corrupt marker as unclaimed rather than wedging the leg", async () => {
  const dest = await tempDir();
  await fs.writeFile(path.join(dest, "mirror-owner.json"), "{ not json");
  const verdict = await ensureMirrorOwnership(dest, ["/data"], { host: "H" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok === true ? verdict.claimed : null, true, "it should re-claim");
});

test("pruneMirror keeps the newest N per database and ignores foreign files", async () => {
  const dest = await tempDir();
  for (const label of ["2026-08-27T01-00-00-000Z", "2026-08-27T02-00-00-000Z", "2026-08-27T03-00-00-000Z"]) {
    await writeSnapshot(dest, `jobs-${label}.sqlite`);
    await writeSnapshot(dest, `archived-items-${label}.sqlite`);
  }
  await fs.writeFile(path.join(dest, "someone-elses-notes.txt"), "keep me");
  await fs.writeFile(path.join(dest, "mirror-owner.json"), "{}");

  const removed = await pruneMirror(dest, "jobs", 2);
  assert.deepEqual(removed, ["jobs-2026-08-27T01-00-00-000Z.sqlite"]);

  const listed = (await fs.readdir(dest)).sort();
  assert.ok(listed.includes("someone-elses-notes.txt"), "unrelated files must be left alone");
  assert.ok(listed.includes("mirror-owner.json"));
  assert.equal(listed.filter((file) => file.startsWith("archived-items-")).length, 3, "other databases are untouched");
});

test("mirrorSnapshots prunes the destination to its own retention count", async () => {
  const staging = await tempDir();
  const dest = await tempDir();
  for (const label of ["2026-08-27T01-00-00-000Z", "2026-08-27T02-00-00-000Z"]) {
    await writeSnapshot(dest, `jobs-${label}.sqlite`);
  }
  const fresh = await writeSnapshot(staging, "jobs-2026-08-27T03-00-00-000Z.sqlite");

  const result = await mirrorSnapshots({
    files: [fresh],
    destinationDir: dest,
    sourceDirs: ["/data"],
    retention: 2,
  });

  assert.equal(result.ok, true);
  const listed = (await fs.readdir(dest)).filter((file) => file.endsWith(".sqlite")).sort();
  assert.deepEqual(listed, ["jobs-2026-08-27T02-00-00-000Z.sqlite", "jobs-2026-08-27T03-00-00-000Z.sqlite"]);
  assert.ok(result.pruned.includes("jobs-2026-08-27T01-00-00-000Z.sqlite"));
});

test("mirrorSnapshots reports no-snapshots as a failure rather than a silent success", async () => {
  const dest = await tempDir();
  const result = await mirrorSnapshots({ files: [], destinationDir: dest, sourceDirs: ["/data"], retention: 4 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no snapshots/);
});
