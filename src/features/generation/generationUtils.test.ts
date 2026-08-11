import { describe, expect, it } from "vitest";
import { supports16By9CropToggle } from "./generationUtils";

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
