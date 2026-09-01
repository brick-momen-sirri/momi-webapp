import { describe, expect, it } from "vitest";
import type { ModelType } from "../../types";
import {
  DEFAULT_SEEDANCE_VERSION,
  normalizeSeedanceVersion,
  seedanceDurations,
  seedanceEffectiveModel,
  SEEDANCE_VERSIONS,
  seedanceSupportsRatio,
  seedanceSupportsVideoEditing,
  seedanceVersion,
} from "./seedanceVersions";

/**
 * The same expectations backend/src/seedanceVersions.test.ts asserts.
 *
 * Both sides read backend/src/data/seedanceVersions.json, so the data cannot drift;
 * what these guard is that the two interpretations of it stay in step, since the
 * packages can share the table but not the code that reads it.
 */

function model(overrides: Partial<ModelType> = {}): ModelType {
  return {
    id: "brick_api_seedance2_0_i2v",
    label: "Api Seedance2 0 I2v",
    description: "Loaded from i2v.",
    category: "video",
    backendCategory: "image_to_video",
    workflowPath: "C:/Momi-Animation/workflow/i2v/Brick_api_seedance2_0_i2v .json",
    cost: 560,
    estimatedTime: "2-5 min",
    supportedResolutions: ["720p", "1080p", "4K"],
    supportedDurations: Array.from({ length: 12 }, (_, index) => index + 4),
    defaultDurationSeconds: 5,
    ...overrides,
  };
}

describe("seedance version table", () => {
  it("offers exactly the two versions, defaulting to 2.0", () => {
    expect(SEEDANCE_VERSIONS.map((version) => version.id)).toEqual(["2.0", "2.5"]);
    expect(DEFAULT_SEEDANCE_VERSION).toBe("2.0");
  });

  it("gives 2.5 a longer ceiling and no 4K", () => {
    expect(seedanceVersion("2.0").resolutions).toEqual(["480p", "720p", "1080p", "4K"]);
    expect(seedanceVersion("2.5").resolutions).toEqual(["480p", "720p", "1080p"]);
    expect(seedanceDurations(seedanceVersion("2.0")).at(-1)).toBe(15);
    expect(seedanceDurations(seedanceVersion("2.5")).at(-1)).toBe(30);
    expect(seedanceVersion("2.0").outputFormat).toBeNull();
    expect(seedanceVersion("2.5").outputFormat).toBe("mp4");
  });

  it("falls back to the default for anything it does not recognise", () => {
    expect(normalizeSeedanceVersion("2.5")).toBe("2.5");
    expect(normalizeSeedanceVersion("3.0")).toBe(DEFAULT_SEEDANCE_VERSION);
    expect(normalizeSeedanceVersion(undefined)).toBe(DEFAULT_SEEDANCE_VERSION);
    expect(seedanceVersion("nonsense").id).toBe(DEFAULT_SEEDANCE_VERSION);
  });
});

describe("seedanceEffectiveModel", () => {
  it("replaces the workflow file's limits with the version's", () => {
    const on25 = seedanceEffectiveModel(model(), "2.5");
    expect(on25.supportedResolutions).toEqual(["480p", "720p", "1080p"]);
    expect(on25.supportedDurations?.at(-1)).toBe(30);

    const on20 = seedanceEffectiveModel(model(), "2.0");
    expect(on20.supportedResolutions).toEqual(["480p", "720p", "1080p", "4K"]);
    expect(on20.supportedDurations?.at(-1)).toBe(15);
    expect(on20.defaultDurationSeconds).toBe(5);
  });

  it("drops a default duration the picked version cannot produce", () => {
    const long = model({ defaultDurationSeconds: 20 });
    expect(seedanceEffectiveModel(long, "2.5").defaultDurationSeconds).toBe(20);
    expect(seedanceEffectiveModel(long, "2.0").defaultDurationSeconds).toBe(5);
  });

  it("leaves a non-Seedance model exactly as it was", () => {
    const kling = model({ id: "brick_api_kling_v3_video", label: "Api Kling V3 Video", workflowPath: "i2v/kling.json" });
    expect(seedanceEffectiveModel(kling, "2.5")).toEqual(kling);
  });
});

describe("per-version node inputs", () => {
  const firstLast = model({
    id: "brick_api_seedance_2_0flf2v",
    label: "Api Seedance 2.0flf2v",
    backendCategory: "first_last_frame_to_video",
    workflowPath: "C:/Momi-Animation/workflow/flf2v/Brick_api_Seedance 2.0flf2v.json",
  });
  const videoEdit = model({
    id: "brick_api_seedance2_0_r2v",
    label: "Api Seedance2 0 R2v",
    backendCategory: "video_editing",
    requiresVideo: true,
    workflowPath: "C:/Momi-Animation/workflow/video_edit/Brick_api_seedance2_0_r2v.json",
  });

  it("keeps the ratio everywhere except 2.5 first-last-frame", () => {
    expect(seedanceSupportsRatio(model(), seedanceVersion("2.5"))).toBe(true);
    expect(seedanceSupportsRatio(firstLast, seedanceVersion("2.0"))).toBe(true);
    expect(seedanceSupportsRatio(firstLast, seedanceVersion("2.5"))).toBe(false);
  });

  it("offers the edit switch only on 2.5, and only where a clip is an input", () => {
    expect(seedanceSupportsVideoEditing(videoEdit, seedanceVersion("2.5"))).toBe(true);
    expect(seedanceSupportsVideoEditing(videoEdit, seedanceVersion("2.0"))).toBe(false);
    // Image-to-video runs the same node, but there is no source clip to edit.
    expect(seedanceSupportsVideoEditing(model(), seedanceVersion("2.5"))).toBe(false);
    expect(seedanceSupportsVideoEditing({ ...firstLast, requiresVideo: true }, seedanceVersion("2.5"))).toBe(false);
  });
});
