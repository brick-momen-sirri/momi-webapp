// Which GPU actually ran a job.
//
// A serverless endpoint is configured with a list of acceptable GPU classes, not
// one, and the worker that picks a job up decides which of them it runs on. Our
// four Still Images endpoints are each configured for two or three, and the spread
// is not small: over the 30 days to 2026-08-18, Brick_General_Enhancement_New billed
// 34.0 GPU-hours on an RTX PRO 6000 Blackwell Server Edition at $3.32/h and 11.5 on
// an RTX 5090 at $1.50/h. Identical work, 2.2x the cost, decided by whichever
// worker was free.
//
// So a per-endpoint rate cannot price a run. What can is the GPU behind the worker,
// and RunPod will name it: the GraphQL `pod` query takes the worker id that already
// arrives on every status poll and answers with machine.gpuTypeId.
//
// Two things learned probing this against the live account, both of which shape the
// code below:
//
//   1. A worker resolves only while it exists. An id RunPod no longer knows returns
//      `{ pod: null }`, not an error, and a serverless worker is torn down after its
//      idle timeout. So resolution happens during the run, off the poll that first
//      reports the id, rather than at settle.
//   2. The worker's own costPerHr is not what it bills. A PRO 6000 MIG worker
//      reported 0.59/h while billing charged 0.656-0.675/h for that GPU, ~11% more.
//      It is recorded for reference and NOT used for pricing; the rate table in
//      podRuntimeCost, which is derived from billed invoices, is what prices a run.

import { runpodApiKey } from "./config.js";

const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";

/** Long enough for a normal answer, short enough not to hold up a poll. */
const LOOKUP_TIMEOUT_MS = 5_000;

export type RunpodWorkerGpu = {
  gpuTypeId: string;
  /** The worker's self-reported hourly rate. Recorded, not billed against. */
  costPerHr?: number;
};

/**
 * Resolved workers, keyed by worker id.
 *
 * Workers are reused heavily -- a warm one takes job after job -- so without this
 * a busy endpoint would re-ask the same question every few seconds. A negative
 * result is cached too: a worker that has already gone will not come back, and
 * retrying it on every poll of every job would be the same request forever.
 */
const cache = new Map<string, RunpodWorkerGpu | null>();

/** Bounded so a long-lived dispatcher cannot accumulate every worker it ever saw. */
const CACHE_LIMIT = 500;

export function clearRunpodWorkerGpuCache() {
  cache.clear();
}

/**
 * The GPU behind a worker, or undefined when it cannot be determined.
 *
 * Never throws and never rejects. This exists to make a cost knowable; a job must
 * not fail, or even slow down noticeably, because a pricing lookup did.
 */
export async function resolveRunpodWorkerGpu(
  workerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodWorkerGpu | undefined> {
  if (!workerId || !runpodApiKey) return undefined;

  const cached = cache.get(workerId);
  if (cached !== undefined) return cached ?? undefined;

  const resolved = await lookupWorkerGpu(workerId, fetchImpl);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(workerId, resolved ?? null);
  return resolved;
}

async function lookupWorkerGpu(workerId: string, fetchImpl: typeof fetch): Promise<RunpodWorkerGpu | undefined> {
  try {
    const response = await fetchImpl(RUNPOD_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${runpodApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "query WorkerGpu($input: PodFilter) { pod(input: $input) { id costPerHr machine { gpuTypeId } } }",
        variables: { input: { podId: workerId } },
      }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`Could not resolve the GPU for worker ${workerId}: RunPod answered ${response.status}.`);
      return undefined;
    }

    const payload = (await response.json()) as {
      data?: { pod?: { costPerHr?: unknown; machine?: { gpuTypeId?: unknown } } | null };
    };
    const pod = payload.data?.pod;
    // null is the normal answer for a worker that has already been torn down, so it
    // is not worth a warning -- only an unusable answer for one that still exists.
    if (!pod) return undefined;

    const gpuTypeId = typeof pod.machine?.gpuTypeId === "string" ? pod.machine.gpuTypeId.trim() : "";
    if (!gpuTypeId) return undefined;

    const costPerHr = typeof pod.costPerHr === "number" && Number.isFinite(pod.costPerHr) ? pod.costPerHr : undefined;
    return { gpuTypeId, costPerHr };
  } catch (error) {
    // Includes the timeout. A pricing lookup is not worth a line of noise per poll,
    // but silence would hide a misconfigured key, so it is reported once per worker
    // -- which is what the cache makes true.
    console.warn(
      `Could not resolve the GPU for worker ${workerId}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return undefined;
  }
}
