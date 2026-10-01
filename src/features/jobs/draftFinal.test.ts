import { describe, expect, it } from "vitest";
import type { Job } from "../../types";
import { draftExpiryText, draftFinalModelId, draftFinalPlan, finalsForDraft } from "./draftFinal";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_draft",
    projectId: "prj_a",
    userId: "usr_a",
    modelType: "Seedance",
    backendCategory: "image_to_video",
    inputType: "single_image",
    prompt: "p",
    resolution: "480p",
    status: "completed",
    inputImages: [],
    durationSeconds: 5,
    createdAt: "2026-09-30T11:00:00.000Z",
    draft: {
      kind: "seedance-2.5-draft",
      taskId: "cgt-1",
      createdAt: "2026-09-30T11:00:00.000Z",
      expiresAt: "2026-10-07T11:00:00.000Z",
    },
    ...overrides,
  };
}

describe("draft finals", () => {
  it("names the same registered model the server expects", () => {
    expect(draftFinalModelId("seedance-2.5-draft", "image_to_video")).toBe("draft_final_seedance_2_5_i2v");
    expect(draftFinalModelId("minimax-h3-768p", "video_editing")).toBe("draft_final_minimax_h3_2k_r2v");
    expect(draftFinalModelId("minimax-h3-768p", "image_editing")).toBeUndefined();
  });

  it("offers the final of a fresh draft with its cost", () => {
    const plan = draftFinalPlan(job(), NOW);
    expect(plan?.modelId).toBe("draft_final_seedance_2_5_i2v");
    expect(plan?.label).toBe("1080p final");
    expect(plan?.refusal).toBeUndefined();
    expect(plan?.credits).toBeGreaterThan(0);
    expect(draftExpiryText(plan?.expiresAt, NOW)).toBe("expires in 6 days");
  });

  it("says why an old or unfinished draft cannot be finalized", () => {
    expect(draftFinalPlan(job(), Date.parse("2026-10-07T10:45:00.000Z"))?.refusal).toMatch(/7 days/);
    expect(draftFinalPlan(job({ status: "running" }), NOW)?.refusal).toMatch(/completed/);
    expect(draftFinalPlan(job({ draft: undefined }), NOW)).toBeUndefined();
    // A final is not itself a draft.
    expect(draftFinalPlan(job({ workflowOptions: { draftFinal: { sourceJobId: "job_x" } } }), NOW)).toBeUndefined();
  });

  it("finds the finals already started from a draft, newest first", () => {
    const older = job({ id: "f1", createdAt: "2026-09-30T11:10:00.000Z", workflowOptions: { draftFinal: { sourceJobId: "job_draft" } } });
    const newer = job({ id: "f2", createdAt: "2026-09-30T11:20:00.000Z", workflowOptions: { draftFinal: { sourceJobId: "job_draft" } } });
    const unrelated = job({ id: "f3", workflowOptions: { draftFinal: { sourceJobId: "job_other" } } });
    expect(finalsForDraft(job(), [older, unrelated, newer]).map((item) => item.id)).toEqual(["f2", "f1"]);
  });
});
