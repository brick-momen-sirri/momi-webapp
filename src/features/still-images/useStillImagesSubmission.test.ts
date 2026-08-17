import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

import { stillImageModelId } from "./stillImageModelId";
import { createInitialStillImagesState } from "./stillImageCategories";
import { useStillImagesSubmission } from "./useStillImagesSubmission";
import type { UploadedImage } from "../../types";

const createBackendJob = vi.fn();
const uploadJobMediaUrl = vi.fn();

vi.mock("../../services/backendApi", () => ({
  createBackendJob: (...args: unknown[]) => createBackendJob(...args),
}));

vi.mock("../generation/generationUtils", () => ({
  uploadJobMediaUrl: (...args: unknown[]) => uploadJobMediaUrl(...args),
}));

// The submission is where the UI's shape becomes the server's contract: the model
// id has to match the preset, hidden settings must not be sent, and a promptless
// preset must not carry a prompt (the server rejects one rather than ignoring it).

function image(id: string): UploadedImage {
  return { id, name: `${id}.png`, url: `blob:${id}` } as UploadedImage;
}

const state = createInitialStillImagesState();

beforeEach(() => {
  createBackendJob.mockReset();
  uploadJobMediaUrl.mockReset();
  createBackendJob.mockResolvedValue({ job: { id: "job_1" }, replayed: false });
  uploadJobMediaUrl.mockImplementation(async (url: string) => `/api/media?path=${encodeURIComponent(url)}`);
});

function setup() {
  const onJobCreated = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useStillImagesSubmission({ onJobCreated, onError }));
  return { hook, onJobCreated, onError };
}

describe("useStillImagesSubmission", () => {
  it("sends the preset model id and only the visible settings", async () => {
    const { hook, onJobCreated } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "pro-upscaler",
        categoryState: { ...state["pro-upscaler"], images: [image("a")] },
        targetFolderId: "fld_1",
        saveNumber: "0012",
      });
    });

    expect(createBackendJob).toHaveBeenCalledTimes(1);
    const payload = createBackendJob.mock.calls[0][0];
    expect(payload.modelId).toBe(stillImageModelId("pro-upscaler"));
    expect(payload.workflowOptions.stillImage.categoryId).toBe("pro-upscaler");
    expect(payload.workflowOptions.save.cameraNumber).toBe("0012");
    expect(payload.targetFolderId).toBe("fld_1");
    // creativity is visible because enhancement defaults on; engine and upscale too.
    expect(Object.keys(payload.workflowOptions.stillImage.settings).sort()).toEqual([
      "creativity",
      "engine",
      "enhancement",
      "upscale",
    ]);
    expect(onJobCreated).toHaveBeenCalledWith({ id: "job_1" });
  });

  it("drops settings the preset currently hides", async () => {
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "pro-upscaler",
        categoryState: {
          ...state["pro-upscaler"],
          images: [image("a")],
          settings: { ...state["pro-upscaler"].settings, enhancement: false },
        },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    const settings = createBackendJob.mock.calls[0][0].workflowOptions.stillImage.settings;
    expect(settings).not.toHaveProperty("creativity");
    expect(settings.enhancement).toBe(false);
  });

  it("sends a seed only when one was asked for", async () => {
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "pro-upscaler",
        categoryState: { ...state["pro-upscaler"], images: [image("a")], seed: "4242" },
        targetFolderId: "",
        saveNumber: "0000",
      });
      // An empty field means a new render, not a repeat: the server mints a seed
      // and records it on the job.
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "pro-upscaler",
        categoryState: { ...state["pro-upscaler"], images: [image("a")], seed: "" },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    expect(createBackendJob.mock.calls[0][0].workflowOptions.stillImage.seed).toBe(4242);
    expect(createBackendJob.mock.calls[1][0].workflowOptions.stillImage.seed).toBeUndefined();
  });

  it("omits the prompt for a preset that has no prompt field", async () => {
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "reference-generator",
        categoryState: { ...state["reference-generator"], images: [image("a"), image("b")], prompt: "ignored" },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    expect(createBackendJob.mock.calls[0][0].prompt).toBeUndefined();
  });

  it("sends the prompt for a preset that takes one", async () => {
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "general-enhancement",
        categoryState: { ...state["general-enhancement"], images: [image("a")], prompt: "  keep the brick  " },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    expect(createBackendJob.mock.calls[0][0].prompt).toBe("keep the brick");
  });

  it("uploads every slot to project media before submitting", async () => {
    // The backend materializer only accepts saved media or data URLs; a blob: URL
    // from the browser would be rejected.
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "qwen-edit",
        categoryState: {
          ...state["qwen-edit"],
          images: [image("a"), image("b"), image("c")],
          settings: { ...state["qwen-edit"].settings, mode: "edit", imageCount: "3" },
        },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    expect(uploadJobMediaUrl).toHaveBeenCalledTimes(3);
    const inputImages = createBackendJob.mock.calls[0][0].inputImages;
    expect(inputImages).toHaveLength(3);
    for (const url of inputImages) expect(url).toMatch(/^\/api\/media\?path=/);
  });

  it("refuses to submit when a slot is empty", async () => {
    const { hook, onError } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "reference-generator",
        categoryState: { ...state["reference-generator"], images: [image("a")] },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    expect(createBackendJob).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("This workflow needs 2 input images.");
  });

  it("refuses to submit with no project selected", async () => {
    const { hook, onError } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "",
        categoryId: "pro-upscaler",
        categoryState: { ...state["pro-upscaler"], images: [image("a")] },
        targetFolderId: "",
        saveNumber: "0000",
      });
    });

    expect(createBackendJob).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Select a project before generating.");
  });

  it("reuses the client request id on retry so a replay is not a second render", async () => {
    const { hook } = setup();
    createBackendJob.mockRejectedValueOnce(new Error("network down"));

    const args = {
      projectId: "prj_1",
      categoryId: "pro-upscaler" as const,
      categoryState: { ...state["pro-upscaler"], images: [image("a")] },
      targetFolderId: "",
      saveNumber: "0000",
    };

    await act(async () => {
      await hook.result.current.submit(args);
    });
    await act(async () => {
      await hook.result.current.submit(args);
    });

    expect(createBackendJob).toHaveBeenCalledTimes(2);
    const first = createBackendJob.mock.calls[0][0].clientRequestId;
    const second = createBackendJob.mock.calls[1][0].clientRequestId;
    expect(second).toBe(first);
    expect(String(first).length).toBeGreaterThanOrEqual(16);
  });

  it("surfaces a server error instead of throwing", async () => {
    const { hook, onError } = setup();
    createBackendJob.mockRejectedValue(new Error("Project editor access required."));

    await act(async () => {
      const result = await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "pro-upscaler",
        categoryState: { ...state["pro-upscaler"], images: [image("a")] },
        targetFolderId: "",
        saveNumber: "0000",
      });
      expect(result.ok).toBe(false);
    });

    expect(onError).toHaveBeenCalledWith("Project editor access required.");
    expect(hook.result.current.error).toBe("Project editor access required.");
  });
});

describe("stillImageModelId", () => {
  it("matches the backend convention", () => {
    // Mirrored in backend/src/stillImageModels.ts; the server rejects a mismatch.
    expect(stillImageModelId("general-enhancement")).toBe("still_general-enhancement");
    expect(stillImageModelId("pro-upscaler")).toBe("still_pro-upscaler");
    expect(stillImageModelId("reference-generator")).toBe("still_reference-generator");
    expect(stillImageModelId("qwen-edit")).toBe("still_qwen-edit");
  });
});
