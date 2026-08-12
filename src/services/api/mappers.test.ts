import { describe, expect, it } from "vitest";
import type { BackendWorkflowModel } from "./types";
import { mapModel } from "./mappers";

function fluxModel(overrides: Partial<BackendWorkflowModel> = {}): BackendWorkflowModel {
  return {
    id: "brick_api_flux3_i2v",
    name: "Flux 3 Image To Video",
    category: "image_to_video",
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\Brick_api_flux3_i2v.json",
    requiredInputs: ["prompt", "single_image", "resolution", "seed"],
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    imageSlotCount: 1,
    outputType: "video",
    ...overrides,
  };
}

describe("Flux 3 model mapping", () => {
  it("maps image-to-video limits into the generation controls", () => {
    const model = mapModel(fluxModel());

    expect(model.backendCategory).toBe("image_to_video");
    expect(model.imageSlotCount).toBe(1);
    expect(model.requiresImage).toBe(true);
    expect(model.supportedResolutions).toEqual(["720p", "1080p"]);
    expect(model.supportedDurations).toEqual(Array.from({ length: 16 }, (_, index) => index + 5));
    expect(model.defaultDurationSeconds).toBe(5);
  });

  it("maps the first/last-frame workflow to two required image slots", () => {
    const model = mapModel(
      fluxModel({
        id: "brick_api_flux3_flf2v",
        name: "Flux 3 First Last Frame To Video",
        category: "first_last_frame_to_video",
        workflowPath: "C:\\Momi-Animation\\workflow\\flf2v\\Brick_api_flux3_flf2v.json",
        requiredInputs: ["prompt", "start_frame", "end_frame", "resolution", "seed"],
        requiresStartEndFrames: true,
        imageSlotCount: 2,
      }),
    );

    expect(model.backendCategory).toBe("first_last_frame_to_video");
    expect(model.requiresTwoImages).toBe(true);
    expect(model.imageSlotCount).toBe(2);
  });
});
