// "Reuse settings" reads a finished job and repopulates the generation form from
// it. Everything here is about recognising what a job actually recorded, which is
// harder than it sounds: jobs come from two sources with different guarantees.
//
// Backend jobs carry real metadata. Jobs scanned off disk
// (source: "existing_project_media") often carry placeholder strings like
// "Unknown model" or "Missing prompt data", plus a missingMetadata list. Treating a
// placeholder as real data means silently loading the wrong model or an empty
// prompt into the form and charging the user for the resulting render.

import { describe, expect, it } from "vitest";
import type { Job, ModelType, WorkflowOptions } from "../../types";
import {
  canReuseJobSettings,
  findReusableModel,
  hasInputImageMetadata,
  hasInputVideoMetadata,
  hasKnownResolution,
  hasPromptMetadata,
  normalizeReusableArchVizGridOptions,
  reusableImageOutputCount,
  reusableNanoBananaAspectRatio,
  reusableSaveNumber,
} from "./jobReuse";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Veo 3",
    inputType: "single_image",
    prompt: "a glass tower at dusk",
    resolution: "1080p",
    status: "completed",
    inputImages: [],
    ...overrides,
  } as Job;
}

function model(overrides: Partial<ModelType> = {}): ModelType {
  return { id: "google_veo", label: "Google Veo 3", ...overrides } as ModelType;
}

describe("findReusableModel", () => {
  it("matches on the model id first", () => {
    const target = model({ id: "google_veo", label: "Google Veo 3" });
    const models = [model({ id: "kling", label: "Kling" }), target];
    expect(findReusableModel(job({ modelId: "google_veo" }), models)).toBe(target);
  });

  it("ignores separator and case differences in the id", () => {
    const target = model({ id: "nano_banana_2" });
    expect(findReusableModel(job({ modelId: "Nano-Banana-2" }), [target])).toBe(target);
  });

  it("strips a leading api prefix before comparing", () => {
    // Backend model ids are sometimes recorded with an "API " prefix.
    const target = model({ id: "seedance" });
    expect(findReusableModel(job({ modelId: "API seedance" }), [target])).toBe(target);
  });

  it("never resolves the existing-project-media placeholder as a model id", () => {
    const target = model({ id: "existing_project_media" });
    expect(findReusableModel(job({ modelId: "existing project media", modelType: "Unknown model" }), [target])).toBeUndefined();
  });

  it("falls back to the workflow path when the id does not match", () => {
    const target = model({ id: "other", workflowPath: "workflow/i2v/veo3.json" });
    const found = findReusableModel(
      job({ modelId: "gone", modelType: "Unknown model", workflowPath: "workflow/i2v/veo3.json" }),
      [target],
    );
    expect(found).toBe(target);
  });

  it("treats Windows and POSIX workflow paths as the same file", () => {
    const target = model({ id: "other", workflowPath: "workflow\\i2v\\veo3.json" });
    const found = findReusableModel(
      job({ modelId: "gone", modelType: "Unknown model", workflowPath: "workflow/i2v/veo3.json" }),
      [target],
    );
    expect(found).toBe(target);
  });

  it("matches on the workflow filename when the directories differ", () => {
    const target = model({ id: "other", workflowPath: "C:/elsewhere/veo3.json" });
    const found = findReusableModel(
      job({ modelId: "gone", modelType: "Unknown model", workflowPath: "workflow/i2v/veo3.json" }),
      [target],
    );
    expect(found).toBe(target);
  });

  it("falls back to the human-readable model name", () => {
    const target = model({ id: "google_veo", label: "Google Veo 3" });
    expect(findReusableModel(job({ modelType: "Google Veo 3" }), [target])).toBe(target);
  });

  it("refuses the placeholder model names rather than guessing", () => {
    const models = [model({ id: "google_veo", label: "Google Veo 3" })];
    expect(findReusableModel(job({ modelType: "Unknown model" }), models)).toBeUndefined();
    expect(findReusableModel(job({ modelType: "Missing model data" }), models)).toBeUndefined();
  });

  it("does not substring-match on labels short enough to collide", () => {
    // The substring fallback is guarded by length > 4 precisely so a label like
    // "Veo" cannot claim every job whose name happens to contain it.
    const target = model({ id: "veo", label: "Veo" });
    expect(findReusableModel(job({ modelType: "Some Veo-adjacent thing" }), [target])).toBeUndefined();
  });

  it("returns nothing when the model list is empty", () => {
    expect(findReusableModel(job({ modelId: "google_veo" }), [])).toBeUndefined();
  });
});

