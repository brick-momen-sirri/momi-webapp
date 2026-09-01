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

/** Credits per USD, as the backend prices them. Kept in step with creditEstimator. */
const CREDITS_PER_USD = 211;

/**
 * What the run cost, in dollars.
 *
 * Recomputed from the two terms the job records -- worker seconds and the rate they
 * were priced at -- rather than converted back from the credits, which are rounded
 * to whole numbers and would read as $0.03 for anything between 5 and 6 credits.
 *
 * Falls back to the credits for a job priced before the rate was recorded, since a
 * dollar figure that is 0.5% out beats showing nothing.
 */
export function measuredPodUsd(job: Pick<Job, "creditsActual" | "creditsActualSource" | "runpodTiming">) {
  const credits = measuredPodCredits(job);
  if (credits === undefined) return undefined;

  const executionMs = job.runpodTiming?.executionMs;
  const usdPerSecond = job.runpodTiming?.usdPerSecond;
  if (executionMs && usdPerSecond) return (executionMs / 1000) * usdPerSecond;
  return credits / CREDITS_PER_USD;
}

/**
 * The partner-node spend that the pod price does not include.
 *
 * Kept in step with partnerApiCredits in backend/src/creditUsageAccounting.ts,
 * which is the figure the dashboards and the balance are derived from. Same
 * arrangement as POD_RUNTIME_SOURCE above: the server decides, this side only
 * recognises, and a drift shows a smaller number rather than a wrong one.
 */
export function partnerApiUsd(job: Pick<Job, "creditsActualSource" | "creditUsage">) {
  if (job.creditsActualSource !== POD_RUNTIME_SOURCE) return undefined;
  const usage = job.creditUsage;
  if (!usage || isUnpricedUsage(usage) || isLocalEstimate(usage.source)) return undefined;
  const usd = usage.total_estimated_usd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) return usd;
  const credits = usage.total_estimated_credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits > 0 ? credits / CREDITS_PER_USD : undefined;
}

/**
 * What the whole run cost: the pod it rented and the partner node it called.
 *
 * A 30-second Image Editing run is about half a cent of pod time and about eight
 * cents of Nano Banana, so showing only the first read as though the edit were
 * almost free.
 */
export function measuredJobUsd(job: Pick<Job, "creditsActual" | "creditsActualSource" | "runpodTiming" | "creditUsage">) {
  const pod = measuredPodUsd(job);
  if (pod === undefined) return undefined;
  return pod + (partnerApiUsd(job) ?? 0);
}

/**
 * What the whole run was charged, in credits.
 *
 * The same two terms as measuredJobUsd, in the unit the dashboards and the
 * balance are denominated in. Derived from the job rather than read off
 * `creditsUsed`, because that field holds whatever the accounting said when the
 * job completed -- for anything finished before the partner-node fix it is the
 * pod figure alone.
 */
export function measuredJobCredits(job: Pick<Job, "creditsActual" | "creditsActualSource" | "creditUsage">) {
  const pod = measuredPodCredits(job);
  if (pod === undefined) return undefined;
  const partner = partnerApiCreditsFor(job);
  return Math.round((pod + partner) * 100) / 100;
}

function partnerApiCreditsFor(job: Pick<Job, "creditsActualSource" | "creditUsage">) {
  if (job.creditsActualSource !== POD_RUNTIME_SOURCE) return 0;
  const usage = job.creditUsage;
  if (!usage || isUnpricedUsage(usage) || isLocalEstimate(usage.source)) return 0;
  const credits = usage.total_estimated_credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits > 0 ? credits : 0;
}

export type JobSpendSplit = {
  podUsd: number;
  comfyUsd: number;
  podCredits: number;
  comfyCredits: number;
  usd: number;
  credits: number;
};

/**
 * What a run cost, split by the account it came out of.
 *
 * Kept in step with jobSpendSplit in backend/src/creditUsageAccounting.ts, which
 * is what the dashboards derive from. The two halves are worth separating
 * because they respond to different things: pod time falls on a faster GPU,
 * while Comfy credits only fall by calling the model fewer times.
 *
 * Undefined when nothing about the run was measured, which is the same condition
 * that leaves the card showing "--" rather than a zero it cannot stand behind.
 */
