import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();

vi.mock("./client", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  apiUpload: vi.fn(),
}));

const { fetchBackendJobs } = await import("./jobsApi");

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
