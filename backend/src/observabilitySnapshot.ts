// Single source of truth for /metrics and the health watchdog, mirroring the
// signals /api/health exposes so scrape data and alert decisions never diverge.

import fs from "node:fs/promises";
import { brickProjectsRoot } from "./config.js";
import { getQueueSnapshot } from "./jobQueue.js";
import { getMediaIndexStatus } from "./mediaService.js";
import { backendProcessRole } from "./processRole.js";
import type { ObservabilitySnapshot } from "./observabilityMetrics.js";

export async function freeDiskBytes(targetPath: string) {
  try {
    const stats = await fs.statfs(targetPath);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

// Single source of truth for /metrics and the health watchdog, mirroring the
// signals /api/health exposes so scrape data and alert decisions never diverge.
export async function buildObservabilitySnapshot(): Promise<ObservabilitySnapshot> {
  const queue = getQueueSnapshot();
  const memory = process.memoryUsage();
  const outputDiskFreeBytes = await freeDiskBytes(brickProjectsRoot);
  const media = getMediaIndexStatus();
  return {
    role: backendProcessRole,
    pid: process.pid,
    instance: process.env.NODE_APP_INSTANCE ?? null,
    uptimeSeconds: Math.round(process.uptime()),
    nowMs: Date.now(),
    queue: {
      queued: queue.queued,
      active: queue.active,
      runpodActive: queue.runpodActive,
      capacity: queue.capacity,
      dispatcher: {
        enabled: !!queue.dispatcher.enabled,
        active: !!queue.dispatcher.active,
        heldByThisProcess: !!queue.dispatcher.heldByThisProcess,
        ownerId: queue.dispatcher.ownerId ?? null,
        heartbeatAt: queue.dispatcher.heartbeatAt ?? null,
        expiresAt: queue.dispatcher.expiresAt ?? null,
      },
    },
    mediaIndex: media
      ? {
          dirtyRevision: media.dirtyRevision ?? 0,
          builtRevision: media.builtRevision ?? 0,
          cachedRevision: media.cachedRevision ?? 0,
          cachedItems: media.cachedItems ?? 0,
        }
      : null,
    memory: {
      rssMiB: Math.round(memory.rss / 1024 / 1024),
      heapUsedMiB: Math.round(memory.heapUsed / 1024 / 1024),
    },
    outputDiskFreeBytes,
  };
}
