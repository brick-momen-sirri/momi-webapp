// JobFeed's filtering is the busiest logic in the frontend: status, scope,
// output type, free-text search and sort all narrow the same list, and an artist
// concluding "my render isn't there" because a filter silently dropped it is a
// support conversation, not a visible crash.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Job, Project, User } from "../types";
import { JobFeed } from "./JobFeed";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "proj_1",
    userId: "usr_momen",
    modelType: "Nano Banana",
    inputType: "single_image",
    prompt: "a glass tower at dusk",
    resolution: "2K",
    status: "completed",
    inputImages: [],
    outputType: "image",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as Job;
}

const projects: Project[] = [{ id: "proj_1", name: "Tower", shortName: "TWR", members: [] } as unknown as Project];
const users: User[] = [{ id: "usr_momen", name: "momen" } as User, { id: "usr_other", name: "someone else" } as User];

function renderFeed(jobs: Job[], overrides: Record<string, unknown> = {}) {
  const props = {
    jobs,
    projects,
    users,
    currentUserId: "usr_momen",
    currentUserRole: "admin" as const,
    selectedProjectId: "all",
    selectedFolderId: "all" as const,
    archiveView: false,
    favoriteJobIds: new Set<string>(),
    onDownload: vi.fn(),
    onCopyImage: vi.fn(),
    onReuseSettings: vi.fn(),
    onRetry: vi.fn(),
    canReuseSettings: () => true,
    onToggleFavorite: vi.fn(),
    onMove: vi.fn().mockResolvedValue(true),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDeletePermanently: vi.fn(),
    onUpdateJobSaveNumber: vi.fn(),
    onToggleArchiveView: vi.fn(),
    ...overrides,
  };
  return { ...render(<JobFeed {...props} />), props };
}

// Prompts are the most reliable per-job text in the rendered card.
function visiblePrompts(prompts: string[]) {
  return prompts.filter((prompt) => screen.queryByText(prompt, { exact: false }) !== null);
}

describe("rendering", () => {
  it("lists the jobs it is given", () => {
    renderFeed([job({ id: "a", prompt: "first prompt" }), job({ id: "b", prompt: "second prompt" })]);
    expect(screen.getByText(/first prompt/)).toBeInTheDocument();
    expect(screen.getByText(/second prompt/)).toBeInTheDocument();
  });

  it("renders without crashing on an empty list", () => {
    expect(() => renderFeed([])).not.toThrow();
  });
});

// NOT COVERED YET: the status / scope / output filters live in a collapsible
// panel with a staged Reset+Apply flow, so exercising them needs a helper that
// opens the panel, changes a control and applies. That is worth doing and is
// called out in the README's testing gap list rather than faked here.

describe("search", () => {
  it("matches on the prompt text", async () => {
    const user = userEvent.setup();
    renderFeed([job({ id: "a", prompt: "glass tower" }), job({ id: "b", prompt: "timber cabin" })]);

    await user.type(screen.getByPlaceholderText(/search/i), "timber");
    expect(visiblePrompts(["glass tower", "timber cabin"])).toEqual(["timber cabin"]);
  });

  it("is case-insensitive", async () => {
    const user = userEvent.setup();
    renderFeed([job({ id: "a", prompt: "glass tower" }), job({ id: "b", prompt: "timber cabin" })]);

    await user.type(screen.getByPlaceholderText(/search/i), "TIMBER");
    expect(visiblePrompts(["glass tower", "timber cabin"])).toEqual(["timber cabin"]);
  });

  it("shows nothing rather than everything when a search matches no job", async () => {
    const user = userEvent.setup();
    renderFeed([job({ id: "a", prompt: "glass tower" })]);

    await user.type(screen.getByPlaceholderText(/search/i), "zzzznomatch");
    // The failure mode worth pinning: a filter that matches nothing must not fall
    // back to the unfiltered list.
    expect(visiblePrompts(["glass tower"])).toEqual([]);
  });
});

describe("pagination controls", () => {
  it("asks for more jobs when there are more to load", async () => {
    const user = userEvent.setup();
    const onLoadMoreJobs = vi.fn();
    renderFeed([job()], { hasMoreJobs: true, totalJobs: 50, onLoadMoreJobs });

    const button = screen.getByRole("button", { name: /load more|show more/i });
    await user.click(button);
    expect(onLoadMoreJobs).toHaveBeenCalledOnce();
  });

  it("offers no load-more control when the list is complete", () => {
    renderFeed([job()], { hasMoreJobs: false, totalJobs: 1 });
    expect(screen.queryByRole("button", { name: /load more|show more/i })).toBeNull();
  });
});

describe("archive view", () => {
  it("toggling the archive view is delegated to the parent, not decided locally", async () => {
    const user = userEvent.setup();
    const onToggleArchiveView = vi.fn();
    renderFeed([job()], { onToggleArchiveView });

    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(onToggleArchiveView).toHaveBeenCalledOnce();
  });
});

describe("job actions", () => {
  it("passes the job through to the retry handler", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const failed = job({ id: "a", prompt: "broken job", status: "failed" });
    renderFeed([failed], { onRetry });

    const retry = screen.getByRole("button", { name: "Retry" });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
});
