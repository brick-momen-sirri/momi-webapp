import { generationBackend, localComfyEnabled, runpodApiKey, runpodEndpointId, runpodHealthUrl } from "./config.js";
import { getServers, refreshServers } from "./comfyPool.js";
import { getQueueSnapshot } from "./jobQueue.js";

type PodDisplayStatus = "idle" | "running" | "queued" | "stopped" | "error";

type RunpodHealthStats = {
  workers: {
    available: number;
    running: number;
    idle: number;
    stopped: number;
    unavailable: number;
    initializing: number;
    throttled: number;
  };
  jobs: {
    queued: number;
    running: number;
    completed?: number;
    failed?: number;
  };
};

type RunpodHealthResult =
  | { available: true; stats: RunpodHealthStats }
  | { available: false; error: string };

export async function getPodStatus(fetchImpl: typeof fetch = fetch) {
  const queue = getQueueSnapshot();
  const updatedAt = new Date().toISOString();

  if (localComfyEnabled) {
    await refreshServers();
    const servers = getServers();
    const running = servers.filter((server) => server.status === "busy").length;
    const idle = servers.filter((server) => server.status === "idle").length;
    const stopped = servers.filter((server) => server.status === "offline" || server.status === "error").length;
    const unavailable = servers.filter((server) => server.status === "error").length;

    return {
      backend: generationBackend,
      status: overallStatus({ queued: queue.queued, running, idle, stopped, unavailable }),
      available: running + idle,
      running,
      idle,
      stopped,
      unavailable,
      queued: queue.queued,
      hasQueuedTasks: queue.queued > 0,
      capacity: servers.length,
      queue,
      pods: servers.map((server) => ({
        id: server.url,
        label: server.port ? `Comfy ${server.port}` : server.url,
        status: server.status === "busy" ? "running" : server.status === "offline" ? "stopped" : server.status,
        message: server.errorMessage,
        updatedAt: server.lastChecked,
        currentJob: queue.activeJobs.find((job) => job.comfyServerUrl === server.url),
      })),
      updatedAt,
    };
  }

  const health = await fetchRunpodHealth(fetchImpl);
  const healthStats = health.available ? health.stats : undefined;
  const running = healthStats?.workers.running ?? queue.active;
  const idle = healthStats?.workers.idle ?? Math.max(0, queue.capacity - queue.active);
  const stopped = healthStats ? healthStats.workers.stopped + healthStats.workers.initializing : 0;
  const unavailable = healthStats?.workers.unavailable ?? 0;
  const queued = Math.max(queue.queued, healthStats?.jobs.queued ?? 0);
  const capacity = Math.max(queue.capacity, running + idle + stopped + unavailable);

  return {
    backend: generationBackend,
    status: health.available
      ? overallStatus({ queued, running, idle, stopped, unavailable })
      : queue.active || queued
        ? overallStatus({ queued, running: queue.active, idle: 0, stopped: 0, unavailable: 0 })
        : "error" as PodDisplayStatus,
    available: running + idle,
    running,
    idle,
    stopped,
    unavailable,
    queued,
    hasQueuedTasks: queued > 0,
    capacity,
    queue,
    pods: runpodPods(queue),
    runpod: {
      endpointConfigured: Boolean(runpodEndpointId && runpodApiKey),
      endpointLabel: runpodEndpointId ? `...${runpodEndpointId.slice(-6)}` : undefined,
      healthAvailable: health.available,
      healthError: health.available ? undefined : health.error,
      health: healthStats,
    },
    updatedAt,
  };
}

export function normalizeRunpodHealth(raw: unknown): RunpodHealthStats {
  const workersValue = getField(raw, "workers") ?? getField(raw, "worker") ?? getField(raw, "workerStates") ?? raw;
  const jobsValue = getField(raw, "jobs") ?? getField(raw, "job") ?? getField(raw, "queue") ?? raw;
  const workerCounts = countWorkerStates(workersValue);
  const jobCounts = countJobStates(jobsValue);

  return {
    workers: {
      available: workerCounts.running + workerCounts.idle,
      running: workerCounts.running,
      idle: workerCounts.idle,
      stopped: workerCounts.stopped,
      unavailable: workerCounts.unavailable,
      initializing: workerCounts.initializing,
      throttled: workerCounts.throttled,
    },
    jobs: jobCounts,
  };
}

