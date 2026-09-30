import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-maintenance-"));
const statePath = path.join(tempRoot, "maintenance.json");
// Before config loads, so nothing here reads or writes the host's real switch.
process.env.MAINTENANCE_STATE_PATH = statePath;

const { DEFAULT_MAINTENANCE_MESSAGE, readMaintenanceState, resetMaintenanceCache, writeMaintenanceState } =
  await import("./maintenanceMode.js");

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("no switch file means generation is open", () => {
  resetMaintenanceCache();
  assert.deepEqual(readMaintenanceState(), { enabled: false, message: DEFAULT_MAINTENANCE_MESSAGE });
});

test("a written state is read back, and the default message fills an empty one", () => {
  writeMaintenanceState({ enabled: true, message: "  ", startedAt: "2026-09-30T13:00:00.000Z" });
  assert.deepEqual(readMaintenanceState(), {
    enabled: true,
    message: DEFAULT_MAINTENANCE_MESSAGE,
    startedAt: "2026-09-30T13:00:00.000Z",
  });
  writeMaintenanceState({ enabled: false, message: "done" });
  assert.equal(readMaintenanceState().enabled, false);
});

test("an unreadable file keeps the last state rather than reopening the gate", async () => {
  writeMaintenanceState({ enabled: true, message: "Updating" });
  const now = Date.now();
  assert.equal(readMaintenanceState(now).enabled, true);
  await fs.writeFile(statePath, '{"enabled": tr');
  assert.equal(readMaintenanceState(now + 5_000).enabled, true);
});

test("the operator script and the server agree on the file", async () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "maintenance.mjs");
  const env = { ...process.env, MAINTENANCE_STATE_PATH: statePath };

  const on = JSON.parse((await execFileAsync(process.execPath, [script, "on", "Back", "in", "5"], { env })).stdout);
  assert.equal(on.enabled, true);
  resetMaintenanceCache();
  assert.equal(readMaintenanceState().message, "Back in 5");

  await execFileAsync(process.execPath, [script, "off"], { env });
  resetMaintenanceCache();
  assert.equal(readMaintenanceState().enabled, false);
});
