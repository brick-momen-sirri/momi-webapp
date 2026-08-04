// useJobActions owns the optimistic updates in the job feed: move, archive,
// restore and permanent delete all change the list before the backend confirms.
// The rollback path is what these tests focus on -- if a failed request does not
// put the job and the pagination counters back, the feed silently disagrees with
// the server until the next poll, and a user can be looking at a result that was
// never actually moved.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, Project } from "../../types";
import {
  archiveBackendJob,
  moveBackendJobResult,
  permanentlyDeleteBackendJob,
  restoreBackendJob,
  retryBackendJob,
  updateBackendJobSaveNumber,
} from "../../services/backendApi";
import { useJobActions } from "./useJobActions";

vi.mock("../../services/backendApi", () => ({
  archiveBackendJob: vi.fn(),
  moveBackendJobResult: vi.fn(),
  permanentlyDeleteBackendJob: vi.fn(),
  restoreBackendJob: vi.fn(),
  retryBackendJob: vi.fn(),
  updateBackendJobSaveNumber: vi.fn(),
}));

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Veo 3",
    inputType: "single_image",
    prompt: "a shot",
    resolution: "1080p",
    status: "completed",
    inputImages: [],
    folderId: null,
    ...overrides,
  } as Job;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    name: "Glass Tower",
    folders: [{ folderId: "fld_1", name: "Interiors", archived: false }],
    ...overrides,
  } as unknown as Project;
}

