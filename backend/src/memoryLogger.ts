import { isDispatcher } from "./processRole.js";

function bytesToMiB(bytes: number) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

export function logMemory(stage: string, jobId?: string) {
  if (!isDispatcher()) return;
  const memory = process.memoryUsage();
  console.info("[memory]", {
    stage,
    ...(jobId ? { jobId } : {}),
    rssMiB: bytesToMiB(memory.rss),
    heapUsedMiB: bytesToMiB(memory.heapUsed),
    heapTotalMiB: bytesToMiB(memory.heapTotal),
    externalMiB: bytesToMiB(memory.external),
    arrayBuffersMiB: bytesToMiB(memory.arrayBuffers),
  });
}

export function startMemoryLogging(intervalMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  setInterval(() => logMemory("periodic"), intervalMs).unref();
}
