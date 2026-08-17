import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { chainableResultImage } from "./chainResult";
import { useStillImagesForm } from "./useStillImagesForm";
import { useStillImagesSubmission } from "./useStillImagesSubmission";
import type { Job } from "../../types";

// The claim chaining rests on: a result is already saved project media, so the
// next job can be submitted against the same path on disk. If any part of this
// path turned it into a blob or a re-upload, the saving would be gone and a
// 100 MB PNG would make the round trip it was meant to avoid.

const createBackendJob = vi.fn();
const uploadJobMediaUrl = vi.fn();

vi.mock("../../services/backendApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/backendApi")>()),
  createBackendJob: (...args: unknown[]) => createBackendJob(...args),
}));

vi.mock("../generation/generationUtils", () => ({
  uploadJobMediaUrl: (...args: unknown[]) => uploadJobMediaUrl(...args),
}));

const completedJob = {
  id: "job_1",
  status: "completed",
  resultUrl: "/api/media?path=enhanced.png",
  fileName: "RAW_0012_GeneralEnhancement_v001.png",
  modelType: "General Enhancement",
} as Job;

beforeEach(() => {
  createBackendJob.mockReset();
  uploadJobMediaUrl.mockReset();
  createBackendJob.mockResolvedValue({ job: { id: "job_2" }, replayed: false });
  // The real helper returns anything that is not a blob: or data: URL unchanged.
  uploadJobMediaUrl.mockImplementation(async (url: string) => url);
});

describe("chaining a result into the next preset", () => {
  it("lands in the target preset's first slot and switches the panel to it", () => {
    const form = renderHook(() => useStillImagesForm());

    act(() => {
      form.result.current.useResultAsInput("pro-upscaler", chainableResultImage(completedJob)!);
    });

    expect(form.result.current.selectedCategoryId).toBe("pro-upscaler");
    expect(form.result.current.selectedState.images[0]?.url).toBe("/api/media?path=enhanced.png");
  });

  it("keeps the settings and prompt the target preset was already holding", () => {
    // Chaining carries one image across. It is not restoring a saved job, so
    // nothing else the artist has set up should move.
    const form = renderHook(() => useStillImagesForm());

    act(() => {
      form.result.current.setSelectedCategoryId("pro-upscaler");
    });
    act(() => {
      form.result.current.setSetting("upscale", "x4");
      form.result.current.setSeed("4242");
    });
    act(() => {
      form.result.current.useResultAsInput("pro-upscaler", chainableResultImage(completedJob)!);
    });

    expect(form.result.current.selectedState.settings.upscale).toBe("x4");
    expect(form.result.current.selectedState.seed).toBe("4242");
  });

  it("submits the saved path itself, with nothing uploaded", async () => {
    const form = renderHook(() => useStillImagesForm());
    const submission = renderHook(() => useStillImagesSubmission({ onJobCreated: () => {} }));

    act(() => {
      form.result.current.useResultAsInput("pro-upscaler", chainableResultImage(completedJob)!);
    });

    await act(async () => {
      await submission.result.current.submit({
        projectId: "prj_1",
        categoryId: "pro-upscaler",
        categoryState: form.result.current.selectedState,
        targetFolderId: "",
        saveNumber: "0013",
      });
    });

    // The URL the previous job wrote, forwarded untouched.
    expect(createBackendJob.mock.calls[0][0].inputImages).toEqual(["/api/media?path=enhanced.png"]);
    // Never the rendition the slot was showing.
    expect(createBackendJob.mock.calls[0][0].inputImages[0]).not.toContain("thumbnail");
  });
});
