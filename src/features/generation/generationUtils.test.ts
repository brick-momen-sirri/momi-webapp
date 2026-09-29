import { describe, expect, it } from "vitest";
import type { ModelType } from "../../types";
import {
  DEFAULT_SEEDANCE_RATIO,
  normalizeSeedanceRatio,
  supports16By9CropToggle,
  supportsKlingCameraStabilization,
  supportsSeedanceRatio,
  workflowOptionsForJob,
} from "./generationUtils";

function model(overrides: Partial<ModelType> = {}) {
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
    backendCategory: "image_to_video",
    workflowPath: "C:/Momi-Animation/workflow/i2v/Brick_api_seedance2_0_i2v .json",
  });
  const seedanceFirstLast = model({
    id: "brick_api_seedance_2_0flf2v",
    label: "Api Seedance 2.0flf2v",
    backendCategory: "first_last_frame_to_video",
    workflowPath: "C:/Momi-Animation/workflow/flf2v/Brick_api_Seedance 2.0flf2v.json",
  });

  it("offers the ratio on both Seedance video nodes on 2.0", () => {
    expect(supportsSeedanceRatio(seedanceReference, "2.0")).toBe(true);
    expect(supportsSeedanceRatio(seedanceFirstLast, "2.0")).toBe(true);
  });

  // 2.5's first-last-frame option has no ratio input at all, so offering one would
  // be a setting ComfyUI silently drops.
  it("drops the ratio for 2.5 first-last-frame but keeps it on the reference node", () => {
    expect(supportsSeedanceRatio(seedanceReference, "2.5")).toBe(true);
    expect(supportsSeedanceRatio(seedanceFirstLast, "2.5")).toBe(false);
  });

  it("infers the first-last-frame node from the workflow path when no category is set", () => {
    const uncategorized = model({
      id: "brick_api_seedance_2_0flf2v",
      label: "Api Seedance 2.0flf2v",
      workflowPath: "C:\\Momi-Animation\\workflow\\flf2v\\Brick_api_Seedance 2.0flf2v.json",
    });
    expect(supportsSeedanceRatio(uncategorized, "2.5")).toBe(false);
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

  const submissionOptions = {
    archVizGrid: { slotCount: "1" as const, useSmartDefaults: true, cameraSlots: [] },
    saveNumber: "0001",
    imageOutputCount: 1 as const,
    nanoBananaAspectRatio: "auto",
    seedanceRatio: "9:16",
    seedanceVersionId: "2.0" as const,
    seedanceVideoEditing: false,
    seedanceGenerateAudio: false,
    klingCameraStabilization: true,
  };

  it("submits the version and ratio only for Seedance models", () => {
    expect(workflowOptionsForJob({ ...submissionOptions, model: seedanceFirstLast }).seedance).toEqual({
      version: "2.0",
      ratio: "9:16",
      generateAudio: false,
    });
    expect(workflowOptionsForJob({ ...submissionOptions, model: model() }).seedance).toBeUndefined();
  });

  it("omits the ratio on 2.5 first-last-frame, whose node has no such input", () => {
    expect(workflowOptionsForJob({ ...submissionOptions, model: seedanceFirstLast, seedanceVersionId: "2.5" }).seedance).toEqual({
      version: "2.5",
      generateAudio: false,
    });
  });

  // Unlike the ratio and the edit switch, this one is never conditional: the node
  // declares generate_audio on every version and task and defaults it to true, so a
  // Seedance job that leaves it out comes back with an audio track nobody asked for.
  it("sends the audio switch on every Seedance version and task", () => {
    for (const versionId of ["2.0", "2.5"] as const) {
      for (const seedanceModel of [seedanceFirstLast, seedanceReference]) {
        expect(
          workflowOptionsForJob({ ...submissionOptions, model: seedanceModel, seedanceVersionId: versionId }).seedance
            ?.generateAudio,
        ).toBe(false);
        expect(
          workflowOptionsForJob({
            ...submissionOptions,
            model: seedanceModel,
            seedanceVersionId: versionId,
            seedanceGenerateAudio: true,
          }).seedance?.generateAudio,
        ).toBe(true);
      }
    }
  });

  it("sends the edit switch only where 2.5 has one", () => {
    const videoEdit = model({
      id: "brick_api_seedance2_0_r2v",
      label: "Api Seedance2 0 R2v",
      backendCategory: "video_editing",
      requiresVideo: true,
      workflowPath: "C:/Momi-Animation/workflow/video_edit/Brick_api_seedance2_0_r2v.json",
    });
    const asked = { ...submissionOptions, seedanceVideoEditing: true };

    expect(workflowOptionsForJob({ ...asked, model: videoEdit, seedanceVersionId: "2.5" }).seedance).toEqual({
      version: "2.5",
      ratio: "9:16",
      videoEditing: true,
      generateAudio: false,
    });
    // 2.0 has no video_editing input, and the reference node with no video has
    // nothing to edit.
    expect(workflowOptionsForJob({ ...asked, model: videoEdit, seedanceVersionId: "2.0" }).seedance).toEqual({
      version: "2.0",
      ratio: "9:16",
      generateAudio: false,
    });
    expect(workflowOptionsForJob({ ...asked, model: seedanceReference, seedanceVersionId: "2.5" }).seedance).toEqual({
      version: "2.5",
      ratio: "9:16",
      generateAudio: false,
    });
  });
});

