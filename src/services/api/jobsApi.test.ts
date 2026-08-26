import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();

vi.mock("./client", () => ({
  API_BASE: "",
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  apiUpload: vi.fn(),
}));

const { fetchBackendJob, fetchBackendJobs, finalizeBackendStillImageEdit } = await import("./jobsApi");

// The query string is the whole contract with GET /api/jobs. A parameter that is
// silently dropped reads to a user as "my filter does nothing".

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ jobs: [], total: 0, limit: 80, offset: 0, hasMore: false });
});

describe("fetchBackendJobs", () => {
  it("forwards the section filter", async () => {
    await fetchBackendJobs({ section: "still_images" });
    expect(apiRequest).toHaveBeenCalledWith("/api/jobs?section=still_images");
  });

  it("forwards section alongside the other filters", async () => {
    await fetchBackendJobs({ projectId: "prj_1", section: "animation", limit: 20 });
    const url = String(apiRequest.mock.calls[0][0]);
    expect(url).toContain("projectId=prj_1");
    expect(url).toContain("section=animation");
    expect(url).toContain("limit=20");
  });

  it("omits the section when unset, so both workspaces are returned", async () => {
    await fetchBackendJobs({ projectId: "prj_1" });
    expect(String(apiRequest.mock.calls[0][0])).not.toContain("section");
  });
});

describe("fetchBackendJob", () => {
  it("tracks the exact submitted job and forwards cancellation", async () => {
    apiRequest.mockResolvedValue({
      job: {
        id: "job_inpaint",
        projectId: "project_1",
        userId: "user_1",
        modelId: "still_image-editing",
        modelName: "Image Editing",
        category: "image_editing",
        inputType: "single_image",
        status: "running",
        inputImages: [],
        resultUrls: [],
        thumbnailUrls: [],
        outputType: "image",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    });
    const controller = new AbortController();

    const job = await fetchBackendJob("job_inpaint", { signal: controller.signal });

    expect(job).toMatchObject({ id: "job_inpaint", status: "running" });
    expect(apiRequest).toHaveBeenCalledWith("/api/jobs/job_inpaint", { signal: controller.signal });
  });
});

describe("finalizeBackendStillImageEdit", () => {
  it("posts the ordered layer stack and maps the completed job", async () => {
    apiRequest.mockResolvedValue({
      job: {
        id: "job_final",
        projectId: "project_1",
        userId: "user_1",
        modelId: "still_image-editing",
        modelName: "Current Composite & Mask",
        category: "image_editing",
        inputType: "single_image",
        status: "completed",
        inputImages: ["/api/media?path=original.png"],
        resultUrls: ["/api/media?path=final.png"],
        thumbnailUrls: [],
        outputType: "image",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    });
    const payload = {
      projectId: "project_1",
      documentId: "editdoc_1",
      originalSourceUrl: "/api/media?path=original.png",
      saveNumber: "0001",
      layers: [
        {
          layerId: "layer_1",
          crop: { x: 0, y: 0, size: 100, sourceWidth: 100, sourceHeight: 100 },
          generatedCropUrl: "/api/media?path=crop.png",
          maskSourceUrl: "/api/media?path=mask.png",
        },
      ],
    };

    const job = await finalizeBackendStillImageEdit(payload);

    expect(job.id).toBe("job_final");
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/still-image-edits/finalize",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
  });
});
