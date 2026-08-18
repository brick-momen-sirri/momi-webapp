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
    onCancel: vi.fn(),
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
//
// Case-SENSITIVE substring matching, deliberately. RTL's `{ exact: false }` is
// also case-insensitive, which quietly matched the component's own control text:
// a job prompted "my job" counted as visible because the scope dropdown contains
// the option "Scope: My jobs". Tests then passed while asserting nothing, which is
// also why the fixtures below use prompts that cannot collide with control text.
function visiblePrompts(prompts: string[]) {
  return prompts.filter((prompt) => screen.queryAllByText((content) => content.includes(prompt)).length > 0);
}

// Prompts in the order the DOM actually renders them, for sort assertions.
function promptOrder(prompts: string[]) {
  const body = document.body.textContent ?? "";
  return prompts.filter((prompt) => body.includes(prompt)).sort((a, b) => body.indexOf(a) - body.indexOf(b));
}

// Status, model and sort are inline selects in the header. Scope, specific user,
// date and generation type live in the "Filters" popover. Filters apply on
// change: "Apply" only closes the popover, and "Reset" clears just the popover's
// own filters -- the distinction the Reset/Apply tests below pin down.
async function openFilterPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
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

describe("status filter", () => {
  it("narrows to the chosen status and back", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "done job", status: "completed" }),
      job({ id: "b", prompt: "broken job", status: "failed" }),
    ]);

    const status = screen.getByLabelText("Status filter");
    await user.selectOptions(status, "failed");
    expect(visiblePrompts(["done job", "broken job"])).toEqual(["broken job"]);

    await user.selectOptions(status, "all");
    expect(visiblePrompts(["done job", "broken job"])).toEqual(["done job", "broken job"]);
  });
});

describe("model filter", () => {
  it("narrows to one model", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "banana job", modelType: "Nano Banana" }),
      job({ id: "b", prompt: "kling job", modelType: "Kling Video 2.6" }),
    ]);

    await user.selectOptions(screen.getByLabelText("Model type filter"), "Kling Video 2.6");
    expect(visiblePrompts(["banana job", "kling job"])).toEqual(["kling job"]);
  });
});

describe("scope filter", () => {
  it("mine keeps only the current user's jobs", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "solo render", userId: "usr_momen" }),
      job({ id: "b", prompt: "other render", userId: "usr_other" }),
    ]);

    await openFilterPanel(user);
    await user.selectOptions(screen.getByLabelText("Scope"), "mine");
    expect(visiblePrompts(["solo render", "other render"])).toEqual(["solo render"]);
  });

  it("favorites keeps only jobs in the favorites set", async () => {
    const user = userEvent.setup();
    renderFeed([job({ id: "a", prompt: "starred job" }), job({ id: "b", prompt: "plain job" })], {
      favoriteJobIds: new Set(["a"]),
    });

    await openFilterPanel(user);
    await user.selectOptions(screen.getByLabelText("Scope"), "favorites");
    expect(visiblePrompts(["starred job", "plain job"])).toEqual(["starred job"]);
  });
});

describe("specific-user filter", () => {
  it("is offered to admins and narrows to that user", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "solo render", userId: "usr_momen" }),
      job({ id: "b", prompt: "other render", userId: "usr_other" }),
    ]);

    await openFilterPanel(user);
    await user.selectOptions(screen.getByLabelText("Specific user"), "usr_other");
    expect(visiblePrompts(["solo render", "other render"])).toEqual(["other render"]);
  });

  it("is not offered to a non-admin at all", async () => {
    const user = userEvent.setup();
    renderFeed([job()], { currentUserRole: "user" });

    await openFilterPanel(user);
    expect(screen.queryByLabelText("Specific user")).toBeNull();
  });

  it("never restricts a non-admin, since the predicate keys off role", async () => {
    const user = userEvent.setup();
    renderFeed(
      [
        job({ id: "a", prompt: "solo render", userId: "usr_momen" }),
        job({ id: "b", prompt: "other render", userId: "usr_other" }),
      ],
      { currentUserRole: "user" },
    );

    await openFilterPanel(user);
    expect(visiblePrompts(["solo render", "other render"])).toEqual(["solo render", "other render"]);
  });
});

describe("generation type filter", () => {
  it("splits video from image, counting sequences and videoLength as video", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "an image", outputType: "image" }),
      job({ id: "b", prompt: "a video", outputType: "video" }),
      job({ id: "c", prompt: "a sequence", outputType: "sequence" }),
      job({ id: "d", prompt: "a clip", outputType: undefined, videoLength: "5" }),
    ]);

    await openFilterPanel(user);
    const type = screen.getByLabelText("Generation type");

    await user.selectOptions(type, "video");
    expect(visiblePrompts(["an image", "a video", "a sequence", "a clip"])).toEqual(["a video", "a sequence", "a clip"]);

    await user.selectOptions(type, "image");
    expect(visiblePrompts(["an image", "a video", "a sequence", "a clip"])).toEqual(["an image"]);
  });
});

