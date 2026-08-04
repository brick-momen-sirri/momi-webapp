// Operator surface: health, Prometheus metrics, the dashboard and its inputs.
// Mounted BEFORE the session middleware because a scraper has no session; each
// route carries requireOpsAccess instead (loopback, or OPS_ACCESS_TOKEN).

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getRecentAlerts } from "../alertHistory.js";
import {
  backupEnabled,
  backupStagingDir,
  brickProjectsRoot,
  generationBackend,
  watchdogDiskFreeMinBytes,
  watchdogMemoryHighMiB,
  watchdogQueueStallEvals,
} from "../config.js";
import { getQueueSnapshot } from "../jobQueue.js";
import { getMediaIndexStatus } from "../mediaService.js";
import { renderPrometheusMetrics } from "../observabilityMetrics.js";
import { buildObservabilitySnapshot, freeDiskBytes } from "../observabilitySnapshot.js";
import { requireOpsAccess } from "../opsAccessGuard.js";
import { OPS_DASHBOARD_HTML } from "../opsDashboardPage.js";
import { backendProcessRole } from "../processRole.js";

export const opsRouter = express.Router();

// The ops surface below sits above requireAuth (a scraper has no session) so it
// carries its own guard: loopback, or OPS_ACCESS_TOKEN. See opsAccessGuard.ts.
opsRouter.get("/api/health", requireOpsAccess, async (_req, res) => {
  const queue = getQueueSnapshot();
  const memory = process.memoryUsage();
  const outputDiskFreeBytes = await freeDiskBytes(brickProjectsRoot);
  res.json({
    ok: true,
    service: "momi-animation-backend",
    role: backendProcessRole,
    pid: process.pid,
    time: new Date().toISOString(),
    generationBackend,
    uptimeSeconds: Math.round(process.uptime()),
    queue: {
      queued: queue.queued,
      active: queue.active,
      runpodActive: queue.runpodActive,
      capacity: queue.capacity,
      dispatcher: queue.dispatcher,
    },
    mediaIndex: getMediaIndexStatus(),
    memory: {
      rssMiB: Math.round(memory.rss / 1024 / 1024),
      heapUsedMiB: Math.round(memory.heapUsed / 1024 / 1024),
    },
    outputDiskFreeBytes,
  });
});

opsRouter.get("/metrics", requireOpsAccess, async (_req, res) => {
  const snapshot = await buildObservabilitySnapshot();
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderPrometheusMetrics(snapshot));
});

// Static config the ops dashboard needs to color its own gauges the same way
// the real watchdog would judge them -- fetched once on load, not polled.
opsRouter.get("/api/ops-config", requireOpsAccess, (_req, res) => {
  res.json({
    role: backendProcessRole,
    watchdogMemoryHighMiB,
    watchdogDiskFreeMinBytes,
    watchdogQueueStallEvals,
    backupEnabled,
  });
});

opsRouter.get("/api/alerts/recent", requireOpsAccess, (_req, res) => {
  res.json({ alerts: getRecentAlerts() });
});

opsRouter.get("/api/backup-status", requireOpsAccess, async (_req, res) => {
  try {
    const raw = await fs.readFile(path.join(backupStagingDir, "backup-status.json"), "utf8");
    res.json({ status: JSON.parse(raw) });
  } catch {
    res.json({ status: null });
  }
});

opsRouter.get("/ops-dashboard", requireOpsAccess, (_req, res) => {
  res.type("html").send(OPS_DASHBOARD_HTML);
});
