// A switch that pauses new generation for everyone while an update is deployed.
//
// Why it exists: the dispatcher runs every RunPod job and must be restarted onto
// new code, but with ~100 artists at work the queue rarely empties on its own --
// on 2026-09-30 it sat between 3 and 10 active jobs for over twenty minutes. With
// this on, the API refuses new submissions, running jobs finish, and the restart
// happens against an empty queue. Nothing already queued or running is touched.
//
// State lives in one small JSON file rather than in memory or the database: every
// API worker and the dispatcher read the same file, it survives restarts, and it
// can be flipped from a shell with backend/scripts/maintenance.mjs while the app
// itself is the thing being updated.

import fs from "node:fs";
import path from "node:path";

import { maintenanceStatePath } from "./config.js";

export const DEFAULT_MAINTENANCE_MESSAGE = "An update is about to start. Please wait a few minutes.";

export type MaintenanceState = {
  enabled: boolean;
  message: string;
  /** When it was switched on, for the banner and for operators. */
  startedAt?: string;
};

const OFF: MaintenanceState = { enabled: false, message: DEFAULT_MAINTENANCE_MESSAGE };

/**
 * Re-read at most this often. Every submission and every client poll asks, and
 * two seconds is far below the time it takes anyone to notice the switch.
 */
const CACHE_MS = 2_000;
let cache: { readAt: number; state: MaintenanceState } | undefined;

export function readMaintenanceState(now = Date.now()): MaintenanceState {
  if (cache && now - cache.readAt < CACHE_MS) return cache.state;
  let state: MaintenanceState;
  try {
    state = normalizeMaintenanceState(JSON.parse(fs.readFileSync(maintenanceStatePath, "utf8")));
  } catch (error) {
    // No file is the normal case: generation is open. An unreadable one keeps the
    // last state that was read, so a half-written file cannot open the gate in the
    // middle of an update.
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!missing) console.warn(`[maintenance] could not read ${maintenanceStatePath}; keeping the previous state.`);
    state = missing ? OFF : (cache?.state ?? OFF);
  }
  cache = { readAt: now, state };
  return state;
}

export function normalizeMaintenanceState(value: unknown): MaintenanceState {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const message =
    typeof record.message === "string" && record.message.trim() ? record.message.trim() : DEFAULT_MAINTENANCE_MESSAGE;
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : undefined;
  return { enabled: record.enabled === true, message, ...(startedAt ? { startedAt } : {}) };
}

/** Written atomically, for the same reason the reader keeps its last state. */
export function writeMaintenanceState(state: MaintenanceState, filePath = maintenanceStatePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizeMaintenanceState(state), null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
  cache = undefined;
}

/** For tests: forget what was read. */
export function resetMaintenanceCache() {
  cache = undefined;
}