/** Renders the hook with spyable state setters and a captured toast log. */
function setup(overrides: Record<string, unknown> = {}) {
  const toasts: Array<{ message: string; type?: string }> = [];
  const state = {
    jobs: [job()] as Job[],
    total: 10,
    offset: 10,
    confirm: null as unknown,
  };

  const options = {
    backendAvailable: true,
    projects: [project()],
    jobs: state.jobs,
    setJobs: vi.fn((update: Job[] | ((current: Job[]) => Job[])) => {
      state.jobs = typeof update === "function" ? update(state.jobs) : update;
    }),
    selectedFolderId: "all",
    setBackendJobsTotal: vi.fn((update: number | ((current: number) => number)) => {
      state.total = typeof update === "function" ? update(state.total) : update;
    }),
    setBackendJobsOffset: vi.fn((update: number | ((current: number) => number)) => {
      state.offset = typeof update === "function" ? update(state.offset) : update;
    }),
    setConfirmDialog: vi.fn((value: unknown) => {
      state.confirm = typeof value === "function" ? (value as (c: unknown) => unknown)(state.confirm) : value;
    }),
    showToast: vi.fn((message: string, type?: string) => toasts.push({ message, type })),
    ...overrides,
  };

  const rendered = renderHook(() => useJobActions(options as never));
  return { ...rendered, options, state, toasts };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("favorites", () => {
  it("adds and removes a favorite", async () => {
    const { result } = setup();

    act(() => result.current.handleToggleFavorite(job()));
    expect(result.current.favoriteJobIds.has("job_1")).toBe(true);

    act(() => result.current.handleToggleFavorite(job()));
    expect(result.current.favoriteJobIds.has("job_1")).toBe(false);
  });

  it("persists favorites so they survive a reload", async () => {
    const { result } = setup();
    act(() => result.current.handleToggleFavorite(job()));

    // Written through to storage, not just held in memory.
    await waitFor(() => expect(JSON.stringify(window.localStorage)).toContain("job_1"));
  });
});

describe("retry", () => {
  it("refuses to retry while the backend is disconnected", async () => {
    const { result, toasts } = setup({ backendAvailable: false });

    await act(async () => void (await result.current.handleRetryJob(job())));

    expect(retryBackendJob).not.toHaveBeenCalled();
    expect(toasts[0]).toMatchObject({ type: "error" });
  });

  it("adds the requeued job and grows the counters", async () => {
    vi.mocked(retryBackendJob).mockResolvedValue(job({ id: "job_2" }));
    const { result, state } = setup();

    await act(async () => void (await result.current.handleRetryJob(job())));

    expect(state.jobs.some((item) => item.id === "job_2")).toBe(true);
    expect(state.total).toBe(11);
    expect(state.offset).toBe(11);
  });

  it("reports a failed retry without touching the counters", async () => {
    vi.mocked(retryBackendJob).mockRejectedValue(new Error("Queue is paused."));
    const { result, state, toasts } = setup();

    await act(async () => void (await result.current.handleRetryJob(job())));

    expect(toasts.at(-1)).toMatchObject({ message: "Queue is paused.", type: "error" });
    expect(state.total).toBe(10);
  });
});

describe("moving a result", () => {
  it("refuses when the job's project is unknown", async () => {
    const { result, toasts } = setup({ projects: [] });

    const moved = await act(async () => result.current.handleMoveJobResult(job(), "fld_1"));

    expect(moved).toBe(false);
    expect(moveBackendJobResult).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toMatchObject({ message: "Project not found.", type: "error" });
  });

  it("refuses an unknown destination folder", async () => {
    const { result, toasts } = setup();

    const moved = await act(async () => result.current.handleMoveJobResult(job(), "fld_missing"));

    expect(moved).toBe(false);
    expect(moveBackendJobResult).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toMatchObject({ message: "Destination folder not found.", type: "error" });
  });

  it("refuses an archived destination folder", async () => {
    // Moving into an archived folder would file the result somewhere the UI
    // no longer shows.
    const archived = project({ folders: [{ folderId: "fld_1", name: "Interiors", archived: true }] } as never);
    const { result, toasts } = setup({ projects: [archived] });

    const moved = await act(async () => result.current.handleMoveJobResult(job(), "fld_1"));

    expect(moved).toBe(false);
    expect(toasts.at(-1)).toMatchObject({ message: "Destination folder not found.", type: "error" });
  });

  it("moves to the project root when given no folder", async () => {
    vi.mocked(moveBackendJobResult).mockResolvedValue(job({ folderId: null }));
    const { result, toasts } = setup();

    const moved = await act(async () => result.current.handleMoveJobResult(job(), null));

    expect(moved).toBe(true);
    expect(toasts.at(-1)?.message).toMatch(/project root/i);
  });

  it("restores the job when the move fails", async () => {
    vi.mocked(moveBackendJobResult).mockRejectedValue(new Error("Disk is full."));
    const { result, state, toasts } = setup();

    const moved = await act(async () => result.current.handleMoveJobResult(job(), "fld_1"));

    expect(moved).toBe(false);
    // Rolled back to the original folder rather than left showing the optimistic one.
    expect(state.jobs[0].folderId).toBeNull();
    expect(toasts.at(-1)).toMatchObject({ message: "Disk is full.", type: "error" });
  });

  it("puts the pagination counters back when a move out of the open folder fails", async () => {
    vi.mocked(moveBackendJobResult).mockRejectedValue(new Error("nope"));
    const { result, state } = setup({
      selectedFolderId: "fld_1",
      jobs: [job({ folderId: "fld_1" })],
      projects: [project({ folders: [{ folderId: "fld_1", name: "Interiors", archived: false }] } as never)],
    });

    await act(async () => result.current.handleMoveJobResult(job({ folderId: "fld_1" }), null));

    // Decremented optimistically because the job was leaving the open folder, so a
    // failure has to add it back or the "load more" maths drifts.
    expect(state.total).toBe(10);
    expect(state.offset).toBe(10);
  });
});

describe("archiving and restoring", () => {
  it("removes the job optimistically and confirms", async () => {
    vi.mocked(archiveBackendJob).mockResolvedValue(undefined as never);
    const { result, state, toasts } = setup();

    await act(async () => void (await result.current.handleArchiveJob(job())));

    expect(state.jobs).toHaveLength(0);
    expect(state.total).toBe(9);
    expect(toasts.at(-1)?.message).toMatch(/archive/i);
  });

  it("puts the job back when archiving fails", async () => {
    vi.mocked(archiveBackendJob).mockRejectedValue(new Error("Archive store is locked."));
    const { result, state, toasts } = setup();

    await act(async () => void (await result.current.handleArchiveJob(job())));

    expect(state.jobs.map((item) => item.id)).toEqual(["job_1"]);
    expect(state.total).toBe(10);
    expect(toasts.at(-1)).toMatchObject({ message: "Archive store is locked.", type: "error" });
  });

  it("uses the restore wording on the restore path", async () => {
    vi.mocked(restoreBackendJob).mockResolvedValue(undefined as never);
    const { result, toasts } = setup();

    await act(async () => void (await result.current.handleRestoreArchivedJob(job())));

    expect(restoreBackendJob).toHaveBeenCalledWith("job_1");
    expect(toasts.at(-1)?.message).toMatch(/restored/i);
  });

  it("skips the request entirely while offline but still updates the feed", async () => {
    const { result, state } = setup({ backendAvailable: false });

    await act(async () => void (await result.current.handleArchiveJob(job())));

    expect(archiveBackendJob).not.toHaveBeenCalled();
    expect(state.jobs).toHaveLength(0);
  });
});

describe("permanent delete", () => {
  it("asks for confirmation instead of deleting straight away", () => {
    const { result, options } = setup();

    act(() => result.current.handlePermanentlyDeleteJob(job()));

    expect(permanentlyDeleteBackendJob).not.toHaveBeenCalled();
    expect(options.setConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "danger", confirmLabel: "Delete permanently" }),
    );
  });

  it("deletes once the confirmation is accepted", async () => {
    vi.mocked(permanentlyDeleteBackendJob).mockResolvedValue(undefined as never);
    const { result, state } = setup();

    act(() => result.current.handlePermanentlyDeleteJob(job()));
    const dialog = state.confirm as { onConfirm: () => void };
    await act(async () => {
      dialog.onConfirm();
    });

    await waitFor(() => expect(permanentlyDeleteBackendJob).toHaveBeenCalledWith("job_1"));
    expect(state.jobs).toHaveLength(0);
  });
});

