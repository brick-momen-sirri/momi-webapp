// Save numbers are what artists actually look for in the project folder, and the
// image/video distinction decides which field wins. Getting either wrong files a
// render under the wrong name, which is only noticed much later.

import { describe, expect, it } from "vitest";
import type { Job } from "../types";
import { getJobSaveNumber, getJobSaveNumberLabel, normalizeSaveNumber } from "./saveNumber";

function job(overrides: Partial<Job> = {}): Job {
  return {
    modelType: "Nano Banana",
    inputType: "image",
    outputType: "image",
    ...overrides,
  } as Job;
}

describe("normalizeSaveNumber", () => {
  it("pads to four digits", () => {
    expect(normalizeSaveNumber(7)).toBe("0007");
    expect(normalizeSaveNumber("12")).toBe("0012");
    expect(normalizeSaveNumber(1234)).toBe("1234");
  });

  it("falls back to 0000 for anything unusable", () => {
    for (const value of [undefined, null, "", "abc", "   "]) {
      expect(normalizeSaveNumber(value)).toBe("0000");
    }
  });

  it("strips non-digits rather than rejecting the value", () => {
    expect(normalizeSaveNumber("cam-12")).toBe("0012");
    expect(normalizeSaveNumber("1.5")).toBe("0015");
  });

  it("truncates to four digits from the left", () => {
    // Silent truncation is the existing behaviour; this pins it so a change is
    // deliberate rather than accidental.
    expect(normalizeSaveNumber(123456)).toBe("1234");
  });
});

describe("which field wins", () => {
  it("prefers shotNumber for video-like jobs", () => {
    const videoJob = job({
      outputType: "video",
      workflowOptions: { save: { shotNumber: "12", cameraNumber: "99" } },
    });
    expect(getJobSaveNumber(videoJob)).toBe("0012");
    expect(getJobSaveNumberLabel(videoJob)).toBe("Shot");
  });

  it("prefers cameraNumber for image jobs", () => {
    const imageJob = job({ workflowOptions: { save: { shotNumber: "12", cameraNumber: "99" } } });
    expect(getJobSaveNumber(imageJob)).toBe("0099");
    expect(getJobSaveNumberLabel(imageJob)).toBe("Camera");
  });

  it("falls back to the other field when the preferred one is absent", () => {
    const videoJob = job({ outputType: "video", workflowOptions: { save: { cameraNumber: "5" } } });
    expect(getJobSaveNumber(videoJob)).toBe("0005");

    const imageJob = job({ workflowOptions: { save: { shotNumber: "6" } } });
    expect(getJobSaveNumber(imageJob)).toBe("0006");
  });

  it("treats a job as video-like on any of the signals, not just outputType", () => {
    const save = { save: { shotNumber: "1", cameraNumber: "2" } };
    expect(getJobSaveNumberLabel(job({ outputType: "sequence", workflowOptions: save }))).toBe("Shot");
    expect(getJobSaveNumberLabel(job({ videoLength: "5", workflowOptions: save }))).toBe("Shot");
    expect(getJobSaveNumberLabel(job({ inputType: "video", workflowOptions: save }))).toBe("Shot");
    // Matched on the model name, which is the loosest of the signals.
    expect(getJobSaveNumberLabel(job({ modelType: "Kling Video 2.6", workflowOptions: save }))).toBe("Shot");
  });

  it("returns 0000 when a job carries no save options at all", () => {
    expect(getJobSaveNumber(job())).toBe("0000");
  });
});

// --- Cross-side truth table -------------------------------------------------
//
// The same cases are asserted in backend/src/jobFilters.test.ts against
// isVideoSaveJob. Both predicates decide the same question -- the backend picks
// the save number indexed for search, this one picks the number displayed -- and
// they drifted once already, so any change to one must fail the other.
//
// Keep the two tables identical. Field names differ across the two Job shapes
// (modelType/backendCategory here, modelName/category there); the CASES do not.
const VIDEO_TRUTH_TABLE: Array<{ name: string; job: Partial<Job>; isVideo: boolean }> = [
  { name: "explicit video output", job: { outputType: "video" }, isVideo: true },
  { name: "sequence output", job: { outputType: "sequence" }, isVideo: true },
  { name: "carries a video length", job: { outputType: undefined, videoLength: "5" }, isVideo: true },
  { name: "video input", job: { outputType: undefined, inputType: "video" }, isVideo: true },
  { name: "video in the category", job: { outputType: undefined, backendCategory: "i2v_video" }, isVideo: true },
  { name: "video in the model name", job: { outputType: undefined, modelType: "Kling Video 2.6" }, isVideo: true },
  { name: "explicit image output", job: { outputType: "image" }, isVideo: false },
  // The case the two sides disagreed on: no evidence either way is NOT video.
  { name: "no outputType and no other video signal", job: { outputType: undefined }, isVideo: false },
  { name: "image category and image model", job: { outputType: "image", backendCategory: "image_editing" }, isVideo: false },
];

describe("cross-side truth table", () => {
  for (const entry of VIDEO_TRUTH_TABLE) {
    it(`${entry.name} -> ${entry.isVideo ? "Shot" : "Camera"}`, () => {
      const label = getJobSaveNumberLabel(job({ modelType: "Nano Banana", inputType: "single_image", ...entry.job }));
      expect(label).toBe(entry.isVideo ? "Shot" : "Camera");
    });
  }
});
