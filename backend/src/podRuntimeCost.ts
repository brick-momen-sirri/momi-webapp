// What a run on one of our own pods actually cost.
//
// The Animation models bill at provider list prices, so their spend arrives with
// the result as credit_usage. The Still Images presets do not: they run on RunPod
// serverless endpoints the studio rents by the second, and those workers report no
// usage figures at all. Until now the only number available for them was the flat
// per-preset estimate in stillImageModels, which nobody had measured -- and because
// counting an unmeasured estimate as spend would inflate every total it landed in,
// they were excluded from accounting entirely and displayed "--".
//
// Two facts make a measured figure possible. RunPod reports how long a worker spent
// on the job (executionTime, on the status response the poller already reads), and
// it will name the GPU behind that worker (see runpodWorkerGpu). Seconds times the
// GPU's rate is a measurement, not a guess.
//
// The rate has to be per GPU rather than per endpoint, because an endpoint is
// configured with a list of acceptable GPU classes and the worker that takes the job
// decides which one it runs on. All four Still Images endpoints are configured for
// two or three, and they are not close in price.
//
// Where the rates come from: /v1/billing/endpoints returns billed `amount` and
// `timeBilledMs` grouped by GPU, so the account's own invoices give the rate
// directly. Over the 30 days to 2026-08-18, across 198 daily buckets and five
// endpoints, each GPU's implied rate held to within 0.5% -- these are not list
// prices scraped off a page, they are what was charged.

import { runpodApiKey } from "./config.js";
import type { Job, RunpodJobTiming } from "./types.js";

/**
 * Marks a creditsActual that was derived from measured pod runtime.
 *
 * Distinct from COMPANY_BALANCE_DELTA_SOURCE: that one infers spend from the
 * company balance moving, which is only trustworthy when a job had the whole
 * RunPod account to itself. This one is a direct product of this job's own
 * execution time and the GPU it ran on, and needs no such window.
 */
export const POD_RUNTIME_SOURCE = "pod_runtime";

/** Credits per USD, as used across the estimator. Kept in step with creditEstimator. */
const CREDITS_PER_USD = 211;

/**
 * USD per second by RunPod gpuTypeId, measured from billed invoices.
 *
 * Derived as amount / (timeBilledMs / 1000) per daily bucket over the 30 days to
 * 2026-08-18; the range each figure was observed in is noted beside it. Re-derive
 * with the same query when RunPod repricings land, or override without a deploy
 * through RUNPOD_GPU_USD_PER_SECOND.
 *
 * Deliberately NOT taken from the worker's own costPerHr, which reads low: a PRO
 * 6000 MIG worker reported 0.59/h against a billed 0.656-0.675/h.
 */
const MEASURED_GPU_USD_PER_SECOND: Readonly<Record<string, number>> = {
  // $3.315-3.320/h
  "NVIDIA RTX PRO 6000 Blackwell Server Edition": 0.0009215,
  // $1.501-1.508/h
  "NVIDIA GeForce RTX 5090": 0.0004174,
  // $1.159-1.161/h
  "NVIDIA A40": 0.0003221,
  // $0.656-0.675/h
  "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb": 0.0001844,
};

/**
 * Overrides and additions, as `gpuTypeId=usdPerSecond` pairs separated by semicolons.
 *
 * Semicolons because a gpuTypeId contains spaces and dots but never one of those.
 * A GPU absent from both this and the table above prices nothing at all, which is
 * the point: an endpoint that starts scheduling onto a GPU nobody has priced should
 * report an uncosted run rather than a figure invented from a neighbour's rate.
 */
const gpuUsdPerSecond: Readonly<Record<string, number>> = {
  ...MEASURED_GPU_USD_PER_SECOND,
  ...parseGpuRateOverrides(process.env.RUNPOD_GPU_USD_PER_SECOND),
};

export function gpuUsdPerSecondFor(gpuTypeId: string | undefined) {
  if (!gpuTypeId) return 0;
  return gpuUsdPerSecond[gpuTypeId] ?? 0;
}

/** Every GPU this build can price, in a stable order. */
export function pricedGpuTypeIds() {
  return Object.keys(gpuUsdPerSecond).sort();
}

/**
 * Fold one poll's timing into what is already recorded for the job.
 *
 * Merged rather than replaced because RunPod omits what it has nothing to say
 * about: `delayTime` only appears once a worker has taken the job, and a terminal
 * response need not repeat every field it reported while running. Overwriting would
 * blank a figure that was known a poll ago.
 *
 * Returns undefined when there is still nothing to record, so a caller can leave
 * the job untouched rather than write an empty object onto it.
 */
