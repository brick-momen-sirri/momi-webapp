import { POD_RUNTIME_SOURCE } from "./podRuntimeCost.js";
import type { CreditBalanceSnapshot, CreditUsageSummary, Job } from "./types.js";

export const COMPANY_BALANCE_DELTA_SOURCE = "company_balance_delta";

/**
 * A Still Images preset is excluded from credit accounting until its cost has
 * actually been measured.
 *
 * These four run on their own pods, which return no usage figures. The only number
 * available for a run nobody measured is the flat per-preset estimate in
 * stillImageModels, and counting an estimate as spend inflates every total it lands
 * in -- workspace, project, monthly dashboard -- with a figure nobody checked. Such
 * a job reports "--", as all of them used to.
 *
 * What changed is that a measured figure now exists for some of them: RunPod
 * reports the worker time, and podRuntimeCost turns it into credits at the
 * endpoint's configured per-second price. That is a measurement, not an estimate,
 * so excluding it would understate real spend as badly as the estimate overstated
 * it -- and it would keep the pods invisible, which was the actual problem.
 *
 * Note the asymmetry this leaves with the external Credit Tracker: that sync needs
 * a provider credit_usage row, which these pods never produce, so measured pod
 * spend is counted here and still filed nowhere there.
 *
 * This is the single gate: every total is derived from either this function or the
 * job.creditsUsed it decides to leave in place.
 */
export function isCreditExemptJob(job: Pick<Job, "workflowOptions" | "creditsActual" | "creditsActualSource">) {
  if (!job.workflowOptions?.stillImage) return false;
  return !hasMeasuredSpend(job);
}

/**
 * Whether a figure on this job was measured rather than estimated.
 *
 * The two measured sources: pod runtime, which multiplies the worker time RunPod
 * reported by the endpoint's price, and the company balance delta, which reads the
 * account balance moving across a window this job had to itself. Everything else
 * that can land in creditsActual is a projection and must not lift the exemption.
 */
export function hasMeasuredSpend(job: Pick<Job, "creditsActual" | "creditsActualSource">) {
  if (job.creditsActualSource !== POD_RUNTIME_SOURCE && job.creditsActualSource !== COMPANY_BALANCE_DELTA_SOURCE) {
    return false;
  }
  return positiveNumber(job.creditsActual) != null;
}

export function creditsSpentForAccounting(
  job: Pick<Job, "source" | "creditsActual" | "creditsActualSource" | "creditsUsed" | "creditUsage" | "workflowOptions">,
) {
  if (job.source === "existing_project_media") return 0;
  if (isCreditExemptJob(job)) return 0;

  const actualCredits = positiveNumber(job.creditsActual);
  if (actualCredits != null) return roundCredits(actualCredits);

  if (isCountedCreditUsage(job.creditUsage)) {
    const trackedCredits = positiveNumber(job.creditsUsed) ?? positiveNumber(job.creditUsage?.total_estimated_credits);
    return trackedCredits == null ? 0 : roundCredits(trackedCredits);
  }

  if (!job.creditUsage) {
    const storedCredits = positiveNumber(job.creditsUsed);
    return storedCredits == null ? 0 : roundCredits(storedCredits);
  }

  return 0;
}

export function creditAccountingSource(job: Pick<Job, "creditsActual" | "creditsActualSource" | "creditsUsed" | "creditUsage">) {
  if (positiveNumber(job.creditsActual) != null) {
    return job.creditsActualSource || COMPANY_BALANCE_DELTA_SOURCE;
  }

  if (isCountedCreditUsage(job.creditUsage)) {
    return job.creditUsage?.source || "credit_usage";
  }

  if (job.creditUsage?.source) {
    return `${job.creditUsage.source}:not_counted`;
  }

  if (positiveNumber(job.creditsUsed) != null) {
    return "stored_credits";
  }

  return "";
}

export function isCountedCreditUsage(creditUsage?: CreditUsageSummary) {
  return Boolean(creditUsage && !isLocalFallbackCreditUsage(creditUsage));
}

export function isLocalFallbackCreditUsage(creditUsage?: CreditUsageSummary) {
  const source = normalizeSource(creditUsage?.source);
  return source === "local_kling_estimate" || (source.startsWith("local_") && source.includes("estimate"));
}

export function balanceDeltaCredits(before?: CreditBalanceSnapshot, after?: CreditBalanceSnapshot) {
  if (!before || !after) return undefined;
  if (!sameBalanceSource(before.source, after.source)) return undefined;

  const beforeCredits = positiveOrZeroNumber(before.creditsLeft);
  const afterCredits = positiveOrZeroNumber(after.creditsLeft);
  if (beforeCredits == null || afterCredits == null) return undefined;

  const delta = beforeCredits - afterCredits;
  return delta > 0 ? roundCredits(delta) : undefined;
}

function sameBalanceSource(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeSource(source?: string) {
  return (source ?? "").trim().toLowerCase();
}

function positiveNumber(value: unknown) {
  const number = numberFrom(value);
  return number != null && number > 0 ? number : undefined;
}

function positiveOrZeroNumber(value: unknown) {
  const number = numberFrom(value);
  return number != null && number >= 0 ? number : undefined;
}

function numberFrom(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}
