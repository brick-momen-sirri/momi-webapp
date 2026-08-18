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
// RunPod does report the one fact that matters: how long a worker spent on the job.
// `executionTime` comes back on the status response, which the poller already reads
// (runpodComfyService's onPoll). Multiply it by the endpoint's per-second price and
// the result is measured, not guessed.
//
// The price is configuration, deliberately with no default. A rate depends on the
// GPU class each endpoint runs, which this code cannot know; inventing one would
// reintroduce exactly the fabricated-number problem the exemption existed to avoid.
// With no rate configured a job stays uncosted and still reports "--".

import { STILL_IMAGE_CATEGORY_IDS } from "./stillImageCategories.js";
import type { Job, RunpodJobTiming } from "./types.js";

/**
 * Marks a creditsActual that was derived from measured pod runtime.
 *
 * Distinct from COMPANY_BALANCE_DELTA_SOURCE: that one infers spend from the
 * company balance moving, which is only trustworthy when a job had the whole
 * RunPod account to itself. This one is a direct product of this job's own
 * execution time and needs no such window.
 */
export const POD_RUNTIME_SOURCE = "pod_runtime";

/** Credits per USD, as used across the estimator. Kept in step with creditEstimator. */
const CREDITS_PER_USD = 211;

/**
 * Per-second USD price for a preset's pod.
 *
 * `STILL_IMAGE_POD_USD_PER_SECOND` sets the rate for every preset;
 * `STILL_IMAGE_POD_USD_PER_SECOND_PRO_UPSCALER` and friends override one. The
 * presets do not share a GPU class -- Pro Upscaler runs SeedVR plus a tiled Flux
 * pass -- so the per-preset form is the one to expect in practice.
 */
const podUsdPerSecond: Readonly<Record<string, number>> = Object.fromEntries(
  STILL_IMAGE_CATEGORY_IDS.map((categoryId) => [
    categoryId,
    positiveRate(process.env[`STILL_IMAGE_POD_USD_PER_SECOND_${envSuffix(categoryId)}`]) ??
      positiveRate(process.env.STILL_IMAGE_POD_USD_PER_SECOND) ??
      0,
  ]).filter(([, rate]) => rate),
);

export function podUsdPerSecondForCategory(categoryId: string) {
  return podUsdPerSecond[categoryId] ?? 0;
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
  observation: { delayMs?: number; executionMs?: number; workerId?: string },
): RunpodJobTiming | undefined {
  const timing: RunpodJobTiming = {
    executionMs: positiveMs(observation.executionMs) ?? previous?.executionMs,
    delayMs: positiveMs(observation.delayMs) ?? previous?.delayMs,
    workerId: observation.workerId ?? previous?.workerId,
  };
  const known = timing.executionMs !== undefined || timing.delayMs !== undefined || timing.workerId !== undefined;
  return known ? timing : undefined;
}

/**
 * The measured cost of a job's pod time, or undefined when it cannot be measured.
 *
 * Undefined covers three honest gaps, all of which must stay uncosted rather than
 * fall back to an estimate: the job did not run on a priced pod, no rate is
 * configured for its preset, and RunPod reported no execution time (which happens
 * when a job fails before a worker picks it up).
 *
 * Only `executionMs` is priced. RunPod's `delayTime` is queue wait, which is not
 * ours to pay for; it is recorded next to this for operators reading a slow run,
 * not billed. Note that a cold start lands inside the worker's own accounting
 * rather than here, so this is a floor on the true cost, not a ceiling.
 */
export function podRuntimeCredits(job: Pick<Job, "workflowOptions" | "runpodTiming">) {
  const categoryId = job.workflowOptions?.stillImage?.categoryId;
  if (!categoryId) return undefined;

  const usdPerSecond = podUsdPerSecondForCategory(categoryId);
  if (!usdPerSecond) return undefined;

  const executionMs = job.runpodTiming?.executionMs;
  if (typeof executionMs !== "number" || !Number.isFinite(executionMs) || executionMs <= 0) return undefined;

  const usd = (executionMs / 1000) * usdPerSecond;
  const credits = Math.round(usd * CREDITS_PER_USD);
  // A run too short to round up to one credit is still a real run, and reporting
  // it as 0 would be read as "not costed" rather than "cost about nothing".
  return Math.max(1, credits);
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

function envSuffix(categoryId: string) {
  return categoryId.replaceAll("-", "_").toUpperCase();
}

function positiveMs(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveRate(value: string | undefined) {
  const parsed = Number((value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