describe("sort", () => {
  it("flips newest-first to oldest-first", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "older job", createdAt: "2026-08-01T10:00:00.000Z" }),
      job({ id: "b", prompt: "newer job", createdAt: "2026-08-02T10:00:00.000Z" }),
    ]);

    expect(promptOrder(["older job", "newer job"])).toEqual(["newer job", "older job"]);

    await user.selectOptions(screen.getByLabelText("Sort jobs"), "oldest");
    expect(promptOrder(["older job", "newer job"])).toEqual(["older job", "newer job"]);
  });
});

describe("popover Reset and Apply", () => {
  it("Reset clears the popover filters but leaves the inline status filter alone", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "mine failed", userId: "usr_momen", status: "failed" }),
      job({ id: "b", prompt: "theirs failed", userId: "usr_other", status: "failed" }),
      job({ id: "c", prompt: "theirs done", userId: "usr_other", status: "completed" }),
    ]);

    await user.selectOptions(screen.getByLabelText("Status filter"), "failed");
    await openFilterPanel(user);
    await user.selectOptions(screen.getByLabelText("Scope"), "mine");
    expect(visiblePrompts(["mine failed", "theirs failed", "theirs done"])).toEqual(["mine failed"]);

    await user.click(screen.getByRole("button", { name: "Reset" }));
    // Scope is cleared, so both failed jobs return -- but the completed one must
    // stay hidden, because Reset is scoped to the popover's own filters.
    expect(visiblePrompts(["mine failed", "theirs failed", "theirs done"])).toEqual(["mine failed", "theirs failed"]);
  });

  it("Apply closes the popover and keeps the filter applied", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "solo render", userId: "usr_momen" }),
      job({ id: "b", prompt: "other render", userId: "usr_other" }),
    ]);

    await openFilterPanel(user);
    await user.selectOptions(screen.getByLabelText("Scope"), "mine");
    await user.click(screen.getByRole("button", { name: /Apply/ }));

    expect(screen.queryByLabelText("Scope")).toBeNull();
    expect(visiblePrompts(["solo render", "other render"])).toEqual(["solo render"]);
  });
});

describe("combining filters", () => {
  it("narrows on status and scope together, not one or the other", async () => {
    const user = userEvent.setup();
    renderFeed([
      job({ id: "a", prompt: "mine failed", userId: "usr_momen", status: "failed" }),
      job({ id: "b", prompt: "mine done", userId: "usr_momen", status: "completed" }),
      job({ id: "c", prompt: "theirs failed", userId: "usr_other", status: "failed" }),
    ]);

    await user.selectOptions(screen.getByLabelText("Status filter"), "failed");
    await openFilterPanel(user);
    await user.selectOptions(screen.getByLabelText("Scope"), "mine");

    expect(visiblePrompts(["mine failed", "mine done", "theirs failed"])).toEqual(["mine failed"]);
  });
});

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

// The switch Still Images already had. Both sections now render the same control
// from the same component, so "consistent" is structural rather than a promise.
describe("list and grid layout", () => {
  it("swaps the cards for a contact sheet and back", async () => {
    const user = userEvent.setup();
    renderFeed([job({ id: "a", prompt: "a tower at dusk", status: "completed" })]);

    // A card carries the prompt, the inputs and the whole toolbar; a tile does not.
    expect(screen.getByText("a tower at dusk")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Grid" }));
    const tile = screen.getByRole("button", { name: "Show this result in the full card" });
    expect(screen.queryByText("a tower at dusk")).toBeNull();

    await user.click(tile);
    expect(screen.getByText("a tower at dusk")).toBeInTheDocument();
    // Addressable, so the panel can scroll to the card the tile opened rather than
    // dropping the artist at the top of the feed.
    expect(document.getElementById("result-card-a")).toBeInTheDocument();
  });

  it("starts in the card layout", () => {
    // The default stays what it has always been: nobody's feed changes shape on
    // upgrade.
    renderFeed([job({ id: "a", prompt: "a tower at dusk" })]);
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the archive switch", () => {
  it("asks the host to switch views, in either direction", async () => {
    const user = userEvent.setup();
    const onToggleArchiveView = vi.fn();
    renderFeed([job()], { onToggleArchiveView });

    // Already active, so pressing Active is a no-op rather than a toggle.
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(onToggleArchiveView).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(onToggleArchiveView).toHaveBeenCalledOnce();
  });
});

describe("job actions", () => {
  it("offers cancel on a running job and passes it to the handler", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderFeed([job({ id: "a", status: "running" })], { onCancel });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("shows a disabled Canceling once the request is in flight", () => {
    renderFeed([job({ id: "a", status: "running", cancelRequested: true })]);

    // The dispatcher settles the request on its next poll, so the control stays
    // put rather than disappearing and leaving no sign anything happened.
    expect(screen.getByRole("button", { name: "Canceling" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("offers no cancel once a job has finished", () => {
    renderFeed([job({ id: "a", status: "completed" })]);

    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
  });

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
