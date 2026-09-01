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
  if (actualCredits != null) return roundCredits(actualCredits + partnerApiCredits(job));

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

export type JobSpendSplit = {
  /** RunPod worker seconds, rented from RunPod. */
  podCredits: number;
  podUsd: number;
  /** Comfy credits: partner API nodes billed against the org account. */
  comfyCredits: number;
  comfyUsd: number;
  credits: number;
  usd: number;
};

/**
 * One job's spend, split by the account it came out of.
 *
 * Two vendors, and knowing which is which is what makes a total actionable: a
 * run that is mostly pod time gets cheaper on a faster GPU, and one that is
 * mostly Comfy credits does not -- the only lever there is running the model
 * fewer times. A single figure hides which of those two conversations to have.
 *
 * The Comfy side is derived by subtraction rather than summed independently, so
 * the two parts can never disagree with `creditsSpentForAccounting`. That
 * function stays the authority on the total; this one only says where it came
 * from. It also means every non-pod source -- a tracker-priced animation run, a
 * balance delta, a stored figure -- lands on the Comfy side, which is correct:
 * all of them are that account's money.
 */
export function jobSpendSplit(
  job: Pick<
    Job,
    "source" | "creditsActual" | "creditsActualSource" | "creditsUsed" | "creditUsage" | "workflowOptions" | "runpodTiming"
  >,
): JobSpendSplit {
  const credits = creditsSpentForAccounting(job);
  const podCredits = job.creditsActualSource === POD_RUNTIME_SOURCE ? (positiveNumber(job.creditsActual) ?? 0) : 0;
  const podUsd = podRuntimeUsd(job);
  const comfyUsd = comfyTrackedUsd(job);
  return {
    podCredits: roundCredits(Math.min(podCredits, credits)),
    podUsd,
    comfyCredits: roundCredits(Math.max(0, credits - podCredits)),
    comfyUsd,
    credits,
    usd: podUsd + comfyUsd,
  };
}

function podRuntimeUsd(job: Pick<Job, "creditsActualSource" | "runpodTiming">) {
  if (job.creditsActualSource !== POD_RUNTIME_SOURCE) return 0;
  const executionMs = job.runpodTiming?.executionMs;
  const usdPerSecond = job.runpodTiming?.usdPerSecond;
  return executionMs && usdPerSecond ? (executionMs / 1000) * usdPerSecond : 0;
}

function comfyTrackedUsd(job: Pick<Job, "creditUsage">) {
  return isCountedCreditUsage(job.creditUsage) ? (positiveNumber(job.creditUsage?.total_estimated_usd) ?? 0) : 0;
}

export type EditSessionSpend = {
  generations: number;
  podCredits: number;
  podUsd: number;
  comfyCredits: number;
  comfyUsd: number;
};

/**
 * What one editing session spent, summed over the jobs that made it.
 *
 * Every generation the document paid for, not the layers that survived: a
 * regenerated layer was billed twice and a deleted one was still billed once.
 * Computed here, at finalize, because this is the only side that can see all of
 * a document's jobs -- the browser only holds the page it happens to have
 * loaded, so a figure it summed could quietly omit half the session.
 *
 * Dollars alongside credits because they are not interchangeable at this scale:
 * credits are whole-ish numbers and converting a rounded total back would report
 * a fraction of a cent as nothing.
 */
export function editSessionSpend(jobs: Job[], documentId: string): EditSessionSpend {
  const spend: EditSessionSpend = { generations: 0, podCredits: 0, podUsd: 0, comfyCredits: 0, comfyUsd: 0 };
  for (const job of jobs) {
    if (job.workflowOptions?.stillImage?.edit?.documentId !== documentId) continue;
    if (job.status !== "completed") continue;
    const split = jobSpendSplit(job);
    spend.generations += 1;
    spend.podCredits += split.podCredits;
    spend.podUsd += split.podUsd;
    spend.comfyCredits += split.comfyCredits;
    spend.comfyUsd += split.comfyUsd;
  }
  spend.podCredits = roundCredits(spend.podCredits);
  spend.comfyCredits = roundCredits(spend.comfyCredits);
  return spend;
}

/**
 * The same spend in dollars, from the two terms rather than from the credits.
 *
 * Credits round to whole numbers at this scale, so converting them back would
 * turn a half-cent pod run into zero. Mirrors creditsSpentForAccounting: the pod
 * price plus the partner node's, and nothing when neither was measured.
 */
export function usdSpentForAccounting(job: Pick<Job, "creditsActualSource" | "runpodTiming" | "creditUsage">) {
  return podRuntimeUsd(job) + comfyTrackedUsd(job);
}

