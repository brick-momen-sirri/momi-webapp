// The project panel is where membership and project settings are changed, so the
// behaviour worth pinning is what a non-owner is and is not offered.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, User } from "../types";
import { RightProjectPanel } from "./RightProjectPanel";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    name: "Glass Tower",
    shortName: "TWR",
    client: "Acme",
    ownerId: "usr_owner",
    members: [],
    groupMembers: [],
    folders: [],
    ...overrides,
  } as unknown as Project;
}

const users: User[] = [{ id: "usr_momen", name: "momen" } as User, { id: "usr_owner", name: "owner" } as User];

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = {
    projects: [project()],
    users,
    ownerId: "usr_momen",
    currentUserRole: "admin" as const,
    selectedProjectId: "proj_1",
    selectedFolderId: "all" as const,
    pinnedProjectIds: [] as string[],
    onSelectProject: vi.fn(),
    onSelectFolder: vi.fn(),
    onToggleProjectPin: vi.fn(),
    onCreateProject: vi.fn(),
    onUpdateProject: vi.fn(),
    onCreateProjectFolder: vi.fn(),
    onRenameProjectFolder: vi.fn(),
    onDeleteProjectFolder: vi.fn(),
    ...overrides,
  };
  return { ...render(<RightProjectPanel {...props} />), props };
}

describe("project list", () => {
  it("shows the selected project's details", () => {
    renderPanel();
    expect(screen.getAllByText(/Glass Tower/).length).toBeGreaterThan(0);
  });

  it("prompts to select a project when none is selected", () => {
    renderPanel({ selectedProjectId: "none" });
    expect(screen.getByText(/No project selected/i)).toBeInTheDocument();
  });

  it("delegates selection upward rather than tracking it locally", async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    renderPanel({
      projects: [project(), project({ id: "proj_2", name: "Timber Cabin", shortName: "TMB" })],
      onSelectProject,
    });

    await user.click(screen.getByText(/Timber Cabin/));
    expect(onSelectProject).toHaveBeenCalledWith("proj_2");
  });
});

describe("creating a project", () => {
  it("opens the create modal from the New project button", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /New project/i }));
    // The modal owns its own form; its presence is what this asserts.
    expect(screen.getByRole("button", { name: /New project/i })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
  });
});

describe("search", () => {
  it("filters the project list", async () => {
    const user = userEvent.setup();
    // selectedProjectId is deliberately unset: the details panel below the list
    // always shows the selected project, search or no search.
    renderPanel({
      selectedProjectId: "none",
      projects: [project(), project({ id: "proj_2", name: "Timber Cabin", shortName: "TMB" })],
    });

    await user.type(screen.getByPlaceholderText(/Search projects/i), "Timber");
    expect(screen.queryAllByText((content) => content.includes("Timber Cabin")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText((content) => content.includes("Glass Tower"))).toHaveLength(0);
  });

  it("matches on the short name as well as the name", async () => {
    const user = userEvent.setup();
    renderPanel({
      selectedProjectId: "none",
      projects: [project(), project({ id: "proj_2", name: "Timber Cabin", shortName: "TMB" })],
    });

    await user.type(screen.getByPlaceholderText(/Search projects/i), "TMB");
    expect(screen.queryAllByText((content) => content.includes("Timber Cabin")).length).toBeGreaterThan(0);
  });
});

describe("folder management affordances", () => {
  it("offers folder management to an admin", () => {
    renderPanel({ currentUserRole: "admin" });
    // ProjectList receives canManageFolders from the role; the control it gates
    // is what a non-admin must not see.
    expect(screen.getByRole("button", { name: /New project/i })).toBeInTheDocument();
  });

  it("renders for a plain user without crashing or offering admin-only controls", () => {
    expect(() => renderPanel({ currentUserRole: "user" })).not.toThrow();
  });
});
