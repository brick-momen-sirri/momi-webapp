// The cost of a partner-model run the credit tracker could not price.
//
// The worker's tracker prices a partner node from the X-Comfy-Credits-Used header
// the Comfy proxy returns, and falls back to the node's price badge. On ComfyUI 0.38
// neither works for MiniMax H3 or Seedream 5.0: the proxy sends no header for those
// providers, and the tracker cannot evaluate their badges, so the run comes back as
// pricing_mode "unknown" with 0 credits -- which creditsSpentForAccounting counts as
// nothing spent. Measured on 2026-10-01: a 5s 768P H3 render billed 135.78 credits
// and a Seedream Pro image 18.99, both reported by the tracker as 0.
//
// Those nodes' prices are deterministic, though, and partnerModels.json carries
// them: the same badge rates official_usage_events matched exactly on those runs
// ($0.1287 x 5 s; $0.09 per 2K image). So when the tracker has no price for a
// variant the table does price, the job is charged at that rate rather than at
// zero, under its own source so it stays distinguishable from a tracked figure and
// can be reconciled against official usage like any other.

import { isUnpricedCreditUsage } from "./creditUsageAccounting.js";
import { draftFinalKindFromModelId } from "./draftFinalModels.js";
import { partnerModelEntry, partnerModelOutputCount, partnerModelUsd } from "./partnerModels.js";
import type { CreditUsageSummary, Job } from "./types.js";

export const PARTNER_RATE_SOURCE = "partner_model_rate";

const CREDITS_PER_USD = 211;

/** MinimaxHailuo03RegenerateNode's badge: a flat rate per second of the source. */
const MINIMAX_REGENERATE_USD_PER_SECOND = 0.0715;

/**
 * A priced usage block for this job, when the tracker's own is missing or unpriced
 * and the job's model has a published rate. Undefined otherwise, which leaves the
 * tracked block exactly as the worker returned it.
 */
export function partnerRateCreditUsage(
  job: Pick<Job, "modelId" | "modelName" | "resolution" | "durationSeconds" | "inputImages" | "inputVideo" | "workflowOptions">,
  tracked: CreditUsageSummary | undefined,
): CreditUsageSummary | undefined {
  if (tracked && !isUnpricedCreditUsage(tracked)) return undefined;

  const rate = rateFor(job);
  if (!rate) return undefined;

  const usd = roundUsd(rate.usd);
  const credits = roundCredits(usd * CREDITS_PER_USD);
  return {
    total_estimated_credits: credits,
    total_estimated_usd: usd,
    source: PARTNER_RATE_SOURCE,
    pricing_status: "priced",
    rows: [
      {
        node_title: job.modelName,
        class_type: rate.classType,
        total_estimated_credits: credits,
        total_estimated_usd: usd,
        source: PARTNER_RATE_SOURCE,
        status: rate.note,
        tracker_source: tracked?.source,
      },
    ],
  };
}

function rateFor(job: Parameters<typeof partnerRateCreditUsage>[0]) {
  if (draftFinalKindFromModelId(job.modelId) === "minimax-h3-768p") {
    const seconds = job.durationSeconds && job.durationSeconds > 0 ? job.durationSeconds : 5;
    return {
      usd: MINIMAX_REGENERATE_USD_PER_SECOND * seconds,
      classType: "MinimaxHailuo03RegenerateNode",
      note: "rate card: $0.0715 per second of the source",
    };
  }

  const entry = partnerModelEntry(job.modelId);
  if (!entry?.variant.pricing) return undefined;
  const usd = partnerModelUsd(job.modelId, {
    resolutionLabel: job.resolution?.label,
    durationSeconds: job.durationSeconds,
    referenceImageCount: job.inputImages.length,
    outputCount: partnerModelOutputCount(job.modelId, job.workflowOptions),
    hasReferenceVideo: Boolean(job.inputVideo),
  });
  if (usd == null || usd <= 0) return undefined;
  return {
    usd,
    classType: entry.family.label,
    note: entry.variant.pricing.maxExtraUsd && job.inputVideo
      ? "rate card, upper bound: the reference clip's share depends on the clip"
      : "rate card",
  };
}

function roundUsd(value: number) {
  return Math.max(0, Math.round(value * 10000) / 10000);
}

function roundCredits(value: number) {
  return Math.max(0, Math.round(value * 100) / 100);
}
