import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _resetStorageCanaryStateForTests, probeStorage, runStorageCanaryOnce, stopStorageCanary } from "./storageCanaryService.js";
import { _resetAlertHistoryForTests, getRecentAlerts } from "./alertHistory.js";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "momi-canary-"));
}

test("probeStorage succeeds on a writable root and leaves nothing behind", async () => {
  const root = await tempRoot();
  const result = await probeStorage(root);

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.ok(result.durationMs >= 0);

  const leftovers = (await fs.readdir(root)).filter((f) => f.includes("canary"));
  assert.deepEqual(leftovers, [], "probe file must be cleaned up");

  await fs.rm(root, { recursive: true, force: true });
});

test("probeStorage reports failure for an unreachable root instead of throwing", async () => {
  // A UNC path to a host that does not exist is the shape of the real outage.
  const result = await probeStorage("\\\\10.255.255.1\\nope$\\momi");

  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0, "should carry an error string");
});

test("canary fires once on failure and resolves on recovery", async () => {
  _resetStorageCanaryStateForTests();
  _resetAlertHistoryForTests();

  const bad = "\\\\10.255.255.1\\nope$\\momi";
  const good = await tempRoot();

  await runStorageCanaryOnce({ root: bad, intervalMs: 1000 });
  let alerts = getRecentAlerts().filter((a) => a.rule === "storage_unreachable");
  assert.equal(alerts.length, 1, "first failure should fire exactly one alert");
  assert.equal(alerts[0].phase, "firing");
  assert.equal(alerts[0].severity, "critical");

  // A second consecutive failure must not page again.
  await runStorageCanaryOnce({ root: bad, intervalMs: 1000 });
  alerts = getRecentAlerts().filter((a) => a.rule === "storage_unreachable");
  assert.equal(alerts.length, 1, "repeat failures must not re-page");

  await runStorageCanaryOnce({ root: good, intervalMs: 1000 });
  alerts = getRecentAlerts().filter((a) => a.rule === "storage_unreachable");
  assert.equal(alerts.length, 2, "recovery should emit a resolve");
  assert.equal(alerts.find((a) => a.phase === "resolved")?.phase, "resolved");

  stopStorageCanary();
  await fs.rm(good, { recursive: true, force: true });
});

test("a healthy root never pages", async () => {
  _resetStorageCanaryStateForTests();
  _resetAlertHistoryForTests();

  const root = await tempRoot();
  await runStorageCanaryOnce({ root, intervalMs: 1000 });
  await runStorageCanaryOnce({ root, intervalMs: 1000 });

  assert.deepEqual(getRecentAlerts().filter((a) => a.rule === "storage_unreachable"), []);

  stopStorageCanary();
  await fs.rm(root, { recursive: true, force: true });
});
