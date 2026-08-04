// The number this module returns is what the user sees before they spend money, and
// it also gates submission: App refuses to generate when creditsRemaining is below
// the estimate. An estimate that is too low lets a job through that the workspace
// cannot afford; one that is too high blocks work that was affordable.
//
// Model family is decided by substring-matching a key built from id + label +
// backendCategory + workflowPath, so a test per family is really a test that the
// right branch is reached. The exact anchors below pin the USD-to-credit conversion
// (211 credits per dollar) and one published rate per family; the rest are
// invariants, so a genuine rate change fails one obvious assertion rather than
// twenty.

import { describe, expect, it } from "vitest";
import type { ModelType } from "../types";
import { estimateModelCreditLabel, estimateModelCredits } from "./creditEstimator";

function model(overrides: Partial<ModelType> = {}): ModelType {
  return { id: "some_model", label: "Some Model", cost: 0, ...overrides } as ModelType;
}

describe("duration handling", () => {
  it("falls back to five seconds when no duration is given", () => {
    const veo = model({ id: "google_veo3" });
    expect(estimateModelCredits(veo, undefined, "1080p")).toBe(estimateModelCredits(veo, 5, "1080p"));
  });

  it("prefers the model's own default over the five-second fallback", () => {
    const veo = model({ id: "google_veo3", defaultDurationSeconds: 8 });
    expect(estimateModelCredits(veo, undefined, "1080p")).toBe(estimateModelCredits(veo, 8, "1080p"));
  });

  it("ignores a non-positive or non-finite duration", () => {
    const veo = model({ id: "google_veo3" });
    const fallback = estimateModelCredits(veo, 5, "1080p");
    expect(estimateModelCredits(veo, 0, "1080p")).toBe(fallback);
    expect(estimateModelCredits(veo, -8, "1080p")).toBe(fallback);
    expect(estimateModelCredits(veo, Number.NaN, "1080p")).toBe(fallback);
  });

  it("scales linearly with duration for per-second models", () => {
    const veo = model({ id: "google_veo3" });
    expect(estimateModelCredits(veo, 10, "1080p")).toBe(estimateModelCredits(veo, 5, "1080p") * 2);
  });
});

describe("Veo 3", () => {
  it("charges the standard rate at 1080p", () => {
    // 0.20 USD/s * 211 credits/USD * 5s
    expect(estimateModelCredits(model({ id: "google_veo3" }), 5, "1080p")).toBe(211);
  });

  it("charges more at 4k than 1080p", () => {
    const veo = model({ id: "google_veo3" });
    expect(estimateModelCredits(veo, 5, "4k")).toBe(422);
    expect(estimateModelCredits(veo, 5, "4k")).toBeGreaterThan(estimateModelCredits(veo, 5, "1080p"));
  });

  it("prices the fast variant below standard", () => {
    const fast = model({ id: "google_veo3_fast" });
    expect(estimateModelCredits(fast, 5, "1080p")).toBe(106);
    expect(estimateModelCredits(fast, 5, "1080p")).toBeLessThan(estimateModelCredits(model({ id: "google_veo3" }), 5, "1080p"));
  });

  it("prices the lite variant below fast", () => {
    const lite = model({ id: "google_veo3_lite" });
    expect(estimateModelCredits(lite, 5, "1080p")).toBe(53);
    expect(estimateModelCredits(lite, 5, "1080p")).toBeLessThan(
      estimateModelCredits(model({ id: "google_veo3_fast" }), 5, "1080p"),
    );
  });

  it("recognises the spaced spelling as well as the compact one", () => {
    expect(estimateModelCredits(model({ id: "x", label: "Veo 3 Preview" }), 5, "1080p")).toBe(211);
  });
});