describe("editing the shot/camera number", () => {
  it("rejects a blank value without calling the backend", async () => {
    const { result, toasts } = setup();

    await act(async () => void (await result.current.handleUpdateJobSaveNumber(job(), "   ")));

    expect(updateBackendJobSaveNumber).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toMatchObject({ type: "error" });
  });

  it("sends the normalized number and applies the result", async () => {
    vi.mocked(updateBackendJobSaveNumber).mockResolvedValue({
      workflowOptions: { save: { cameraNumber: "0012" } },
    } as never);
    const { result, state } = setup();

    await act(async () => void (await result.current.handleUpdateJobSaveNumber(job(), "12")));

    expect(updateBackendJobSaveNumber).toHaveBeenCalledWith("prj_1", "job_1", "0012");
    expect(state.jobs[0].workflowOptions?.save?.cameraNumber).toBe("0012");
  });

  it("surfaces a rejected update", async () => {
    vi.mocked(updateBackendJobSaveNumber).mockRejectedValue(new Error("Number already used."));
    const { result, toasts } = setup();

    await act(async () => void (await result.current.handleUpdateJobSaveNumber(job(), "12")));

    expect(toasts.at(-1)).toMatchObject({ message: "Number already used.", type: "error" });
  });
});

describe("download choice", () => {
  it("opens the format choice for an image result instead of downloading blind", async () => {
    const { result } = setup();

    await act(async () => void (await result.current.handleDownloadJobResult(job({ outputType: "image" }))));

    expect(result.current.downloadChoiceJob?.id).toBe("job_1");
  });

  it("closes the format choice", async () => {
    const { result } = setup();
    await act(async () => void (await result.current.handleDownloadJobResult(job({ outputType: "image" }))));

    act(() => result.current.closeDownloadChoice());
    expect(result.current.downloadChoiceJob).toBeNull();
  });
});
