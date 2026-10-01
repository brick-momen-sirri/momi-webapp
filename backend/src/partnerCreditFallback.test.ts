import assert from "node:assert/strict";
import test from "node:test";

import { creditsSpentForAccounting, isCountedCreditUsage } from "./creditUsageAccounting.js";
import { preferredResultMedia } from "./jobQueue/runpodExecution.js";
import { PARTNER_RATE_SOURCE, partnerRateCreditUsage } from "./partnerCreditFallback.js";
import type { CreditUsageSummary, Job } from "./types.js";

// What the worker's tracker returned for a real 5s 768P MiniMax H3 run on
// 2026-10-01, which official_usage_events billed at 135.78 credits.
const UNPRICED: CreditUsageSummary = {
  total_estimated_credits: 0,
  total_estimated_usd: 0,
  source: "credit_tracker:prompt_scan",
  rows: [
    {
      class_type: "MinimaxHailuo03FirstLastFrameNode",
      total_estimated_credits: 0,
      total_estimated_usd: 0,
      source: "prompt_scan",
      pricing_mode: "unknown",
    },
  ],
};

function job(overrides: Partial<Job> = {}) {
  return {
    modelId: "brick_api_minimax_h3_i2v",
    modelName: "MiniMax H3 Image to Video",
    resolution: { width: 1366, height: 768, label: "768P" },
    durationSeconds: 5,
    inputImages: ["/api/media?path=frame.png"],
    inputVideo: undefined,
    workflowOptions: {},
    ...overrides,
  } as Job;
}

test("an unpriced MiniMax run is charged at its published rate, and counts as spend", () => {
  const usage = partnerRateCreditUsage(job(), UNPRICED);
  assert.ok(usage);
  assert.equal(usage.source, PARTNER_RATE_SOURCE);
  assert.equal(usage.pricing_status, "priced");
  assert.equal(usage.total_estimated_usd, 0.6435);
  // 135.78 is what Comfy billed for this exact run.
  assert.equal(usage.total_estimated_credits, 135.78);
  assert.equal(usage.rows?.[0].tracker_source, "credit_tracker:prompt_scan");

  assert.equal(isCountedCreditUsage(usage), true);
  assert.equal(creditsSpentForAccounting({ creditUsage: usage, creditsUsed: usage.total_estimated_credits } as Job), 135.78);
});

test("a run the tracker did price keeps the tracker's figure", () => {
  const priced: CreditUsageSummary = { total_estimated_credits: 16.48, total_estimated_usd: 0.0781, source: "credit_tracker:runtime_price" };
  assert.equal(partnerRateCreditUsage(job({ modelId: "brick_api_openai_gpt_image_2_5_flare_i2i" }), priced), undefined);
  assert.equal(partnerRateCreditUsage(job(), priced), undefined);
});

test("a model without a published rate is left to the tracker", () => {
  assert.equal(partnerRateCreditUsage(job({ modelId: "brick_api_kling_v3_video" }), UNPRICED), undefined);
  assert.equal(partnerRateCreditUsage(job({ modelId: "brick_nano_banana_2" }), UNPRICED), undefined);
});

test("Seedream and the MiniMax 2K re-render are covered too", () => {
  const seedream = partnerRateCreditUsage(
    job({ modelId: "brick_api_seedream_5_0_pro", resolution: { width: 2848, height: 1600, label: "2K 16:9" } }),
    UNPRICED,
  );
  // 0.09 for the 2K image plus 0.003 for the one reference.
  assert.equal(seedream?.total_estimated_usd, 0.093);

  const regenerate = partnerRateCreditUsage(job({ modelId: "draft_final_minimax_h3_2k_i2v", durationSeconds: 5 }), undefined);
  assert.equal(regenerate?.total_estimated_usd, 0.3575);
  assert.equal(regenerate?.rows?.[0].class_type, "MinimaxHailuo03RegenerateNode");
});

test("the input a LoadVideo node echoes back is not kept as a result", () => {
  const media = [
    { url: "https://r2/draft_base.mp4?sig", filename: "draft_base.mp4", isVideo: true, source: "videos" },
    { url: "https://r2/ComfyUI_00002_.mp4?sig", filename: "ComfyUI_00002_.mp4", isVideo: true, source: "videos" },
  ] as Parameters<typeof preferredResultMedia>[0];
  assert.deepEqual(
    preferredResultMedia(media, ["0001.png", "draft_base.mp4"]).map((item) => item.filename),
    ["ComfyUI_00002_.mp4"],
  );
  // Never drops everything: a graph that only echoed would rather keep what it has.
  assert.equal(preferredResultMedia(media.slice(0, 1), ["draft_base.mp4"]).length, 1);
  // No names given is the old behaviour.
  assert.equal(preferredResultMedia(media).length, 2);
});
