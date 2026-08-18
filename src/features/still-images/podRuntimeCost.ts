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
