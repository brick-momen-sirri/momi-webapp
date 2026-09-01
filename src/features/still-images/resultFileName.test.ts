import { describe, expect, it } from "vitest";

import { stillImageResultFileName } from "./resultFileName";
import type { Project } from "../../types";

// The anchor case is a real filename the backend wrote during the first live
// dispatcher run, so this suite fails if the preview drifts from what actually
// lands on disk. Mirrors backend/src/serverlessArtifactService.ts.

const august13 = new Date(2026, 7, 13);

function project(overrides: Partial<Project> = {}) {
  return {
    name: "Dispatcher E2E",
    folderName: "9999_Internal_Dispatcher_E2E",
    folderPath: "C:\\renders\\9999_Internal_Dispatcher_E2E",
    ...overrides,
  } as Project;
}

describe("stillImageResultFileName", () => {
  it("reproduces the filename the backend actually wrote", () => {
    // Live run wrote: 20260813_pro-upscaler_9999_cam-42_v001.png
    expect(
      stillImageResultFileName({
        project: project(),
        modelName: "Pro Upscaler",
        saveNumber: "0042",
        today: august13,
      }),
    ).toBe("20260813_pro-upscaler_9999_cam-42_v###.png");
  });

  it("lowercases the model and hyphenates its spaces", () => {
    // "Pro Upscaler" must become "pro-upscaler", never "pro_upscaler": spaces are
    // not in the illegal set, they are hyphenated afterwards.
    const names: Array<[string, string]> = [
      ["Pro Upscaler", "pro-upscaler"],
      ["General Enhancement", "general-enhancement"],
      ["Reference Generator", "reference-generator"],
      ["Flux 2 Klein Edit", "flux-2-klein-edit"],
    ];
    for (const [modelName, expected] of names) {
      expect(stillImageResultFileName({ project: project(), modelName, saveNumber: "0001", today: august13 })).toBe(
        `20260813_${expected}_9999_cam-01_v###.png`,
      );
    }
  });

  it("takes the four-digit project code from the disk folder name", () => {
    expect(
      stillImageResultFileName({
        project: project({ folderName: "8384_STORYN_Rum_Distillery" }),
        modelName: "Pro Upscaler",
        saveNumber: "7",
        today: august13,
      }),
    ).toBe("20260813_pro-upscaler_8384_cam-07_v###.png");
  });

  it("falls back to the folder path basename when folderName is absent", () => {
    expect(
      stillImageResultFileName({
        project: project({ folderName: undefined, folderPath: "C:\\renders\\8127_AJYAD_ARRIVAL" }),
        modelName: "Flux 2 Klein Edit",
        saveNumber: "12",
        today: august13,
      }),
    ).toBe("20260813_flux-2-klein-edit_8127_cam-12_v###.png");
  });

  it("pads the camera number to two digits and strips non-digits", () => {
    const camera = (saveNumber: string) =>
      stillImageResultFileName({ project: project(), modelName: "Pro Upscaler", saveNumber, today: august13 }).match(
        /cam-(\d+)/,
      )?.[1];

    expect(camera("0042")).toBe("42");
    expect(camera("7")).toBe("07");
    expect(camera("")).toBe("00");
    expect(camera("abc")).toBe("00");
    // Four digits are kept, so a three-digit camera is not truncated to two.
    expect(camera("0123")).toBe("123");
  });

  it("handles a project with no four-digit code", () => {
    const name = stillImageResultFileName({
      project: project({ folderName: "Playground", folderPath: "", name: "Playground" }),
      modelName: "Pro Upscaler",
      saveNumber: "3",
      today: august13,
    });
    expect(name).toBe("20260813_pro-upscaler_PLAY_cam-03_v###.png");
  });

  it("does not crash without a project", () => {
    expect(stillImageResultFileName({ project: undefined, modelName: "Pro Upscaler", saveNumber: "1", today: august13 })).toBe(
      "20260813_pro-upscaler_PROJ_cam-01_v###.png",
    );
  });

  it("leaves the version as a placeholder rather than guessing", () => {
    // The backend reserves it from a per-project counter at save time. Printing
    // v001 would be right only for the first render of that camera that day.
    const name = stillImageResultFileName({
      project: project(),
      modelName: "Pro Upscaler",
      saveNumber: "1",
      today: august13,
    });
    expect(name).toContain("_v###.png");
    expect(name).not.toMatch(/_v\d{3}\.png$/);
  });

  it("uses the local date, matching the backend's todayCompact", () => {
    expect(
      stillImageResultFileName({
        project: project(),
        modelName: "Pro Upscaler",
        saveNumber: "1",
        today: new Date(2026, 0, 5),
      }),
    ).toMatch(/^20260105_/);
  });
});
