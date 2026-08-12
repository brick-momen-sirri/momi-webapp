import { describe, expect, it } from "vitest";

import { isStillImageJob, jobSection } from "./jobSection";
import type { Job } from "../../types";

// Mirrored in backend/src/jobFilters.ts, which backs the ?section= query
// parameter. Getting this wrong puts still image jobs in the Animation feed and
// Animation jobs in the Still Images panel -- both workspaces read the same store.

function job(workflowOptions?: Job["workflowOptions"]): Pick<Job, "workflowOptions"> {
  return { workflowOptions };
}

describe("jobSection", () => {
  it("reads a still image job from its preset options", () => {
    const stillJob = job({ stillImage: { categoryId: "pro-upscaler", settings: {} } });
    expect(jobSection(stillJob)).toBe("still_images");
    expect(isStillImageJob(stillJob)).toBe(true);
  });

  it("treats everything else as animation", () => {
    expect(jobSection(job())).toBe("animation");
    expect(jobSection(job({}))).toBe("animation");
    expect(isStillImageJob(job())).toBe(false);
  });

  it("does not confuse the save numbers for a preset", () => {
    // Both sections carry workflowOptions.save, so presence of that field says
    // nothing about which workspace a job came from.
    expect(jobSection(job({ save: { cameraNumber: "0004" } }))).toBe("animation");
    expect(jobSection(job({ save: { shotNumber: "0010" } }))).toBe("animation");
    expect(isStillImageJob(job({ save: { cameraNumber: "0004" } }))).toBe(false);
  });

  it("keeps a still image job in its section even with save numbers alongside", () => {
    expect(
      jobSection(job({ stillImage: { categoryId: "qwen-edit", settings: { mode: "edit" } }, save: { cameraNumber: "0012" } })),
    ).toBe("still_images");
  });
});
