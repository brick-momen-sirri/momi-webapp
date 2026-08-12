// The folder name this dialog builds is the project's identity on disk, and the
// uniqueness constraint that stops duplicate projects is enforced on it. It used
// to be built from the project name alone -- "Azari project" + 7982 became
// 7982_Azari_project, a second folder beside the real 7982_Groupe Rawji_Azari_Project
// rather than a name that could collide with it. These pin the company format.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, User } from "../types";
import { CreateProjectModal } from "./CreateProjectModal";

const users: User[] = [{ id: "usr_momen", name: "momen" } as User];

const existingAzari = {
  id: "prj_7982_groupe_rawji_azari_project",
  name: "Azari Project",
  client: "Groupe Rawji",
  displayName: "Groupe Rawji - Azari Project",
  shortName: "7982",
  code: "7982",
  folderName: "7982_Groupe Rawji_Azari_Project",
  members: [],
  groupMembers: [],
} as unknown as Project;

function renderModal(projects: Project[] = []) {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  const onOpenExisting = vi.fn();
  render(
    <CreateProjectModal
      users={users}
      projects={projects}
      ownerId="usr_momen"
      onCreate={onCreate}
      onOpenExisting={onOpenExisting}
      onClose={onClose}
    />,
  );
  return { onCreate, onClose, onOpenExisting, user: userEvent.setup() };
}

async function fill(user: ReturnType<typeof userEvent.setup>, client: string, name: string, code: string) {
  if (client) await user.type(screen.getByPlaceholderText("Groupe Rawji"), client);
  if (name) await user.type(screen.getByPlaceholderText("Azari Project"), name);
  if (code) await user.type(screen.getByPlaceholderText("1234"), code);
}

describe("folder name", () => {
  it("builds code_Client_Project with whitespace as the separator", async () => {
    const { user, onCreate } = renderModal();
    await fill(user, "Groupe Rawji", "Azari Project", "7982");

    // Shown to the artist before they commit, so the folder is never a surprise.
    expect(screen.getByText("/projects/7982_Groupe_Rawji_Azari_Project/")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const created = onCreate.mock.calls[0][0] as Project;
    expect(created.folderName).toBe("7982_Groupe_Rawji_Azari_Project");
    expect(created.client).toBe("Groupe Rawji");
    expect(created.name).toBe("Azari Project");
  });

  it("refuses to create without a client, rather than folding it into the name", async () => {
    const { user, onCreate } = renderModal();
    await fill(user, "", "Azari Project", "7982");

    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/client, project name and 4-digit code are all required/i)).toBeInTheDocument();
  });

  it("requires the code to be four digits", async () => {
    const { user, onCreate } = renderModal();
    await fill(user, "Groupe Rawji", "Azari Project", "79");

    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/exactly 4 digits/i)).toBeInTheDocument();
  });

  it("reports a character the server would reject instead of mangling it into another folder", async () => {
    const { user, onCreate } = renderModal();
    // A slash would silently become part of a path rather than a name.
    await fill(user, "Groupe/Rawji", "Azari Project", "7982");

    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot contain any of/i)).toBeInTheDocument();
  });
});

// The 4-digit code is the real project identifier, and folder-name uniqueness
// does not catch a reused one: the folder on disk is "7982_Groupe Rawji_..."
// with a space where this dialog writes an underscore, so the two names never
// collide in the store. This check is the only thing that notices.
describe("duplicate code", () => {
  it("names the project that already holds the code", async () => {
    const { user } = renderModal([existingAzari]);
    await fill(user, "Groupe Rawji", "Azari Project", "7982");

    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent(/Code 7982 already belongs to Groupe Rawji - Azari Project/i);
    expect(warning).toHaveTextContent("7982_Groupe Rawji_Azari_Project");
  });

  it("stays quiet for a code nobody uses", async () => {
    const { user } = renderModal([existingAzari]);
    await fill(user, "Groupe Rawji", "Tower", "7983");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses the first attempt and creates once the artist confirms it is separate", async () => {
    const { user, onCreate } = renderModal([existingAzari]);
    await fill(user, "Groupe Rawji", "Azari Phase Two", "7982");

    await user.click(screen.getByRole("button", { name: /create project/i }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/tick the box to create a second project/i)).toBeInTheDocument();

    // A warning, not a block: reusing a code for a second phase is legitimate,
    // so the artist can proceed deliberately.
    await user.click(screen.getByRole("checkbox", { name: /use the code anyway/i }));
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect((onCreate.mock.calls[0][0] as Project).folderName).toBe("7982_Groupe_Rawji_Azari_Phase_Two");
  });

  it("offers the existing project instead of a new one", async () => {
    const { user, onOpenExisting } = renderModal([existingAzari]);
    await fill(user, "Groupe Rawji", "Azari Project", "7982");

    await user.click(screen.getByRole("button", { name: /open Groupe Rawji - Azari Project instead/i }));

    expect(onOpenExisting).toHaveBeenCalledWith("prj_7982_groupe_rawji_azari_project");
  });
});

describe("member list", () => {
  it("is only asked for on a private project", async () => {
    const { user } = renderModal();
    // A workspace-wide project is open to everyone, so a member list there would
    // decide nothing -- which is what trained people to fill one in anyway.
    expect(screen.queryByText(/invited users/i)).toBeNull();

    await user.selectOptions(screen.getByRole("combobox"), "private");

    expect(screen.getByText(/invited users/i)).toBeInTheDocument();
    expect(screen.getByText(/editors can generate/i)).toBeInTheDocument();
  });
});