export function mergeRunpodTiming(
  previous: RunpodJobTiming | undefined,
  observation: { delayMs?: number; executionMs?: number; workerId?: string; gpuTypeId?: string; gpuCostPerHr?: number },
): RunpodJobTiming | undefined {
  const timing: RunpodJobTiming = {
    executionMs: positiveMs(observation.executionMs) ?? previous?.executionMs,
    delayMs: positiveMs(observation.delayMs) ?? previous?.delayMs,
    workerId: observation.workerId ?? previous?.workerId,
    gpuTypeId: observation.gpuTypeId ?? previous?.gpuTypeId,
    gpuCostPerHr: observation.gpuCostPerHr ?? previous?.gpuCostPerHr,
    usdPerSecond: previous?.usdPerSecond,
  };
  const known = Object.values(timing).some((value) => value !== undefined);
  return known ? timing : undefined;
}

export type PodRuntimeCost = {
  credits: number;
  usd: number;
  usdPerSecond: number;
  gpuTypeId: string;
};

/**
 * The measured cost of a job's pod time, or undefined when it cannot be measured.
 *
 * Undefined covers four honest gaps, all of which must stay uncosted rather than
 * fall back to an estimate: the job did not run on one of our own pods; RunPod
 * reported no execution time (a job that failed before a worker took it); the worker
 * was gone before its GPU could be resolved; or that GPU has no rate.
 *
 * Only `executionMs` is priced. RunPod's `delayTime` is queue wait, which is not
 * ours to pay for; it is recorded next to this for operators reading a slow run,
 * not billed. Note that a cold start lands inside the worker's own accounting
 * rather than here, so this is a floor on the true cost, not a ceiling.
 */
export function podRuntimeCost(job: Pick<Job, "workflowOptions" | "runpodTiming">): PodRuntimeCost | undefined {
  if (!job.workflowOptions?.stillImage) return undefined;

  const executionMs = job.runpodTiming?.executionMs;
  if (typeof executionMs !== "number" || !Number.isFinite(executionMs) || executionMs <= 0) return undefined;

  const gpuTypeId = job.runpodTiming?.gpuTypeId;
  const usdPerSecond = gpuUsdPerSecondFor(gpuTypeId);
  if (!gpuTypeId || !usdPerSecond) return undefined;

  const usd = (executionMs / 1000) * usdPerSecond;
  // A run too short to round up to one credit is still a real run, and reporting it
  // as 0 would be read as "not costed" rather than "cost about nothing".
  const credits = Math.max(1, Math.round(usd * CREDITS_PER_USD));
  return { credits, usd, usdPerSecond, gpuTypeId };
}

/** Just the credits, for callers that only need the figure. */
export function podRuntimeCredits(job: Pick<Job, "workflowOptions" | "runpodTiming">) {
  return podRuntimeCost(job)?.credits;
}

/** Whether this job's spend was measured rather than estimated. */
export function hasMeasuredPodRuntimeCost(job: Pick<Job, "creditsActual" | "creditsActualSource">) {
  return (
    job.creditsActualSource === POD_RUNTIME_SOURCE &&
    typeof job.creditsActual === "number" &&
    Number.isFinite(job.creditsActual) &&
    job.creditsActual > 0
  );
}

/** Whether a GPU lookup is worth attempting at all. */
export function podRuntimePricingConfigured() {
  return Boolean(runpodApiKey) && Object.keys(gpuUsdPerSecond).length > 0;
}

function parseGpuRateOverrides(value: string | undefined) {
  const overrides: Record<string, number> = {};
  for (const entry of (value ?? "").split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf("=");
    const gpuTypeId = separator > 0 ? trimmed.slice(0, separator).trim() : "";
    const rate = separator > 0 ? Number(trimmed.slice(separator + 1).trim()) : NaN;
    if (!gpuTypeId || !Number.isFinite(rate) || rate <= 0) {
      // Loudly ignored. A typo here silently reverts a GPU to its built-in rate, or
      // leaves it unpriced, and neither is visible in any number afterwards.
      console.warn(`Ignoring unparseable RUNPOD_GPU_USD_PER_SECOND entry: ${trimmed}`);
      continue;
    }
    overrides[gpuTypeId] = rate;
  }
  return overrides;
}

function positiveMs(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