describe("hasPromptMetadata", () => {
  it("accepts any recorded prompt on a backend job", () => {
    expect(hasPromptMetadata(job({ prompt: "" }))).toBe(true);
  });

  it("rejects a prompt listed as missing metadata", () => {
    expect(hasPromptMetadata(job({ missingMetadata: ["prompt"] }))).toBe(false);
  });

  it("rejects the placeholder prompt on scanned media", () => {
    const scanned = job({ source: "existing_project_media", prompt: "Missing prompt data" });
    expect(hasPromptMetadata(scanned)).toBe(false);
  });

  it("accepts a real prompt on scanned media", () => {
    const scanned = job({ source: "existing_project_media", prompt: "a glass tower" });
    expect(hasPromptMetadata(scanned)).toBe(true);
  });

  it("rejects an empty prompt on scanned media", () => {
    expect(hasPromptMetadata(job({ source: "existing_project_media", prompt: "   " }))).toBe(false);
  });

  it("matches the missing-metadata entry loosely", () => {
    // The backend writes human phrases such as "Missing prompt data", not field keys.
    expect(hasPromptMetadata(job({ missingMetadata: ["Missing prompt data"] }))).toBe(false);
  });
});

describe("hasKnownResolution", () => {
  it("accepts a real resolution", () => {
    expect(hasKnownResolution(job({ resolution: "1080p" }))).toBe(true);
  });

  it("rejects the unknown placeholder and blanks", () => {
    expect(hasKnownResolution(job({ resolution: "Unknown" }))).toBe(false);
    expect(hasKnownResolution(job({ resolution: "  " }))).toBe(false);
  });
});

describe("hasInputImageMetadata", () => {
  it("trusts a backend job without inspecting the list", () => {
    expect(hasInputImageMetadata(job({ inputImages: [] }))).toBe(true);
  });

  it("requires scanned media to actually have inputs recorded", () => {
    expect(hasInputImageMetadata(job({ source: "existing_project_media", inputImages: [] }))).toBe(false);
  });

  it("rejects scanned media whose input image is flagged missing", () => {
    const scanned = job({
      source: "existing_project_media",
      inputImages: ["/api/media?path=x.png"],
      missingMetadata: ["original input image"],
    });
    expect(hasInputImageMetadata(scanned)).toBe(false);
  });
});

describe("hasInputVideoMetadata", () => {
  it("is false when there is no input video", () => {
    expect(hasInputVideoMetadata(job({ inputVideo: undefined }))).toBe(false);
  });

  it("is true for a recorded input video", () => {
    expect(hasInputVideoMetadata(job({ inputVideo: "/api/media?path=clip.mp4" }))).toBe(true);
  });

  it("is false when the input video is flagged missing", () => {
    const scanned = job({ inputVideo: "/api/media?path=clip.mp4", missingMetadata: ["original input video"] });
    expect(hasInputVideoMetadata(scanned)).toBe(false);
  });
});

describe("canReuseJobSettings", () => {
  const models = [model({ id: "google_veo", label: "Google Veo 3" })];

  it("is true when the model resolves", () => {
    expect(canReuseJobSettings(job({ modelId: "google_veo" }), models)).toBe(true);
  });

  it("is true on a usable duration alone", () => {
    const bare = job({ modelId: "gone", modelType: "Unknown model", resolution: "Unknown", durationSeconds: 8 });
    expect(canReuseJobSettings(bare, models)).toBe(true);
  });

  it("is true on saved workflow options alone", () => {
    const bare = job({
      modelId: "gone",
      modelType: "Unknown model",
      resolution: "Unknown",
      source: "existing_project_media",
      prompt: "Missing prompt data",
      workflowOptions: { save: { cameraNumber: "0012" } } as WorkflowOptions,
    });
    expect(canReuseJobSettings(bare, models)).toBe(true);
  });

  it("is false when a scanned job recorded nothing usable", () => {
    const empty = job({
      modelId: "existing project media",
      modelType: "Unknown model",
      resolution: "Unknown",
      source: "existing_project_media",
      prompt: "Missing prompt data",
      inputImages: [],
      durationSeconds: 0,
    });
    expect(canReuseJobSettings(empty, models)).toBe(false);
  });

  it("does not count a non-finite duration as usable", () => {
    const bare = job({
      modelId: "existing project media",
      modelType: "Unknown model",
      resolution: "Unknown",
      source: "existing_project_media",
      prompt: "Missing prompt data",
      durationSeconds: Number.NaN,
    });
    expect(canReuseJobSettings(bare, models)).toBe(false);
  });
});

