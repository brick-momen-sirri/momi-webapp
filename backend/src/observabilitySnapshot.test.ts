import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { buildObservabilitySnapshot, freeDiskBytes } from "./observabilitySnapshot.js";

// This snapshot is the single source for /metrics, /api/health and the watchdog's
// alert decisions. If a field goes missing or changes shape, the dashboard shows
// a blank gauge and the watchdog stops firing on it -- both silent failures.

test("freeDiskBytes reports a positive figure for a real directory", async () => {
  const bytes = await freeDiskBytes(os.tmpdir());
  assert.equal(typeof bytes, "number");
  assert.ok((bytes ?? 0) > 0, "a writable temp directory must report free space");
});

test("freeDiskBytes returns null for a path that does not exist", async () => {
  // null rather than 0: a failed statfs must not look like a full disk, or the
  // watchdog's disk-space rule would fire continuously.
  assert.equal(await freeDiskBytes(path.join(os.tmpdir(), "momi-does-not-exist-zzz", "nested")), null);
});

test("the snapshot carries every field /metrics and the watchdog read", async () => {
  const snapshot = await buildObservabilitySnapshot();

  assert.equal(typeof snapshot.role, "string");
  assert.equal(snapshot.pid, process.pid);
  assert.ok(snapshot.instance === null || typeof snapshot.instance === "string");
  assert.equal(typeof snapshot.uptimeSeconds, "number");
  assert.ok(snapshot.uptimeSeconds >= 0);
  assert.equal(typeof snapshot.nowMs, "number");

  for (const key of ["queued", "active", "runpodActive", "capacity"] as const) {
    assert.equal(typeof snapshot.queue[key], "number", `queue.${key}`);
  }

  assert.equal(typeof snapshot.memory.rssMiB, "number");
  assert.equal(typeof snapshot.memory.heapUsedMiB, "number");
  assert.ok(snapshot.memory.rssMiB > 0, "a running process has resident memory");
  assert.ok(snapshot.outputDiskFreeBytes === null || typeof snapshot.outputDiskFreeBytes === "number");
});

test("the dispatcher block is always fully populated booleans, never undefined", async () => {
  const { dispatcher } = (await buildObservabilitySnapshot()).queue;

  // These feed the dispatch-outage rule. An undefined here would be falsy and so
  // read as "dispatch is fine", which is exactly backwards.
  assert.equal(typeof dispatcher.enabled, "boolean");
  assert.equal(typeof dispatcher.active, "boolean");
  assert.equal(typeof dispatcher.heldByThisProcess, "boolean");
  // The nullable fields must be null rather than undefined, so they survive
  // JSON.stringify into the /api/health body.
  for (const key of ["ownerId", "heartbeatAt", "expiresAt"] as const) {
    assert.ok(dispatcher[key] === null || typeof dispatcher[key] === "string", `dispatcher.${key}`);
  }
});

test("mediaIndex is either fully populated numbers or explicitly null", async () => {
  const { mediaIndex } = await buildObservabilitySnapshot();
  if (mediaIndex === null) {
    // Valid: the index is only built on the roles that own it.
    return;
  }
  for (const key of ["dirtyRevision", "builtRevision", "cachedRevision", "cachedItems"] as const) {
    assert.equal(typeof mediaIndex[key], "number", `mediaIndex.${key}`);
  }
});

test("the snapshot survives JSON round-tripping, since that is how it is served", async () => {
  const snapshot = await buildObservabilitySnapshot();
  const roundTripped = JSON.parse(JSON.stringify(snapshot));
  // No undefined values, no BigInt, nothing that would silently vanish from the
  // /api/health response body.
  assert.deepEqual(Object.keys(roundTripped).sort(), Object.keys(snapshot).sort());
  assert.deepEqual(Object.keys(roundTripped.queue.dispatcher).sort(), Object.keys(snapshot.queue.dispatcher).sort());
});

test("two consecutive snapshots move nowMs forward and keep pid stable", async () => {
  const first = await buildObservabilitySnapshot();
  const second = await buildObservabilitySnapshot();
  assert.ok(second.nowMs >= first.nowMs);
  assert.equal(second.pid, first.pid);
});
