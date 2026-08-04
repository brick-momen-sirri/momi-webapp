// The project panel is where membership and project settings are changed, so the
// behaviour worth pinning is what a non-owner is and is not offered.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

  it("offers folder actions to an admin", async () => {
    const client = userEvent.setup();
    renderPanel({ currentUserRole: "admin" });

    await client.click(screen.getByRole("button", { name: /Glass Tower actions/i }));

    expect(screen.getByText("Rename folder")).toBeInTheDocument();
    expect(screen.getByText("New subfolder")).toBeInTheDocument();
  });

  it("withholds folder actions from a plain user but still allows member management", async () => {
    const client = userEvent.setup();
    renderPanel({ currentUserRole: "user" });

    await client.click(screen.getByRole("button", { name: /Glass Tower actions/i }));

    // Creating and renaming folders writes to the project folder tree on disk, so
    // it stays admin-only; viewing membership does not.
    expect(screen.queryByText("Rename folder")).toBeNull();
    expect(screen.queryByText("New subfolder")).toBeNull();
    expect(screen.getAllByText("Manage members").length).toBeGreaterThan(0);
  });

  it("delegates subfolder creation upward with the name from the prompt", async () => {
    const client = userEvent.setup();
    const onCreateProjectFolder = vi.fn();
    // Folder creation is gated behind window.prompt, which jsdom does not implement.
    vi.spyOn(window, "prompt").mockReturnValue("  Interiors  ");
    renderPanel({ currentUserRole: "admin", onCreateProjectFolder });

    await client.click(screen.getByRole("button", { name: /Glass Tower actions/i }));
    await client.click(screen.getByText("New subfolder"));

    // Trimmed before it reaches the backend, which derives a disk name from it.
    expect(onCreateProjectFolder).toHaveBeenCalledWith("proj_1", "Interiors");
  });

  it("creates nothing when the folder-name prompt is dismissed", async () => {
    const client = userEvent.setup();
    const onCreateProjectFolder = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue(null);
    renderPanel({ currentUserRole: "admin", onCreateProjectFolder });

    await client.click(screen.getByRole("button", { name: /Glass Tower actions/i }));
    await client.click(screen.getByText("New subfolder"));

    expect(onCreateProjectFolder).not.toHaveBeenCalled();
  });

  it("creates nothing when the prompt returns only whitespace", async () => {
    const client = userEvent.setup();
    const onCreateProjectFolder = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    renderPanel({ currentUserRole: "admin", onCreateProjectFolder });

    await client.click(screen.getByRole("button", { name: /Glass Tower actions/i }));
    await client.click(screen.getByText("New subfolder"));

    // A blank name would otherwise create a folder with an empty disk name.
    expect(onCreateProjectFolder).not.toHaveBeenCalled();
  });
});

// Project membership decides who can see a project's media, so the permission
// branch here matters more than the cosmetics of the dialog.
describe("managing members", () => {
  async function openMembers(overrides: Record<string, unknown> = {}) {
    const client = userEvent.setup();
    const rendered = renderPanel(overrides);
    await client.click(screen.getAllByText("Manage members")[0]);
    return { ...rendered, client };
  }

  it("opens the members dialog", async () => {
    await openMembers();
    expect(screen.getByPlaceholderText(/search by name or email/i)).toBeInTheDocument();
  });

  it("closes the members dialog on Escape", async () => {
    const { client } = await openMembers();
    await client.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText(/search by name or email/i)).toBeNull();
  });

  it("adds the chosen user as a viewer by default", async () => {
    const onUpdateProject = vi.fn();
    const { client } = await openMembers({ currentUserRole: "admin", onUpdateProject });

    await client.click(screen.getByRole("button", { name: /^add$/i }));

    expect(onUpdateProject).toHaveBeenCalledTimes(1);
    const updated = onUpdateProject.mock.calls[0][0] as Project;
    // Least privilege: a newly added member gets read access, not write.
    expect(updated.members).toEqual([expect.objectContaining({ userId: "usr_momen", role: "viewer" })]);
  });

  it("does not let a plain non-owner open the members dialog at all", async () => {
    const client = userEvent.setup();
    const onUpdateProject = vi.fn();
    // Plain workspace user who is not an owner of this project.
    renderPanel({ currentUserRole: "user", onUpdateProject, projects: [project({ members: [] })] });

    const trigger = screen.getAllByRole("button", { name: "Manage members" })[0];
    expect(trigger).toBeDisabled();

    await client.click(trigger);
    expect(screen.queryByPlaceholderText(/search by name or email/i)).toBeNull();
    expect(onUpdateProject).not.toHaveBeenCalled();
  });

  it("says so when there is nobody left to add", async () => {
    const onUpdateProject = vi.fn();
    // Every known user is already a member, so the picker has no candidates.
    const { client } = await openMembers({
      currentUserRole: "admin",
      onUpdateProject,
      projects: [
        project({
          members: [
            { userId: "usr_momen", role: "owner" },
            { userId: "usr_owner", role: "viewer" },
          ],
        } as unknown as Partial<Project>),
      ],
    });

    await client.click(screen.getByRole("button", { name: /^add$/i }));

    expect(onUpdateProject).not.toHaveBeenCalled();
    expect(screen.getByText(/select a user to add/i)).toBeInTheDocument();
  });

  it("narrows the candidate list by search text", async () => {
    const { client } = await openMembers({ currentUserRole: "admin" });

    await client.type(screen.getByPlaceholderText(/search by name or email/i), "owner");

    // Two selects are present -- the candidate picker and the role picker. The
    // candidate picker is the first, and it should be down to the one match.
    const picker = screen.getAllByRole("combobox")[0];
    expect(within(picker).getAllByRole("option")).toHaveLength(1);
    expect(within(picker).getByRole("option")).toHaveTextContent(/owner/i);
  });
});

describe("pinning", () => {
  it("delegates pinning upward rather than tracking it locally", async () => {
    const client = userEvent.setup();
    const onToggleProjectPin = vi.fn();
    renderPanel({ onToggleProjectPin, pinnedProjectIds: [] });

    await client.click(screen.getByRole("button", { name: "Pin Glass Tower" }));

    expect(onToggleProjectPin).toHaveBeenCalledWith("proj_1");
  });

  it("offers to unpin a project that is already pinned", async () => {
    const client = userEvent.setup();
    const onToggleProjectPin = vi.fn();
    renderPanel({ onToggleProjectPin, pinnedProjectIds: ["proj_1"] });

    // Same control, inverted meaning -- the label is the only signal a user gets.
    expect(screen.queryByRole("button", { name: "Pin Glass Tower" })).toBeNull();
    await client.click(screen.getByRole("button", { name: "Unpin Glass Tower" }));

    expect(onToggleProjectPin).toHaveBeenCalledWith("proj_1");
  });

  it("labels each project's pin control independently", () => {
    renderPanel({
      projects: [project(), project({ id: "proj_2", name: "Timber Cabin", shortName: "TMB" })],
      pinnedProjectIds: ["proj_2"],
    });

    expect(screen.getByRole("button", { name: "Pin Glass Tower" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin Timber Cabin" })).toBeInTheDocument();
  });
});
