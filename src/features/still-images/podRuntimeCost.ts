// Reading a still image job's measured pod cost, as the UI needs it.
//
// The presets run on RunPod endpoints the studio rents by the second, and those
// workers report no usage figures, so these jobs used to display "--" everywhere: a
// flat per-preset estimate was the only number available, and showing an unmeasured
// estimate as spend was worse than showing nothing.
//
// The backend now prices the worker time RunPod does report (podRuntimeCost.ts) and
// stamps the result with this source, which is what makes a figure trustworthy
// enough to display. Anything else in creditsActual is a projection.
//
// POD_RUNTIME_SOURCE MUST stay in step with backend/src/podRuntimeCost.ts. Same
// arrangement as the preset catalogue and the seed bound next door: the value is a
// string the server writes and this side only ever recognises, so a drift here
// shows a job as uncosted rather than corrupting anything.

import type { Job } from "../../types";

export const POD_RUNTIME_SOURCE = "pod_runtime";

/** The measured credits for this job's pod time, if it was measured at all. */
export function measuredPodCredits(job: Pick<Job, "creditsActual" | "creditsActualSource">) {
  if (job.creditsActualSource !== POD_RUNTIME_SOURCE) return undefined;
  const credits = job.creditsActual;
  return typeof credits === "number" && Number.isFinite(credits) && credits > 0 ? credits : undefined;
}

/**
 * Why a run cost what it did: the seconds, the GPU, and the rate.
 *
 * Worth spelling out on the card, because the same preset legitimately costs two
 * different amounts. Its endpoint accepts several GPU classes and the worker that
 * takes the job decides which one -- 2.2x apart at the extremes -- so "18 credits
 * here, 8 there" is the system working, not a bug to go hunting.
 */
export function podCostExplanation(job: Pick<Job, "creditsActual" | "creditsActualSource" | "runpodTiming">) {
  const credits = measuredPodCredits(job);
  if (credits === undefined) {
    return "Not measured: no worker time was reported, the worker was gone before its GPU could be identified, or that GPU has no rate.";
  }

  const runtime = formatPodRuntime(job);
  const gpu = gpuDisplayName(job.runpodTiming?.gpuTypeId);
  const rate = job.runpodTiming?.usdPerSecond;
  const parts = [runtime && `${runtime} of worker time`, gpu && `on ${gpu}`, rate && `at $${rate}/s`].filter(Boolean);
  return parts.length ? `Priced from ${parts.join(" ")}.` : "Priced from the worker time RunPod reported for this run.";
}

/** RunPod's gpuTypeId without the vendor prefix, which is the same on all of them. */
export function gpuDisplayName(gpuTypeId: string | undefined) {
  const trimmed = (gpuTypeId ?? "").trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^NVIDIA\s+/i, "").replace(/^AMD\s+/i, "");
}

/**
 * How long the worker spent on the job, as "1m 38s".
 *
 * The billed figure, and not the same thing as wall-clock time on the card: a job
 * also waits in RunPod's queue (`delayMs`), which nobody pays for. Worth showing
 * next to the cost so a surprising number can be traced to a long render rather
 * than a long wait.
 */
export function formatPodRuntime(job: Pick<Job, "runpodTiming">) {
  const executionMs = job.runpodTiming?.executionMs;
  if (typeof executionMs !== "number" || !Number.isFinite(executionMs) || executionMs <= 0) return undefined;

  const seconds = Math.round(executionMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