describe("Kling", () => {
  it("prices v2.6 at its flat per-second rate", () => {
    // 0.07 USD/s * 211 * 5s
    expect(estimateModelCredits(model({ id: "kling_v2.6" }), 5, "1080p")).toBe(74);
  });

  it("accepts either underscore or dot spelling of v2.6", () => {
    expect(estimateModelCredits(model({ id: "kling_v2_6" }), 5, "1080p")).toBe(74);
  });

  it("prices v3 by resolution", () => {
    const v3 = model({ id: "kling_v3" });
    expect(estimateModelCredits(v3, 5, "720p")).toBe(89);
    expect(estimateModelCredits(v3, 5, "1080p")).toBe(118);
    expect(estimateModelCredits(v3, 5, "4k")).toBe(443);
  });

  it("prices the omni/edit variants above plain v2.6", () => {
    const omni = model({ id: "kling_omni" });
    expect(estimateModelCredits(omni, 5, "720p")).toBe(133);
    expect(estimateModelCredits(omni, 5, "1080p")).toBe(177);
    expect(estimateModelCredits(omni, 5, "1080p")).toBeGreaterThan(estimateModelCredits(model({ id: "kling_v2.6" }), 5, "1080p"));
  });

  it("treats o3 and video_edit as the same omni-edit family", () => {
    expect(estimateModelCredits(model({ id: "kling_o3" }), 5, "1080p")).toBe(177);
    expect(estimateModelCredits(model({ id: "kling_video_edit" }), 5, "1080p")).toBe(177);
  });

  it("matches the family on the workflow path when the id says nothing", () => {
    // The key includes workflowPath, which is how workflow-only models are classified.
    const byPath = model({ id: "m1", label: "Edit", workflowPath: "workflow/i2v/kling_v3.json" });
    expect(estimateModelCredits(byPath, 5, "1080p")).toBe(118);
  });
});