describe("normalizeReusableArchVizGridOptions", () => {
  it("rejects anything that is not a plain object", () => {
    expect(normalizeReusableArchVizGridOptions(undefined)).toBeUndefined();
    expect(normalizeReusableArchVizGridOptions(null)).toBeUndefined();
    expect(normalizeReusableArchVizGridOptions("4")).toBeUndefined();
    expect(normalizeReusableArchVizGridOptions([])).toBeUndefined();
  });

  it("always returns nine camera slots regardless of input length", () => {
    const result = normalizeReusableArchVizGridOptions({ slotCount: "2", cameraSlots: ["Front view"] });
    // The grid control renders nine inputs; a short array would leave holes in it.
    expect(result?.cameraSlots).toHaveLength(9);
    expect(result?.cameraSlots[0]).toBe("Front view");
  });

  it("falls back to the default slot count when the stored one is not valid", () => {
    expect(normalizeReusableArchVizGridOptions({ slotCount: "7" })?.slotCount).toBe("4");
    expect(normalizeReusableArchVizGridOptions({ slotCount: 4 })?.slotCount).toBe("4");
  });

  it("keeps a valid stored slot count", () => {
    expect(normalizeReusableArchVizGridOptions({ slotCount: "9" })?.slotCount).toBe("9");
  });

  it("replaces blank slots with a usable default rather than an empty prompt", () => {
    const result = normalizeReusableArchVizGridOptions({ cameraSlots: ["   ", "Real view"] });
    expect(result?.cameraSlots[0]).not.toBe("   ");
    expect(result?.cameraSlots[0]).toBeTruthy();
    expect(result?.cameraSlots[1]).toBe("Real view");
  });

  it("only accepts a boolean for the smart-defaults flag", () => {
    expect(normalizeReusableArchVizGridOptions({ useSmartDefaults: false })?.useSmartDefaults).toBe(false);
    expect(normalizeReusableArchVizGridOptions({ useSmartDefaults: "yes" })?.useSmartDefaults).toBe(true);
  });
});

describe("reusableSaveNumber", () => {
  it("is undefined when nothing was saved", () => {
    expect(reusableSaveNumber(job({ workflowOptions: {} as WorkflowOptions }))).toBeUndefined();
  });

  it("prefers the shot number for a video result", () => {
    const video = job({
      outputType: "video",
      workflowOptions: { save: { shotNumber: "0007", cameraNumber: "0012" } } as WorkflowOptions,
    });
    expect(reusableSaveNumber(video)).toBe("0007");
  });

  it("prefers the camera number for an image result", () => {
    const image = job({
      outputType: "image",
      workflowOptions: { save: { shotNumber: "0007", cameraNumber: "0012" } } as WorkflowOptions,
    });
    expect(reusableSaveNumber(image)).toBe("0012");
  });

  it("falls back to whichever number exists", () => {
    const video = job({ outputType: "video", workflowOptions: { save: { cameraNumber: "0012" } } as WorkflowOptions });
    expect(reusableSaveNumber(video)).toBe("0012");
  });

  it("treats a sequence output as video-like", () => {
    const sequence = job({
      outputType: "sequence",
      workflowOptions: { save: { shotNumber: "0007", cameraNumber: "0012" } } as WorkflowOptions,
    });
    expect(reusableSaveNumber(sequence)).toBe("0007");
  });

  it("treats a model whose name mentions video as video-like", () => {
    const named = job({
      modelType: "Kling video 2.1",
      workflowOptions: { save: { shotNumber: "0007", cameraNumber: "0012" } } as WorkflowOptions,
    });
    expect(reusableSaveNumber(named)).toBe("0007");
  });

  it("ignores a blank stored number", () => {
    expect(reusableSaveNumber(job({ workflowOptions: { save: { cameraNumber: "  " } } as WorkflowOptions }))).toBeUndefined();
  });
});

describe("reusableImageOutputCount", () => {
  it("accepts only one or two outputs", () => {
    expect(reusableImageOutputCount({ nanoBanana: { outputCount: 2 } } as WorkflowOptions)).toBe(2);
    // Cast through unknown deliberately: the type says 1 | 2, but this value is
    // read back from persisted job JSON, where an out-of-range count is possible.
    expect(reusableImageOutputCount({ nanoBanana: { outputCount: 5 } } as unknown as WorkflowOptions)).toBeUndefined();
    expect(reusableImageOutputCount(undefined)).toBeUndefined();
  });

  it("prefers the GPT image count when both are present", () => {
    const options = { gptImage: { outputCount: 1 }, nanoBanana: { outputCount: 2 } } as WorkflowOptions;
    expect(reusableImageOutputCount(options)).toBe(1);
  });
});

describe("reusableNanoBananaAspectRatio", () => {
  it("normalizes a stored ratio", () => {
    expect(reusableNanoBananaAspectRatio({ nanoBanana: { aspectRatio: "16:9" } } as WorkflowOptions)).toBe("16:9");
  });

  it("is undefined when no ratio was stored", () => {
    expect(reusableNanoBananaAspectRatio(undefined)).toBeUndefined();
    expect(reusableNanoBananaAspectRatio({ nanoBanana: {} } as WorkflowOptions)).toBeUndefined();
  });

  it("falls back for an unrecognised ratio rather than passing it through", () => {
    const result = reusableNanoBananaAspectRatio({ nanoBanana: { aspectRatio: "banana" } } as WorkflowOptions);
    expect(result).not.toBe("banana");
    expect(result).toBeTruthy();
  });
});
