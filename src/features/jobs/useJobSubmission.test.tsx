import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../../services/backendApi";
import type { Job, ModelType, Project, UploadedImage } from "../../types";
import { useJobSubmission } from "./useJobSubmission";

const showToast = vi.fn();

const account: AuthUser = {
  id: "usr_artist",
  name: "Artist",
  email: "artist@example.test",
  role: "user",
  active: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  pinnedProjectIds: [],
};

const project: Project = {
  id: "proj_test",
  name: "Test Project",
  shortName: "TEST",
  ownerId: account.id,
  members: [],
  groupMembers: [],
  jobCount: 0,
  memberCount: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  visibility: "private",
};

type HarnessOverrides = {
  account?: AuthUser | null;
  projectId?: string;
  disabledReason?: string;
  backendAvailable?: boolean;
  images?: UploadedImage[];
  requiredImages?: number;
  selectedModel?: Partial<ModelType>;
};

function useSubmissionHarness(overrides: HarnessOverrides = {}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projects, setProjects] = useState([project]);
  const [backendAvailable, setBackendAvailable] = useState(overrides.backendAvailable ?? false);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const selectedProjectId = overrides.projectId ?? project.id;
  const submission = useJobSubmission({
    account: overrides.account === undefined ? account : overrides.account,
    backendAvailable,
    setBackendAvailable,
    selectedProjectId,
    selectedProject: selectedProjectId === project.id ? projects[0] : undefined,
    targetFolderId: "",
    selectedModel: {
      id: "text_to_image",
      label: "Text to Image",
      description: "test",
      category: "image",
      cost: 3,
      estimatedTime: "test",
      ...overrides.selectedModel,
    },
    disabledReason: overrides.disabledReason,
    prompt: "glass tower at dusk",
    selectedResolution: "1080p",
    selectedDurationSeconds: 8,
    images: overrides.images ?? [],
    requiredImages: overrides.requiredImages ?? 0,
    use16By9Cropping: false,
    archVizGridOptions: { slotCount: "1", useSmartDefaults: true, cameraSlots: [] },
    saveNumber: "0001",
    imageOutputCount: 1,
    selectedNanoBananaAspectRatio: "1:1",
    setJobs,
    setProjects,
    setBackendJobsTotal: setTotal,
    setBackendJobsOffset: setOffset,
    showToast,
  });
  return { ...submission, jobs, projects, backendAvailable, total, offset };
}

beforeEach(() => showToast.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("useJobSubmission", () => {
  it("blocks anonymous submission without creating a job", async () => {
    const { result } = renderHook(() => useSubmissionHarness({ account: null }));
    await act(() => result.current.handleGenerate());
    expect(result.current.jobs).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith("Sign in before generating.", "error");
  });

  it("surfaces form validation before submission", async () => {
    const { result } = renderHook(() => useSubmissionHarness({ disabledReason: "Add a prompt." }));
    await act(() => result.current.handleGenerate());
    expect(result.current.jobs).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith("Add a prompt.", "error");
  });

  it("requires a concrete project", async () => {
    const { result } = renderHook(() => useSubmissionHarness({ projectId: "all" }));
    await act(() => result.current.handleGenerate());
    expect(result.current.jobs).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith("Please select a specific project before generating.", "error");
  });

  it("creates an offline preview and updates the project count", async () => {
    const { result } = renderHook(() => useSubmissionHarness());
    await act(() => result.current.handleGenerate());
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0]).toMatchObject({ projectId: project.id, prompt: "glass tower at dusk", status: "queued" });
    expect(result.current.projects[0].jobCount).toBe(1);
    expect(result.current.backendAvailable).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Local preview job created.");
  });

  it("does not mark the backend offline when the browser cannot read selected media", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { result } = renderHook(() =>
      useSubmissionHarness({
        backendAvailable: true,
        images: [{ id: "img_1", name: "tower.png", url: "blob:tower" }],
        requiredImages: 1,
        selectedModel: { backendCategory: "image_editing", requiresImage: true, imageSlotCount: 1 },
      }),
    );

    await act(() => result.current.handleGenerate());

    expect(result.current.backendAvailable).toBe(true);
    expect(result.current.jobs).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith("Could not read the selected image. Reselect it and try again.", "error");
  });

  it("marks the backend offline only for a network failure during job creation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { result } = renderHook(() =>
      useSubmissionHarness({ backendAvailable: true, selectedModel: { backendCategory: "text_to_image" } }),
    );

    await act(() => result.current.handleGenerate());

    expect(result.current.backendAvailable).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      "The connection was lost while creating the job. Select Retry safely; the same request key prevents a duplicate job.",
      "error",
    );
    expect(result.current.hasRecoverableSubmission).toBe(true);
  });

  it("keeps the backend online when job creation returns a handled HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, { error: "Project editor access required." })));
    const { result } = renderHook(() =>
      useSubmissionHarness({ backendAvailable: true, selectedModel: { backendCategory: "text_to_image" } }),
    );

    await act(() => result.current.handleGenerate());

    expect(result.current.backendAvailable).toBe(true);
    expect(showToast).toHaveBeenCalledWith("Project editor access required.", "error");
  });

  it("restores backend availability after a successful submission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, { job: backendJob() })));
    const { result } = renderHook(() =>
      useSubmissionHarness({ backendAvailable: false, selectedModel: { backendCategory: "text_to_image" } }),
    );

    await act(() => result.current.handleGenerate());

    expect(result.current.backendAvailable).toBe(true);
    expect(result.current.jobs).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith("Job sent to RunPod serverless.");
  });

  it("reuses the same request id after an uncertain response and recovers the existing job", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        attempt += 1;
        if (attempt === 1) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve(jsonResponse(200, { job: backendJob(), replayed: true }));
      }),
    );
    const { result } = renderHook(() =>
      useSubmissionHarness({ backendAvailable: true, selectedModel: { backendCategory: "text_to_image" } }),
    );

    await act(() => result.current.handleGenerate());
    expect(result.current.hasRecoverableSubmission).toBe(true);
    await act(() => result.current.handleGenerate());

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0].clientRequestId).toMatch(/^req_/);
    expect(requestBodies[1].clientRequestId).toBe(requestBodies[0].clientRequestId);
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.total).toBe(0);
    expect(result.current.hasRecoverableSubmission).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith("Existing queued job recovered. No duplicate was created.");
  });

  it("cancels an uncertain creation without marking the backend offline and offers safe recovery", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requestStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true });
        });
      }),
    );
    const { result } = renderHook(() =>
      useSubmissionHarness({ backendAvailable: true, selectedModel: { backendCategory: "text_to_image" } }),
    );

    await act(async () => {
      const submission = result.current.handleGenerate();
      await started;
      result.current.cancelSubmission();
      await submission;
    });

    expect(result.current.backendAvailable).toBe(true);
    expect(result.current.hasRecoverableSubmission).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      "Submission check canceled. Select Retry safely to recover the existing job or create it once.",
      "info",
    );
  });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? "Created" : "Error",
    json: async () => body,
  } as Response;
}

function backendJob() {
  return {
    id: "job_backend",
    projectId: project.id,
    userId: account.id,
    modelId: "text_to_image",
    modelName: "Text to Image",
    category: "image",
    inputType: "text_only",
    prompt: "glass tower at dusk",
    status: "queued",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "image",
    createdAt: "2026-08-05T00:00:00.000Z",
  };
}