describe("Seedance", () => {
  it("prices image-to-video from the token rate", () => {
    expect(estimateModelCredits(model({ id: "seedance_2_0" }), 5, "1080p")).toBe(567);
  });

  it("costs less at 720p than 1080p, and most at 4k", () => {
    const seedance = model({ id: "seedance_2_0" });
    const low = estimateModelCredits(seedance, 5, "720p");
    const mid = estimateModelCredits(seedance, 5, "1080p");
    const high = estimateModelCredits(seedance, 5, "4k");
    expect(low).toBe(228);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("prices the mini variant below fast, and fast below standard, at 720p", () => {
    // The variant rates only differ below 1080p.
    const mini = estimateModelCredits(model({ id: "seedance_2_0_mini" }), 5, "720p");
    const fast = estimateModelCredits(model({ id: "seedance_2_0_fast" }), 5, "720p");
    const standard = estimateModelCredits(model({ id: "seedance_2_0" }), 5, "720p");
    expect(mini).toBeLessThan(fast);
    expect(fast).toBeLessThan(standard);
  });

  it("quotes the upper bound of the range for a video-input workflow", () => {
    // Video-input Seedance bills per input unit, which is only known after the run,
    // so the gate uses the maximum rather than the optimistic figure.
    const r2v = model({ id: "seedance_2_0_r2v" });
    expect(estimateModelCredits(r2v, 5, "1080p")).toBe(1384);
  });

  it("labels a video-input workflow as a range and a plain one as a single figure", () => {
    expect(estimateModelCreditLabel(model({ id: "seedance_2_0_r2v" }), 5, "1080p")).toBe("623-1,384 credits");
    expect(estimateModelCreditLabel(model({ id: "seedance_2_0" }), 5, "1080p")).toBe("567 credits");
  });

  it("recognises every video-input spelling", () => {
    const single = estimateModelCredits(model({ id: "seedance_2_0" }), 5, "1080p");
    for (const id of ["seedance_r2v", "seedance_video_edit", "seedance_reference_videos", "seedance_video-to-video"]) {
      expect(estimateModelCredits(model({ id }), 5, "1080p")).toBeGreaterThan(single);
    }
    expect(estimateModelCredits(model({ id: "seedance_x", label: "Seedance video editing" }), 5, "1080p")).toBeGreaterThan(
      single,
    );
  });
});

describe("image models", () => {
  it("prices GPT image at its upper quality tier", () => {
    // 0.67 USD * 211
    expect(estimateModelCredits(model({ id: "openai_gpt_image_2" }), undefined, "1080p")).toBe(141);
  });

  it("doubles the GPT image cost for two outputs", () => {
    expect(estimateModelCredits(model({ id: "openai_gpt_image_2" }), undefined, "1080p", 2)).toBe(282);
  });

  it("prices Nano Banana per image and doubles for two", () => {
    const nano = model({ id: "nano_banana_2" });
    expect(estimateModelCredits(nano, undefined, "1080p")).toBe(15);
    expect(estimateModelCredits(nano, undefined, "1080p", 2)).toBe(30);
  });

  it("charges more for a 4k Nano Banana output", () => {
    const nano = model({ id: "nano_banana_2" });
    expect(estimateModelCredits(nano, undefined, "4k")).toBe(32);
    expect(estimateModelCredits(nano, undefined, "4k")).toBeGreaterThan(estimateModelCredits(nano, undefined, "1080p"));
  });

  it("treats 1k and 2k Nano Banana output as the base rate", () => {
    const nano = model({ id: "nano_banana_2" });
    expect(estimateModelCredits(nano, undefined, "1k")).toBe(15);
    expect(estimateModelCredits(nano, undefined, "2k")).toBe(15);
  });

  it("clamps an out-of-range output count to one", () => {
    // Only 1 and 2 are offered; anything else must not multiply the charge.
    const nano = model({ id: "nano_banana_2" });
    expect(estimateModelCredits(nano, undefined, "1080p", 5)).toBe(15);
    expect(estimateModelCredits(nano, undefined, "1080p", 0)).toBe(15);
  });
});

describe("flat-rate models", () => {
  it("prices the exterior grid generator flat, regardless of duration", () => {
    const grid = model({ id: "exteriorgrid_generator" });
    expect(estimateModelCredits(grid, 5, "1080p")).toBe(6);
    expect(estimateModelCredits(grid, 30, "4k")).toBe(6);
  });

  it("prices reference transfer flat", () => {
    expect(estimateModelCredits(model({ id: "ref_transfer" }), 5, "1080p")).toBe(4);
  });

  it("keeps the exterior grid out of the GPT image label branch", () => {
    // The grid workflow mentions gpt_image internally; it must not inherit the
    // GPT image range label.
    const grid = model({ id: "exteriorgrid_generator", workflowPath: "workflow/image_editing/gpt_image_grid.json" });
    expect(estimateModelCreditLabel(grid, 5, "1080p")).toBe("6 credits");
  });
});

describe("unrecognised models", () => {
  it("falls back to the model's own declared cost", () => {
    expect(estimateModelCredits(model({ id: "brand_new_thing", cost: 42 }), 5, "1080p")).toBe(42);
  });

  it("rounds a fractional declared cost", () => {
    expect(estimateModelCredits(model({ id: "brand_new_thing", cost: 41.6 }), 5, "1080p")).toBe(42);
  });

  it("never returns a negative estimate", () => {
    // A negative estimate would read as "free" against the credit gate.
    expect(estimateModelCredits(model({ id: "brand_new_thing", cost: -10 }), 5, "1080p")).toBe(0);
  });
});

describe("labels", () => {
  it("suffixes a plain estimate with the unit", () => {
    expect(estimateModelCreditLabel(model({ id: "google_veo3" }), 5, "1080p")).toBe("211 credits");
  });

  it("quotes GPT image as a range because quality tier is chosen server-side", () => {
    expect(estimateModelCreditLabel(model({ id: "openai_gpt_image_2" }), undefined, "1080p")).toBe("35-141 credits");
    expect(estimateModelCreditLabel(model({ id: "openai_gpt_image_2" }), undefined, "1080p", 2)).toBe(
      "70-282 credits (2 images)",
    );
  });

  it("says how many images a two-output Nano Banana estimate covers", () => {
    expect(estimateModelCreditLabel(model({ id: "nano_banana_2" }), undefined, "1080p", 2)).toBe("30 credits (2 images)");
    expect(estimateModelCreditLabel(model({ id: "nano_banana_2" }), undefined, "1080p")).toBe("15 credits");
  });

  it("groups thousands so a large figure stays readable", () => {
    expect(estimateModelCreditLabel(model({ id: "seedance_2_0_r2v" }), 5, "1080p")).toContain(",");
  });
});

describe("resolution parsing", () => {
  it("accepts pixel dimensions as well as shorthand", () => {
    const veo = model({ id: "google_veo3" });
    expect(estimateModelCredits(veo, 5, "3840x2160")).toBe(estimateModelCredits(veo, 5, "4k"));
    expect(estimateModelCredits(veo, 5, "1280x720")).toBe(estimateModelCredits(veo, 5, "720p"));
  });

  it("ignores case and whitespace", () => {
    const veo = model({ id: "google_veo3" });
    expect(estimateModelCredits(veo, 5, " 4K ")).toBe(estimateModelCredits(veo, 5, "4k"));
  });

  it("treats an unknown resolution as 1080p rather than free", () => {
    const veo = model({ id: "google_veo3" });
    expect(estimateModelCredits(veo, 5, "potato")).toBe(estimateModelCredits(veo, 5, "1080p"));
  });
});