async function fetchRunpodHealth(fetchImpl: typeof fetch): Promise<RunpodHealthResult> {
  if (!runpodHealthUrl || !runpodApiKey) {
    return { available: false, error: "RunPod health is not configured." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(runpodHealthUrl, {
      headers: { Authorization: `Bearer ${runpodApiKey}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      return { available: false, error: `RunPod health returned ${response.status}.` };
    }
    return { available: true, stats: normalizeRunpodHealth(body) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : "Could not reach RunPod health." };
  } finally {
    clearTimeout(timeout);
  }
}

function overallStatus({
  queued,
  running,
  idle,
  stopped,
  unavailable,
}: {
  queued: number;
  running: number;
  idle: number;
  stopped: number;
  unavailable: number;
}): PodDisplayStatus {
  if (unavailable > 0 && running === 0 && idle === 0) return "error";
  if (queued > 0) return "queued";
  if (running > 0) return "running";
  if (idle > 0) return "idle";
  if (stopped > 0) return "stopped";
  return "idle";
}

function runpodPods(queue: ReturnType<typeof getQueueSnapshot>) {
  if (!queue.activeJobs.length) {
    return [];
  }

  return queue.activeJobs.map((job, index) => ({
    id: `runpod-slot-${index + 1}`,
    label: `RunPod slot ${index + 1}`,
    status: job.status === "sending" ? "queued" : "running",
    currentJob: job,
  }));
}

function countWorkerStates(value: unknown) {
  const fromList = countStateList(value, {
    running: ["running", "busy", "active", "in_progress", "inprogress"],
    idle: ["idle", "ready", "available"],
    stopped: ["stopped", "scaled_down", "scaleddown", "offline"],
    unavailable: ["unavailable", "unhealthy", "error", "failed"],
    initializing: ["initializing", "starting", "cold_start", "coldstart"],
    throttled: ["throttled"],
  });
  const record = isRecord(value) ? value : {};

  return {
    running: fromList.running + countKeys(record, ["running", "busy", "active", "in_progress", "inprogress"]),
    idle: fromList.idle + countMaxKey(record, ["idle", "ready", "available"]),
    stopped: fromList.stopped + countKeys(record, ["stopped", "scaled_down", "scaleddown", "offline"]),
    unavailable: fromList.unavailable + countKeys(record, ["unavailable", "unhealthy", "error", "failed"]),
    initializing: fromList.initializing + countKeys(record, ["initializing", "starting", "cold_start", "coldstart"]),
    throttled: fromList.throttled + countKeys(record, ["throttled"]),
  };
}

function countJobStates(value: unknown) {
  const fromList = countStateList(value, {
    queued: ["queued", "in_queue", "inqueue", "pending"],
    running: ["running", "in_progress", "inprogress", "processing"],
    completed: ["completed", "complete", "succeeded", "success"],
    failed: ["failed", "error", "timed_out", "timedout", "cancelled", "canceled"],
  });
  const record = isRecord(value) ? value : {};

  return {
    queued: fromList.queued + countKeys(record, ["queued", "in_queue", "inqueue", "pending"]),
    running: fromList.running + countKeys(record, ["running", "in_progress", "inprogress", "processing"]),
    completed: fromList.completed + countKeys(record, ["completed", "complete", "succeeded", "success"]),
    failed: fromList.failed + countKeys(record, ["failed", "error", "timed_out", "timedout", "cancelled", "canceled"]),
  };
}

function countStateList(value: unknown, aliases: Record<string, string[]>) {
  const counts = Object.fromEntries(Object.keys(aliases).map((key) => [key, 0])) as Record<string, number>;
  if (!Array.isArray(value)) {
    return counts;
  }

  for (const item of value) {
    const state = String(getField(item, "status") ?? getField(item, "state") ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const [key, values] of Object.entries(aliases)) {
      if (values.map(normalizeKey).includes(state)) {
        counts[key] += 1;
      }
    }
  }

  return counts;
}

function countKeys(record: Record<string, unknown>, aliases: string[]) {
  const wanted = new Set(aliases.map(normalizeKey));
  let total = 0;
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(normalizeKey(key))) continue;
    if (typeof value === "number" && Number.isFinite(value)) total += value;
    else if (typeof value === "string" && Number.isFinite(Number(value))) total += Number(value);
  }
  return total;
}

function countMaxKey(record: Record<string, unknown>, aliases: string[]) {
  const wanted = new Set(aliases.map(normalizeKey));
  let max = 0;
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(normalizeKey(key))) continue;
    if (typeof value === "number" && Number.isFinite(value)) max = Math.max(max, value);
    else if (typeof value === "string" && Number.isFinite(Number(value))) max = Math.max(max, Number(value));
  }
  return max;
}

function getField(value: unknown, key: string) {
  if (!isRecord(value)) {
    return undefined;
  }
  const wanted = normalizeKey(key);
  const entry = Object.entries(value).find(([current]) => normalizeKey(current) === wanted);
  return entry?.[1];
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