describe("Kling camera stabilization", () => {
  const options = {
    archVizGrid: { slotCount: "1" as const, useSmartDefaults: true, cameraSlots: [] },
    saveNumber: "0001",
    imageOutputCount: 1 as const,
    nanoBananaAspectRatio: "auto",
    seedanceRatio: "16:9",
    seedanceVersionId: "2.0" as const,
    seedanceVideoEditing: false,
    seedanceGenerateAudio: false,
    klingCameraStabilization: true,
  };
  const klingVideo = model({
    id: "brick_api_kling_v3_video",
    label: "Api Kling V3 Video",
    backendCategory: "image_to_video",
    workflowPath: "C:\Momi-Animation\workflow\i2v\Brick_api_kling_v3_video.json",
  });
  const klingFirstLast = model({
    id: "brick_api_kling_v3_flf2v",
    label: "Api Kling V3 Flf2v",
    backendCategory: "first_last_frame_to_video",
    workflowPath: "C:\Momi-Animation\workflow\flf2v\Brick_api_kling_v3_flf2v.json",
  });
  const kling26 = model({
    id: "brick_api_kling_v2.6_video",
    label: "Api Kling V2.6 Video",
    backendCategory: "image_to_video",
    workflowPath: "C:\Momi-Animation\workflow\i2v\Brick_api_kling_v2.6_video.json",
  });

  // Only KlingVideoNode has a negative prompt; anywhere else the switch would do nothing.
  it("is offered only on Kling 3.0 image-to-video", () => {
    expect(supportsKlingCameraStabilization(klingVideo)).toBe(true);
    expect(supportsKlingCameraStabilization(klingFirstLast)).toBe(false);
    expect(supportsKlingCameraStabilization(kling26)).toBe(false);
    expect(supportsKlingCameraStabilization(model())).toBe(false);
  });

  it("sends the switch in both states on Kling 3.0 image-to-video and nowhere else", () => {
    expect(workflowOptionsForJob({ ...options, model: klingVideo }).kling).toEqual({ cameraStabilization: true });
    expect(workflowOptionsForJob({ ...options, model: klingVideo, klingCameraStabilization: false }).kling).toEqual({
      cameraStabilization: false,
    });
    expect(workflowOptionsForJob({ ...options, model: klingFirstLast }).kling).toBeUndefined();
    expect(workflowOptionsForJob({ ...options, model: kling26 }).kling).toBeUndefined();
  });
});