export function creditAccountingSource(job: Pick<Job, "creditsActual" | "creditsActualSource" | "creditsUsed" | "creditUsage">) {
  if (positiveNumber(job.creditsActual) != null) {
    const measured = job.creditsActualSource || COMPANY_BALANCE_DELTA_SOURCE;
    // Two terms means two sources, and a row that reports only one of them sends
    // whoever is auditing it to the wrong place.
    if (!partnerApiCredits(job)) return measured;
    return `${measured}+${job.creditUsage?.source || "credit_usage"}`;
  }

  if (isCountedCreditUsage(job.creditUsage)) {
    return job.creditUsage?.source || "credit_usage";
  }

  if (job.creditUsage?.source) {
    return `${job.creditUsage.source}:${isUnpricedCreditUsage(job.creditUsage) ? "unpriced" : "not_counted"}`;
  }

  if (positiveNumber(job.creditsUsed) != null) {
    return "stored_credits";
  }

  return "";
}

/**
 * The partner-node API spend that a pod-time price does not include.
 *
 * A Still Images run can cost money in two places at once. The pod is rented from
 * RunPod by the second; a partner node inside the graph -- GeminiNanoBanana2 for
 * Image Editing -- is billed by Comfy against the org account, and the tracker
 * prices it. Those are two accounts, so the two figures add: a 30-second edit is
 * about half a cent of pod time and about eight cents of Nano Banana, and
 * counting only the pod reported roughly six percent of what the run actually
 * cost.
 *
 * Added only next to a pod-runtime figure. The other measured source, the company
 * balance delta, reads the very account the partner nodes bill -- its figure
 * already contains this spend, and adding the tracker on top would count it
 * twice. Anything the tracker could not price is excluded by
 * isCountedCreditUsage, so the zero-filled block that made gpt-image read as free
 * still cannot become a measurement here.
 */
function partnerApiCredits(job: Pick<Job, "creditsActualSource" | "creditUsage">) {
  if (job.creditsActualSource !== POD_RUNTIME_SOURCE) return 0;
  if (!isCountedCreditUsage(job.creditUsage)) return 0;
  return positiveNumber(job.creditUsage?.total_estimated_credits) ?? 0;
}

export function isCountedCreditUsage(creditUsage?: CreditUsageSummary) {
  return Boolean(creditUsage && !isLocalFallbackCreditUsage(creditUsage) && !isUnpricedCreditUsage(creditUsage));
}

/**
 * Whether the tracker returned a usage block that carries no price at all.
 *
 * The tracker prices a run by matching its nodes against a rule per partner node.
 * A node it has no rule for still comes back -- it executed, it has a duration --
 * but every figure on it is zero and its pricing_mode reads "unknown". Nothing
 * distinguishes that block from a run that genuinely cost nothing, and the app
 * used to take it at face value: gpt-image runs priced fine at runtime_price until
 * 2026-08-06, then went to "unknown" and reported a flat "0 credits" while the
 * company balance kept dropping, and every total they landed in quietly
 * understated the month.
 *
 * A zero here means "not priced", not "free", so such a block is not counted --
 * the job falls back to showing its estimate, the way an unmeasured run always has.
 * The test is the figures rather than pricing_mode: a block with a real number
 * anywhere in it has been priced by something, whatever it called the mode.
 *
 * The fix for the underlying gap is a pricing rule in the tracker for the node
 * (OpenAIGPTImage1 and Flux3ImageToVideoNode, as of 2026-08-19; a prompt_scan_error
 * block lands here too, and wants the error looked at rather than a rule). This
 * only stops the gap from reading as a measurement.
 */
export function isUnpricedCreditUsage(creditUsage?: CreditUsageSummary) {
  if (!creditUsage) return false;

  // The tracker now says this outright rather than leaving us to infer it from a
  // block of zeroes: every row carries a pricing_status of priced, known_zero or
  // unknown (see pricing_rules.py in comfyui_credit_tracker). Where that is
  // present it is the answer -- it is the only thing that can distinguish a node
  // that genuinely costs nothing from one nobody has a rate for, which the
  // figures alone never could.
  const declared = declaredPricingStatus(creditUsage);
  if (declared === "unknown") return true;
  if (declared === "priced" || declared === "known_zero") return false;

  // Older workers send no status. Fall back to reading the figures, which is what
  // caught the gpt-image gap in the first place.
  if (positiveNumber(creditUsage.total_estimated_credits) != null) return false;
  if (positiveNumber(creditUsage.total_estimated_usd) != null) return false;
  return (creditUsage.rows ?? []).every(
    (row) => positiveNumber(row.total_estimated_credits) == null && positiveNumber(row.total_estimated_usd) == null,
  );
}

/**
 * The pricing_status the tracker attached, when every row agrees on one.
 *
 * Rows disagreeing means the run was partly priced, which is not "unpriced" and
 * not a clean "priced" either; returning undefined sends the caller back to the
 * figures, where a partial price still shows up as a positive number.
 */
function declaredPricingStatus(creditUsage: CreditUsageSummary) {
  const statuses = new Set<string>();
  const summaryStatus = statusText(creditUsage.pricing_status);
  if (summaryStatus) statuses.add(summaryStatus);
  for (const row of creditUsage.rows ?? []) {
    const rowStatus = statusText(row.pricing_status);
    if (rowStatus) statuses.add(rowStatus);
  }
  return statuses.size === 1 ? [...statuses][0] : undefined;
}

function statusText(value: unknown) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "priced" || text === "known_zero" || text === "unknown" ? text : "";
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
