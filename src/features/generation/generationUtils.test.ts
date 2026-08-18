import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEEDANCE_RATIO,
  normalizeSeedanceRatio,
  supports16By9CropToggle,
  supportsSeedanceRatio,
  workflowOptionsForJob,
} from "./generationUtils";

function model(overrides: Partial<Parameters<typeof supports16By9CropToggle>[0]> = {}) {
  return {
    id: "brick_api_flux3_i2v",
    label: "Flux 3 Image To Video",
    category: "video" as const,
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\Brick_api_flux3_i2v.json",
    ...overrides,
  };
}

describe("supports16By9CropToggle", () => {
  it("offers the toggle for image to video models", () => {
    expect(supports16By9CropToggle(model({ backendCategory: "image_to_video" }))).toBe(true);
  });

  it("offers the toggle for first/last frame to video models", () => {
    expect(supports16By9CropToggle(model({ backendCategory: "first_last_frame_to_video" }))).toBe(true);
  });

  it("infers first/last frame to video from the workflow path when the backend category is missing", () => {
    expect(
      supports16By9CropToggle(
        model({
          id: "brick_api_flux3_flf2v",
          label: "Flux 3 First Last Frame To Video",
          workflowPath: "C:\\Momi-Animation\\workflow\\flf2v\\Brick_api_flux3_flf2v.json",
        }),
      ),
    ).toBe(true);
  });

  it("keeps cropping forced for other video models", () => {
    expect(supports16By9CropToggle(model({ backendCategory: "video_upscale" }))).toBe(false);
  });
});

describe("seedance ratio", () => {
  const seedanceReference = model({
    id: "brick_api_seedance2_0_i2v",
    label: "Seedance2 0 I2v",
    workflowPath: "C:/Momi-Animation/workflow/i2v/Brick_api_seedance2_0_i2v .json",
  });
  const seedanceFirstLast = model({
    id: "brick_api_seedance_2_0flf2v",
    label: "Api Seedance 2.0flf2v",
    workflowPath: "C:/Momi-Animation/workflow/flf2v/Brick_api_Seedance 2.0flf2v.json",
  });

  it("offers the ratio on both Seedance video nodes", () => {
    expect(supportsSeedanceRatio(seedanceReference)).toBe(true);
    expect(supportsSeedanceRatio(seedanceFirstLast)).toBe(true);
  });

  it("leaves non-Seedance models alone", () => {
    expect(supportsSeedanceRatio(model())).toBe(false);
  });

  it("keeps every ratio the nodes offer and falls back for anything else", () => {
    for (const ratio of ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]) {
      expect(normalizeSeedanceRatio(ratio)).toBe(ratio);
    }
    expect(normalizeSeedanceRatio("auto")).toBe(DEFAULT_SEEDANCE_RATIO);
    expect(normalizeSeedanceRatio(undefined)).toBe(DEFAULT_SEEDANCE_RATIO);
  });

  it("submits the ratio only for Seedance models", () => {
    const options = {
      archVizGrid: { slotCount: "1" as const, useSmartDefaults: true, cameraSlots: [] },
      saveNumber: "0001",
      imageOutputCount: 1 as const,
      nanoBananaAspectRatio: "auto",
      seedanceRatio: "9:16",
    };
    expect(workflowOptionsForJob({ ...options, model: seedanceFirstLast }).seedance).toEqual({ ratio: "9:16" });
    expect(workflowOptionsForJob({ ...options, model: model() }).seedance).toBeUndefined();
  });
});
