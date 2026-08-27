import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { stillImageModelId } from "./stillImageModelId";
import { createInitialStillImagesState } from "./stillImageCategories";
import { stillImageSubmissionCount, useStillImagesSubmission } from "./useStillImagesSubmission";
import type { UploadedImage } from "../../types";

const createBackendJob = vi.fn();
const fetchBackendJob = vi.fn();
const uploadBackendMedia = vi.fn();
const uploadJobMediaUrl = vi.fn();

vi.mock("../../services/backendApi", () => ({
  createBackendJob: (...args: unknown[]) => createBackendJob(...args),
  fetchBackendJob: (...args: unknown[]) => fetchBackendJob(...args),
  uploadBackendMedia: (...args: unknown[]) => uploadBackendMedia(...args),
}));

vi.mock("../generation/generationUtils", () => ({
  uploadJobMediaUrl: (...args: unknown[]) => uploadJobMediaUrl(...args),
}));

vi.mock("./maskRaster", () => ({
  canvasToPngFile: async (_canvas: HTMLCanvasElement, name: string) => new File(["png"], name, { type: "image/png" }),
  currentMaskEditCrop: () => ({ x: 100, y: 50, size: 400, sourceWidth: 1200, sourceHeight: 800 }),
  loadImageElement: async () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "naturalWidth", { value: 1200 });
    Object.defineProperty(image, "naturalHeight", { value: 800 });
    return image;
  },
  maskHasCoverage: () => true,
  maskImageToAlphaCanvas: () => document.createElement("canvas"),
  renderEditCropCanvas: () => document.createElement("canvas"),
  renderGuideCanvas: () => document.createElement("canvas"),
  renderMaskCanvas: () => document.createElement("canvas"),
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
  fetchBackendJob.mockReset();
  uploadBackendMedia.mockReset();
  uploadJobMediaUrl.mockReset();
  createBackendJob.mockImplementation(async (payload) => ({
    job: {
      id: "job_1",
      status: "completed",
      prompt: payload.prompt ?? "",
      resultUrl: "/api/jobs/job_1/result-media?index=0",
      resultSourceUrls: ["/api/media?path=generated-crop.png"],
      workflowOptions: payload.workflowOptions?.stillImage?.edit
        ? {
            ...payload.workflowOptions,
            stillImage: {
              ...payload.workflowOptions.stillImage,
              edit: {
                ...payload.workflowOptions.stillImage.edit,
                generatedCropUrl: "/api/media?path=generated-crop.png",
              },
            },
          }
        : payload.workflowOptions,
    },
    replayed: false,
  }));
  fetchBackendJob.mockResolvedValue({ id: "job_1", status: "completed" });
  uploadBackendMedia.mockImplementation(async (file: File) => `/api/media?path=${file.name}`);
  uploadJobMediaUrl.mockImplementation(async (url: string) => `/api/media?path=${encodeURIComponent(url)}`);
});

