import { describe, expect, it } from "vitest";
import type { ModelType } from "../../types";
import { estimateModelCreditLabel, estimateModelCredits, estimateDraftFinalCredits } from "../../utils/creditEstimator";
import { normalizeResolutionForModel, parseResolution } from "./generationUtils";
import { familyVariantModels, partnerModelUsd } from "./partnerModels";

/**
 * The same prices backend/src/partnerModels.test.ts asserts.
 *
 * Both sides read backend/src/data/partnerModels.json, so the rates cannot drift;
 * what can is the mirrored arithmetic, which is what these pin.
 */

function model(overrides: Partial<ModelType>): ModelType {
  return {
    id: "brick_api_minimax_h3_max_i2v",
    label: "MiniMax H3 Max Image to Video",
    description: "",
    category: "video",
    backendCategory: "image_to_video",
    cost: 0,
    estimatedTime: "",
    supportedResolutions: ["480P", "768P"],
    supportedDurations: [5, 6, 7, 8, 9, 10],
    defaultDurationSeconds: 5,
    ...overrides,
  };
}

describe("partner model pricing", () => {
  it("quotes each variant from its own node's rates", () => {
    expect(partnerModelUsd("brick_api_openai_gpt_image_2_5_flare_i2i", { resolutionLabel: "1024x1024" })).toBe(0.0753);
    expect(partnerModelUsd("brick_nano_banana_pro", { resolutionLabel: "4K" })).toBe(0.288);
    expect(partnerModelUsd("brick_api_seedream_5_0_flash", { resolutionLabel: "1K 1:1" })).toBe(0.02574);
    expect(partnerModelUsd("brick_api_minimax_h3_max_turbo_i2v", { resolutionLabel: "480P", durationSeconds: 5 })).toBeCloseTo(
      0.17875,
      5,
    );
    expect(partnerModelUsd("brick_nano_banana_2", { resolutionLabel: "1K" })).toBeUndefined();
  });

  it("feeds the Generate button a figure, not the older sibling's range", () => {
    const gpt25 = model({
      id: "brick_api_openai_gpt_image_2_5_flare_i2i",
      label: "GPT Image 2.5 Flare",
      category: "image",
      backendCategory: "image_editing",
      supportedResolutions: ["auto", "1024x1024"],
    });
    expect(estimateModelCredits(gpt25, undefined, "1024x1024", 2)).toBe(Math.round(0.0753 * 2 * 211));
    expect(estimateModelCreditLabel(gpt25, undefined, "1024x1024", 1)).toBe(`${Math.round(0.0753 * 211)} credits`);

    const h3 = model({ id: "brick_api_minimax_h3_i2v", supportedResolutions: ["768P", "2K"] });
    expect(estimateModelCredits(h3, 10, "2K")).toBe(Math.round(0.1859 * 10 * 211));
  });

  it("prices a final from the draft's length", () => {
    expect(estimateDraftFinalCredits("minimax-h3-768p", 10, "image_to_video")).toBe(Math.round(0.0715 * 10 * 211));
    const seedance = estimateDraftFinalCredits("seedance-2.5-draft", 5, "image_to_video");
    expect(seedance).toBeGreaterThan(700);
    expect(seedance).toBeLessThan(1000);
  });
});

describe("partner model resolutions", () => {
  it("keeps a 768P choice on H3 Max instead of falling back to its first option", () => {
    // The alias rules alone read "768P" as 1080p, found it unsupported and fell back
    // to 480P -- a quiet downgrade on every reused or remembered setting.
    expect(normalizeResolutionForModel("768P", model({}), false)).toBe("768P");
    expect(normalizeResolutionForModel("768p", model({}), false)).toBe("768P");
  });

  it("sends a variant's own size for its labels", () => {
    expect(parseResolution("768P", "brick_api_minimax_h3_i2v")).toEqual({ width: 1366, height: 768, label: "768P" });
    expect(parseResolution("2K", "brick_api_minimax_h3_i2v")).toEqual({ width: 2560, height: 1440, label: "2K" });
    expect(parseResolution("2K 16:9", "brick_api_seedream_5_0_pro")).toEqual({ width: 2848, height: 1600, label: "2K 16:9" });
    // Nano Banana's 2K stays the square it always was.
    expect(parseResolution("2K", "brick_nano_banana_2")).toEqual({ width: 2048, height: 2048, label: "2K" });
  });

  it("groups a family's versions within one task only", () => {
    const i2v = model({ id: "brick_api_minimax_h3_i2v" });
    const i2vMax = model({ id: "brick_api_minimax_h3_max_i2v" });
    const flf = model({ id: "brick_api_minimax_h3_flf2v", backendCategory: "first_last_frame_to_video" });
    expect(familyVariantModels([i2v, i2vMax, flf], i2vMax).map((item) => item.id)).toEqual([
      "brick_api_minimax_h3_i2v",
      "brick_api_minimax_h3_max_i2v",
    ]);
  });
});