export function measuredJobSpend(
  job: Pick<Job, "creditsActual" | "creditsActualSource" | "runpodTiming" | "creditUsage">,
): JobSpendSplit | undefined {
  const podUsd = measuredPodUsd(job);
  const podCredits = measuredPodCredits(job);
  if (podUsd === undefined || podCredits === undefined) return undefined;
  const comfyUsd = partnerApiUsd(job) ?? 0;
  const comfyCredits = partnerApiCreditsFor(job);
  return {
    podUsd,
    comfyUsd,
    podCredits,
    comfyCredits,
    usd: podUsd + comfyUsd,
    credits: Math.round((podCredits + comfyCredits) * 100) / 100,
  };
}

/** A zero-filled tracker block means "not priced", never "free". */
function isUnpricedUsage(usage: NonNullable<Job["creditUsage"]>) {
  const positive = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (positive(usage.total_estimated_credits) || positive(usage.total_estimated_usd)) return false;
  return (usage.rows ?? []).every((row) => !positive(row.total_estimated_credits) && !positive(row.total_estimated_usd));
}

function isLocalEstimate(source: string | undefined) {
  const value = (source ?? "").trim().toLowerCase();
  return value === "local_kling_estimate" || (value.startsWith("local_") && value.includes("estimate"));
}

/**
 * A cost in dollars, at a precision that does not round a real run to nothing.
 *
 * These runs are cents: a 33s Pro Upscaler on a PRO 6000 is $0.030. Two decimals
 * would show $0.03 for everything from $0.025 to $0.034 and $0.00 for a fast edit,
 * so small amounts keep more digits. Dollars and up get the usual two.
 */
export function formatUsd(usd: number) {
  if (!Number.isFinite(usd) || usd < 0) return undefined;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  // Below a cent, three decimals is just $0.00x -- say four so the number survives.
  return `$${usd.toFixed(4)}`;
}

/**
 * The result's size on disk, as "24.8 MB".
 *
 * Worth showing next to the dimensions: a 10K PNG past 100 MB is the reason this
 * panel never loads an original, and output on the render host grows by tens of
 * gigabytes a month.
 */
export function formatResultBytes(bytes: number | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  // A decimal up to 100 MB, where most of these results land and where the
  // difference between 24 and 25 MB is still worth reading.
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Why a run cost what it did: the seconds, the GPU, and the rate.
 *
 * Worth spelling out on the card, because the same preset legitimately costs two
 * different amounts. Its endpoint accepts several GPU classes and the worker that
 * takes the job decides which one -- 2.2x apart at the extremes -- so "18 credits
 * here, 8 there" is the system working, not a bug to go hunting.
 */
export function podCostExplanation(job: Pick<Job, "creditsActual" | "creditsActualSource" | "runpodTiming" | "creditUsage">) {
  const credits = measuredPodCredits(job);
  if (credits === undefined) {
    return "Not measured: no worker time was reported, the worker was gone before its GPU could be identified, or that GPU has no rate.";
  }

  const runtime = formatPodRuntime(job);
  const gpu = gpuDisplayName(job.runpodTiming?.gpuTypeId);
  const rate = job.runpodTiming?.usdPerSecond;
  const parts = [runtime && `${runtime} of worker time`, gpu && `on ${gpu}`, rate && `at $${rate}/s`].filter(Boolean);
  const podPriced = parts.length ? `Pod: ${parts.join(" ")}` : "Pod: the worker time RunPod reported for this run";

  // The two halves are itemised because they come from two accounts, and a run
  // whose cost is mostly the model call reads as a mystery when only the pod is
  // shown. Credits stay in the tooltip: the dashboards and the balance are
  // denominated in them even though the card shows dollars.
  const partnerUsd = partnerApiUsd(job);
  if (partnerUsd === undefined) {
    return `${podPriced}. Charged as ${credits} credit${credits === 1 ? "" : "s"}.`;
  }
  const partnerCredits = job.creditUsage?.total_estimated_credits;
  const total = Math.round((credits + (partnerCredits ?? 0)) * 100) / 100;
  return `${podPriced} — ${formatUsd(measuredPodUsd(job) ?? 0)}. Model call: ${formatUsd(partnerUsd)}, priced by the credit tracker. Charged as ${total} credits in total.`;
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