function setup() {
  const onJobCreated = vi.fn();
  const onJobUpdated = vi.fn();
  const onEditJobCompleted = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useStillImagesSubmission({ onJobCreated, onJobUpdated, onEditJobCompleted, onError }));
  return { hook, onJobCreated, onJobUpdated, onEditJobCompleted, onError };
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
    expect(onJobCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "job_1" }));
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

  it("submits a masked Inpaint crop followed by reusable reference images", async () => {
    const { hook, onEditJobCompleted } = setup();
    const mask = {
      width: 1200,
      height: 800,
      softness: 35,
      strokes: [{ tool: "brush" as const, radius: 40, points: [{ x: 300, y: 250 }] }],
    };

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask,
          prompt: "replace the chair",
          editMode: "inpaint",
          editDocumentId: "editdoc_12345678",
          editReferences: [image("reference")],
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
    });

    const payload = createBackendJob.mock.calls[0][0];
    expect(payload.modelId).toBe(stillImageModelId("image-editing"));
    expect(payload.inputImages).toEqual([
      "/api/media?path=edit-source-crop.png",
      "/api/media?path=edit-mask-crop.png",
      "/api/media?path=edit-guide-crop.png",
      "/api/media?path=blob%3Areference",
    ]);
    expect(payload.workflowOptions.stillImage.edit).toMatchObject({
      mode: "inpaint",
      documentId: "editdoc_12345678",
      crop: { x: 100, y: 50, size: 400, sourceWidth: 1200, sourceHeight: 800 },
      mask,
      maskSourceUrl: "/api/media?path=edit-mask-crop.png",
      baseLayers: [],
      referenceSourceUrls: ["/api/media?path=blob%3Areference"],
    });
    expect(payload.prompt).toBe("replace the chair");
    expect(onEditJobCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: "job_1", status: "completed" }));
  });

  it("submits a rectangle selection without requiring a painted stroke", async () => {
    const { hook } = setup();
    const mask = {
      width: 1200,
      height: 800,
      softness: 35,
      cropMargin: 50,
      cropAspect: "16:9" as const,
      selection: { x: 200, y: 150, width: 320, height: 180 },
      strokes: [],
    };

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask,
          prompt: "replace the selected sign",
          editMode: "inpaint",
          editDocumentId: "editdoc_selection",
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
    });

    expect(createBackendJob).toHaveBeenCalledTimes(1);
    expect(createBackendJob.mock.calls[0][0].workflowOptions.stillImage.edit).toMatchObject({
      mask,
      crop: { x: 100, y: 50, size: 400 },
    });
  });

  it("stays processing until the exact submitted edit job returns its completed crop", async () => {
    const { hook, onJobUpdated, onEditJobCompleted } = setup();
    let submittedWorkflow: unknown;
    let resolveJob!: (job: unknown) => void;
    createBackendJob.mockImplementation(async (payload) => {
      submittedWorkflow = payload.workflowOptions;
      return {
        job: { id: "job_inpaint", status: "queued", prompt: payload.prompt, workflowOptions: payload.workflowOptions },
        replayed: false,
      };
    });
    fetchBackendJob.mockReturnValue(new Promise((resolve) => (resolveJob = resolve)));

    let submission!: Promise<unknown>;
    await act(async () => {
      submission = hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask: {
            width: 1200,
            height: 800,
            softness: 35,
            strokes: [{ tool: "brush", radius: 40, points: [{ x: 300, y: 250 }] }],
          },
          prompt: "replace the chair",
          editMode: "inpaint",
          editDocumentId: "editdoc_12345678",
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchBackendJob).toHaveBeenCalledWith("job_inpaint", expect.any(Object)));
    expect(hook.result.current).toMatchObject({ submitting: true, phase: "processing" });
    expect(onEditJobCompleted).not.toHaveBeenCalled();

    await act(async () => {
      resolveJob({
        id: "job_inpaint",
        status: "completed",
        prompt: "replace the chair",
        resultUrl: "/api/jobs/job_inpaint/result-media?index=0",
        resultSourceUrls: ["/api/media?path=generated-crop.png"],
        workflowOptions: {
          ...(submittedWorkflow as { stillImage: Record<string, unknown> }),
          stillImage: {
            ...(submittedWorkflow as { stillImage: { edit: Record<string, unknown> } }).stillImage,
            edit: {
              ...(submittedWorkflow as { stillImage: { edit: Record<string, unknown> } }).stillImage.edit,
              generatedCropUrl: "/api/media?path=generated-crop.png",
            },
          },
        },
      });
      await submission;
    });

    expect(onJobUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: "job_inpaint", status: "completed" }));
    expect(onEditJobCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: "job_inpaint", status: "completed" }));
    expect(hook.result.current.submitting).toBe(false);
    expect(hook.result.current.error).toBeUndefined();
  });

  it("recovers a completed crop when a rolling-deploy backend stripped the edit envelope", async () => {
    const { hook, onJobUpdated, onEditJobCompleted, onError } = setup();
    createBackendJob.mockImplementation(async (payload) => ({
      job: { id: "job_stale_api", status: "queued", prompt: payload.prompt, workflowOptions: payload.workflowOptions },
      replayed: false,
    }));
    fetchBackendJob.mockResolvedValue({
      id: "job_stale_api",
      status: "completed",
      prompt: "replace the chair",
      resultUrl: "/api/jobs/job_stale_api/result-media?index=0",
      resultSourceUrls: ["/api/media?path=raw-provider-crop.png"],
      workflowOptions: {
        stillImage: { categoryId: "image-editing", settings: { markRegion: true } },
      },
    });

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask: {
            width: 1200,
            height: 800,
            softness: 35,
            strokes: [{ tool: "brush", radius: 40, points: [{ x: 300, y: 250 }] }],
          },
          prompt: "replace the chair",
          editMode: "inpaint",
          editDocumentId: "editdoc_12345678",
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
    });

    expect(onEditJobCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job_stale_api",
        workflowOptions: expect.objectContaining({
          stillImage: expect.objectContaining({
            edit: expect.objectContaining({
              documentId: "editdoc_12345678",
              crop: { x: 100, y: 50, size: 400, sourceWidth: 1200, sourceHeight: 800 },
              generatedCropUrl: "/api/media?path=raw-provider-crop.png",
            }),
          }),
        }),
      }),
    );
    expect(onJobUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ id: "job_stale_api" }));
    expect(onError).not.toHaveBeenCalled();
    expect(hook.result.current.submitting).toBe(false);
  });

  it("shows an error and unlocks when a completed job has no usable output", async () => {
    const { hook, onEditJobCompleted, onError } = setup();
    createBackendJob.mockImplementation(async (payload) => ({
      job: { id: "job_empty", status: "queued", prompt: payload.prompt, workflowOptions: payload.workflowOptions },
      replayed: false,
    }));
    fetchBackendJob.mockResolvedValue({
      id: "job_empty",
      status: "completed",
      prompt: "replace the chair",
      resultUrls: [],
      resultSourceUrls: [],
      workflowOptions: { stillImage: { categoryId: "image-editing", settings: {} } },
    });

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask: {
            width: 1200,
            height: 800,
            softness: 35,
            strokes: [{ tool: "brush", radius: 40, points: [{ x: 300, y: 250 }] }],
          },
          prompt: "replace the chair",
          editMode: "inpaint",
          editDocumentId: "editdoc_12345678",
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
    });

    expect(onEditJobCompleted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/without a usable image or layer description/i));
    expect(hook.result.current).toMatchObject({
      submitting: false,
      error: expect.stringMatching(/without a usable image or layer description/i),
    });
  });

  it("unlocks a failed edit while preserving a retryable error", async () => {
    const { hook, onEditJobCompleted, onError } = setup();
    createBackendJob.mockImplementation(async (payload) => ({
      job: { id: "job_failed", status: "queued", prompt: payload.prompt, workflowOptions: payload.workflowOptions },
      replayed: false,
    }));
    fetchBackendJob.mockResolvedValue({ id: "job_failed", status: "failed", errorMessage: "Comfy ran out of memory." });

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask: {
            width: 1200,
            height: 800,
            softness: 35,
            strokes: [{ tool: "brush", radius: 40, points: [{ x: 300, y: 250 }] }],
          },
          prompt: "replace the chair",
          editMode: "inpaint",
          editDocumentId: "editdoc_12345678",
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
    });

    expect(onEditJobCompleted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Comfy ran out of memory.");
    expect(hook.result.current).toMatchObject({ submitting: false, error: "Comfy ran out of memory." });
  });

  it("routes Enhance through General Enhancement with source and mask slots", async () => {
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.submit({
        projectId: "prj_1",
        categoryId: "image-editing",
        categoryState: {
          ...state["image-editing"],
          images: [image("source")],
          mask: {
            width: 1200,
            height: 800,
            softness: 35,
            strokes: [{ tool: "brush", radius: 40, points: [{ x: 300, y: 250 }] }],
          },
          prompt: "increase material detail",
          editMode: "enhance",
          editDocumentId: "editdoc_12345678",
          // Kept in editor state when switching modes, but General Enhancement
          // has no reference-conditioning input and must not receive it.
          editReferences: [image("unused-reference")],
        },
        targetFolderId: "",
        saveNumber: "0001",
      });
    });

    const payload = createBackendJob.mock.calls[0][0];
    expect(payload.modelId).toBe(stillImageModelId("general-enhancement"));
    expect(payload.prompt).toBe("increase material detail");
    expect(payload.inputImages).toEqual(["/api/media?path=edit-source-crop.png", "/api/media?path=edit-mask-crop.png"]);
    expect(payload.workflowOptions.stillImage).toMatchObject({
      categoryId: "general-enhancement",
      edit: { mode: "enhance", referenceSourceUrls: [] },
    });
    expect(uploadJobMediaUrl).toHaveBeenCalledTimes(1);
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

describe("stillImageSubmissionCount", () => {
  it("allows variations for a new edit but replaces exactly one selected layer", () => {
    const imageEditing = {
      ...state["image-editing"],
      settings: { ...state["image-editing"].settings, variations: 4 },
    };

    expect(stillImageSubmissionCount("image-editing", imageEditing)).toBe(4);
    expect(stillImageSubmissionCount("image-editing", { ...imageEditing, activeEditLayerId: "edit_1" })).toBe(1);
  });
});
