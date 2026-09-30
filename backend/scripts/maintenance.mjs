// Pause or resume generation for everyone while an update is deployed.
//
//   node scripts/maintenance.mjs on ["custom message"]
//   node scripts/maintenance.mjs off
//   node scripts/maintenance.mjs status
//
// Writes the same file backend/src/maintenanceMode.ts reads; every API worker
// picks the change up within a few seconds and open browsers within one poll.
// Plain JavaScript on purpose: this is run while dist is being replaced.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = process.env.MAINTENANCE_STATE_PATH?.trim() || path.join(backendRoot, "data", "maintenance.json");
const DEFAULT_MESSAGE = "An update is about to start. Please wait a few minutes.";

const [command, ...messageParts] = process.argv.slice(2);

function read() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { enabled: false };
  }
}

function write(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporaryPath, statePath);
}

if (command === "on") {
  const message = messageParts.join(" ").trim() || DEFAULT_MESSAGE;
  write({ enabled: true, message, startedAt: new Date().toISOString() });
} else if (command === "off") {
  write({ enabled: false, message: DEFAULT_MESSAGE });
} else if (command !== "status") {
  console.error("Usage: node scripts/maintenance.mjs on [message] | off | status");
  process.exit(2);
}

console.log(JSON.stringify({ path: statePath, ...read() }));
