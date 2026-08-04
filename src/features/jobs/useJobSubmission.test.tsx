import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../../services/backendApi";
import type { Job, Project } from "../../types";
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

function useSubmissionHarness(overrides: { account?: AuthUser | null; projectId?: string; disabledReason?: string } = {}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projects, setProjects] = useState([project]);
  const [backendAvailable, setBackendAvailable] = useState(false);
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
    },
    disabledReason: overrides.disabledReason,
    prompt: "glass tower at dusk",
    selectedResolution: "1080p",
    selectedDurationSeconds: 8,
    images: [],
    requiredImages: 0,
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
});
