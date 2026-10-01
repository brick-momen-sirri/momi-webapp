import { describe, expect, it } from "vitest";
import type { Job } from "../../types";
import {
  draftCountdown,
  draftCountdownShortText,
  draftExpiryText,
  draftFinalModelId,
  draftFinalPlan,
  finalsForDraft,
  hasDraftCountdown,
} from "./draftFinal";

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
  describe("countdown", () => {
    // The draft finished at 11:00 and BytePlus keeps it until 11:00 a week later;
    // Momi stops 30 minutes early, so the clock runs to 10:30.
    it("counts down to the moment the button stops offering the final", () => {
      const countdown = draftCountdown(job().draft, NOW)!;
      expect(new Date(countdown.deadline).toISOString()).toBe("2026-10-07T10:30:00.000Z");
      expect(countdown).toMatchObject({ phase: "fresh", days: 6, hours: 22, minutes: 30, seconds: 0 });
      expect(countdown.fraction).toBeGreaterThan(0.98);
      expect(draftCountdownShortText(countdown)).toBe("6d 22h");
      // The plan quotes the same moment, so the tooltip and the clock agree.
      expect(draftFinalPlan(job(), NOW)?.expiresAt).toBe("2026-10-07T10:30:00.000Z");
    });

    it("turns amber under three days and ember on the last day", () => {
      expect(draftCountdown(job().draft, Date.parse("2026-10-04T12:00:00.000Z"))?.phase).toBe("soon");
      const lastDay = draftCountdown(job().draft, Date.parse("2026-10-07T09:49:30.000Z"))!;
      expect(lastDay).toMatchObject({ phase: "urgent", days: 0, hours: 0, minutes: 40, seconds: 30 });
      expect(draftCountdownShortText(lastDay)).toBe("40m");
      expect(draftCountdownShortText(draftCountdown(job().draft, Date.parse("2026-10-07T10:29:40.000Z"))!)).toBe("<1m");
    });

    it("reaches zero exactly when the final is refused", () => {
      const deadline = Date.parse("2026-10-07T10:30:00.000Z");
      expect(draftCountdown(job().draft, deadline - 1)?.phase).toBe("urgent");
      expect(draftFinalPlan(job(), deadline - 1)?.refusal).toBeUndefined();
      const expired = draftCountdown(job().draft, deadline)!;
      expect(expired).toMatchObject({ phase: "expired", remainingMs: 0, fraction: 0 });
      expect(draftCountdownShortText(expired)).toBe("Expired");
      expect(draftFinalPlan(job(), deadline)?.refusal).toMatch(/7 days/);
    });

    it("is only shown on a finished Seedance draft", () => {
      expect(hasDraftCountdown(job())).toBe(true);
      expect(hasDraftCountdown(job({ status: "running" }))).toBe(false);
      expect(hasDraftCountdown(job({ draft: { kind: "minimax-h3-768p", createdAt: "2026-09-30T11:00:00.000Z" } }))).toBe(false);
      expect(draftCountdown({ kind: "minimax-h3-768p", createdAt: "2026-09-30T11:00:00.000Z" }, NOW)).toBeUndefined();
      expect(hasDraftCountdown(job({ workflowOptions: { draftFinal: { sourceJobId: "job_x" } } }))).toBe(false);
    });
  });
});
