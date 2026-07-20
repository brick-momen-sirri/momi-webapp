import type { CreditBalanceSnapshot, CreditUsageSummary, Job } from "./types.js";

export const COMPANY_BALANCE_DELTA_SOURCE = "company_balance_delta";

export function creditsSpentForAccounting(job: Pick<Job, "source" | "creditsActual" | "creditsActualSource" | "creditsUsed" | "creditUsage">) {
  if (job.source === "existing_project_media") return 0;

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
