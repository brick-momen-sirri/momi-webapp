// useProjectActions writes to the project folder tree, which is a real directory
// structure on disk that artists file renders into. Two things drive the tests:
//
//   1. Every action has an offline branch that mutates local state instead of
//      calling the backend. Those branches have to produce the same shape the
//      backend would, or the UI shows a folder the disk does not have.
//   2. Deleting a folder must go through a confirmation, and a folder that is no
//      longer present must not open one at all.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../types";
import {
  createBackendProject,
  createBackendProjectFolder,
  deleteBackendProjectFolder,
  renameBackendProjectFolder,
  updateBackendProject,
} from "../../services/backendApi";
import { useProjectActions, type ConfirmDialogState } from "./useProjectActions";

vi.mock("../../services/backendApi", () => ({
  createBackendProject: vi.fn(),
  createBackendProjectFolder: vi.fn(),
  deleteBackendProjectFolder: vi.fn(),
  renameBackendProjectFolder: vi.fn(),
  updateBackendProject: vi.fn(),
}));

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    name: "Glass Tower",
    folders: [{ folderId: "fld_1", name: "Interiors", archived: false }],
    ...overrides,
  } as unknown as Project;
}

function setup(overrides: Record<string, unknown> = {}) {
  const toasts: Array<{ message: string; type?: string }> = [];
  const state = {
    // Seeded from the override so the tracked state and the hook's input are the
    // same array; otherwise setProjects would update a list nobody is reading.
    projects: ((overrides.projects as Project[] | undefined) ?? [project()]) as Project[],
    selectedProjectId: "prj_1",
    selectedFolderId: "all",
    targetFolderId: "",
    confirm: null as ConfirmDialogState | null,
  };

  const options = {
    account: { id: "usr_1", name: "Momen" },
    backendAvailable: true,
    setProjects: vi.fn((update: Project[] | ((current: Project[]) => Project[])) => {
      state.projects = typeof update === "function" ? update(state.projects) : update;
    }),
    setSelectedProjectId: vi.fn((value: string) => {
      state.selectedProjectId = value;
    }),
    selectedFolderId: "all",
    setSelectedFolderId: vi.fn((value: string) => {
      state.selectedFolderId = value;
    }),
    setTargetFolderId: vi.fn((value: string) => {
      state.targetFolderId = value;
    }),
    setConfirmDialog: vi.fn((value: ConfirmDialogState | null) => {
      state.confirm = value;
    }),
    showToast: vi.fn((message: string, type?: string) => toasts.push({ message, type })),
    ...overrides,
    // Always the tracked array, whatever the override passed.
    projects: state.projects,
  };

  const rendered = renderHook(() => useProjectActions(options as never));
  return { ...rendered, options, state, toasts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("creating a project", () => {
  it("prepends the created project and selects it", async () => {
    vi.mocked(createBackendProject).mockResolvedValue(project({ id: "prj_new", name: "Timber Cabin" }));
    const { result, state } = setup();

    await act(async () => void (await result.current.handleCreateProject(project({ id: "prj_tmp" }))));

    expect(state.projects[0].id).toBe("prj_new");
    expect(state.selectedProjectId).toBe("prj_new");
  });

  it("uses the local object when the backend is unavailable", async () => {
    const { result, state } = setup({ backendAvailable: false });

    await act(async () => void (await result.current.handleCreateProject(project({ id: "prj_local" }))));

    expect(createBackendProject).not.toHaveBeenCalled();
    expect(state.projects[0].id).toBe("prj_local");
  });

  it("reports a rejected create without adding anything", async () => {
    vi.mocked(createBackendProject).mockRejectedValue(new Error("Project number already exists."));
    const { result, state, toasts } = setup();

    await act(async () => void (await result.current.handleCreateProject(project({ id: "prj_tmp" }))));

    expect(state.projects).toHaveLength(1);
    expect(toasts.at(-1)).toMatchObject({ message: "Project number already exists.", type: "error" });
  });
});

describe("updating a project", () => {
  it("replaces the matching project in place", async () => {
    vi.mocked(updateBackendProject).mockResolvedValue(project({ name: "Renamed Tower" }));
    const { result, state } = setup();

    await act(async () => void (await result.current.handleUpdateProject(project({ name: "Renamed Tower" }))));

    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].name).toBe("Renamed Tower");
  });

  it("reports a rejected update", async () => {
    vi.mocked(updateBackendProject).mockRejectedValue(new Error("Not permitted."));
    const { result, toasts } = setup();

    await act(async () => void (await result.current.handleUpdateProject(project())));

    expect(toasts.at(-1)).toMatchObject({ message: "Not permitted.", type: "error" });
  });
});

describe("creating a folder", () => {
  it("selects the folder the backend created and makes it the save target", async () => {
    vi.mocked(createBackendProjectFolder).mockResolvedValue({
      project: project({ folders: [{ folderId: "fld_2", name: "Exteriors", archived: false }] } as never),
      folder: { folderId: "fld_2", name: "Exteriors" },
    } as never);
    const { result, state } = setup();

    await act(async () => void (await result.current.handleCreateProjectFolder("prj_1", "Exteriors")));

    expect(state.selectedFolderId).toBe("fld_2");
    // Creating a folder is nearly always followed by rendering into it.
    expect(state.targetFolderId).toBe("fld_2");
  });

  it("passes the parent folder through for a subfolder", async () => {
    vi.mocked(createBackendProjectFolder).mockResolvedValue({
      project: undefined,
      folder: { folderId: "fld_3", name: "Night" },
    } as never);
    const { result } = setup();

    await act(async () => void (await result.current.handleCreateProjectFolder("prj_1", "Night", "fld_1")));

    expect(createBackendProjectFolder).toHaveBeenCalledWith("prj_1", "Night", "fld_1");
  });

  it("still selects the new folder when the response carries no project", async () => {
    vi.mocked(createBackendProjectFolder).mockResolvedValue({
      project: undefined,
      folder: { folderId: "fld_4", name: "Dusk" },
    } as never);
    const { result, state } = setup();

    await act(async () => void (await result.current.handleCreateProjectFolder("prj_1", "Dusk")));

    expect(state.selectedFolderId).toBe("fld_4");
  });

  it("builds an equivalent folder locally when offline", async () => {
    const { result, state } = setup({ backendAvailable: false });

    await act(async () => void (await result.current.handleCreateProjectFolder("prj_1", "  Exteriors  ")));

    expect(createBackendProjectFolder).not.toHaveBeenCalled();
    const folders = state.projects[0].folders ?? [];
    const added = folders.at(-1);
    expect(added?.name).toBe("Exteriors");
    expect(added?.slug).toBe("exteriors");
    // diskName is what the backend would derive; keeping the same shape means the
    // row does not change identity once the backend comes back.
    expect(added?.diskName).toBe(`${added?.folderId}_exteriors`);
    expect(added?.archived).toBe(false);
    expect(added?.createdBy).toBe("usr_1");
  });

  it("keeps other projects untouched when creating offline", async () => {
    const { result, state } = setup({
      backendAvailable: false,
      projects: [project(), project({ id: "prj_2", name: "Other", folders: [] })],
    });

    await act(async () => void (await result.current.handleCreateProjectFolder("prj_1", "Exteriors")));

    expect(state.projects[1].folders).toHaveLength(0);
  });

  it("reports a rejected folder create", async () => {
    vi.mocked(createBackendProjectFolder).mockRejectedValue(new Error("Folder name already used."));
    const { result, toasts } = setup();

    await act(async () => void (await result.current.handleCreateProjectFolder("prj_1", "Exteriors")));

    expect(toasts.at(-1)).toMatchObject({ message: "Folder name already used.", type: "error" });
  });
});

describe("renaming a folder", () => {
  it("applies the backend's project when one comes back", async () => {
    vi.mocked(renameBackendProjectFolder).mockResolvedValue({
      project: project({ folders: [{ folderId: "fld_1", name: "Interiors v2", archived: false }] } as never),
    } as never);
    const { result, state } = setup();

    await act(async () => void (await result.current.handleRenameProjectFolder("prj_1", "fld_1", "Interiors v2")));

    expect(state.projects[0].folders?.[0].name).toBe("Interiors v2");
  });

  it("rewrites the folder locally when offline, including the derived names", async () => {
    const { result, state } = setup({ backendAvailable: false });

    await act(async () => void (await result.current.handleRenameProjectFolder("prj_1", "fld_1", "  Night Shots  ")));

    const folder = state.projects[0].folders?.[0];
    expect(folder?.name).toBe("Night Shots");
    expect(folder?.slug).toBe("night-shots");
    expect(folder?.diskName).toBe("fld_1_night-shots");
  });

  it("leaves other folders alone", async () => {
    const twoFolders = project({
      folders: [
        { folderId: "fld_1", name: "Interiors", archived: false },
        { folderId: "fld_2", name: "Exteriors", archived: false },
      ],
    } as never);
    const { result, state } = setup({ backendAvailable: false, projects: [twoFolders] });

    await act(async () => void (await result.current.handleRenameProjectFolder("prj_1", "fld_1", "Renamed")));

    expect(state.projects[0].folders?.[1].name).toBe("Exteriors");
  });

  it("reports a rejected rename", async () => {
    vi.mocked(renameBackendProjectFolder).mockRejectedValue(new Error("Folder is locked."));
    const { result, toasts } = setup();

    await act(async () => void (await result.current.handleRenameProjectFolder("prj_1", "fld_1", "Nope")));

    expect(toasts.at(-1)).toMatchObject({ message: "Folder is locked.", type: "error" });
  });
});

describe("deleting a folder", () => {
  it("asks for confirmation naming the folder, and deletes nothing yet", () => {
    const { result, state } = setup();

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_1"));

    expect(deleteBackendProjectFolder).not.toHaveBeenCalled();
    expect(state.confirm?.tone).toBe("danger");
    expect(state.confirm?.message).toContain("Interiors");
  });

  it("opens no dialog for a folder that is not there", () => {
    const { result, options } = setup();

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_missing"));

    expect(options.setConfirmDialog).not.toHaveBeenCalled();
  });

  it("opens no dialog for an unknown project", () => {
    const { result, options } = setup();

    act(() => result.current.handleDeleteProjectFolder("prj_missing", "fld_1"));

    expect(options.setConfirmDialog).not.toHaveBeenCalled();
  });

  it("deletes once confirmed", async () => {
    vi.mocked(deleteBackendProjectFolder).mockResolvedValue({ project: project({ folders: [] } as never) } as never);
    const { result, state, toasts } = setup();

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_1"));
    await act(async () => {
      state.confirm?.onConfirm();
    });

    expect(deleteBackendProjectFolder).toHaveBeenCalledWith("prj_1", "fld_1");
    expect(toasts.at(-1)?.message).toMatch(/folder deleted/i);
  });

  it("archives rather than drops the folder when offline", async () => {
    const { result, state } = setup({ backendAvailable: false });

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_1"));
    await act(async () => {
      state.confirm?.onConfirm();
    });

    // Archived, not removed: the directory still exists on disk.
    expect(state.projects[0].folders?.[0].archived).toBe(true);
  });

  it("clears the selection when the deleted folder was the open one", async () => {
    vi.mocked(deleteBackendProjectFolder).mockResolvedValue({ project: undefined } as never);
    const { result, state } = setup({ selectedFolderId: "fld_1" });

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_1"));
    await act(async () => {
      state.confirm?.onConfirm();
    });

    expect(state.selectedFolderId).toBe("all");
    expect(state.targetFolderId).toBe("");
  });

  it("leaves the selection alone when a different folder was deleted", async () => {
    vi.mocked(deleteBackendProjectFolder).mockResolvedValue({ project: undefined } as never);
    const { result, state, options } = setup({ selectedFolderId: "fld_other" });

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_1"));
    await act(async () => {
      state.confirm?.onConfirm();
    });

    expect(options.setSelectedFolderId).not.toHaveBeenCalled();
  });

  it("reports a rejected delete", async () => {
    vi.mocked(deleteBackendProjectFolder).mockRejectedValue(new Error("Folder is not empty."));
    const { result, state, toasts } = setup();

    act(() => result.current.handleDeleteProjectFolder("prj_1", "fld_1"));
    await act(async () => {
      state.confirm?.onConfirm();
    });

    expect(toasts.at(-1)).toMatchObject({ message: "Folder is not empty.", type: "error" });
  });
});

describe("selecting a folder", () => {
  it("makes a real folder the save target too", () => {
    const { result, state } = setup();

    act(() => result.current.handleSelectFolder("fld_1"));

    expect(state.selectedFolderId).toBe("fld_1");
    expect(state.targetFolderId).toBe("fld_1");
  });

  it("clears the save target for the aggregate views", () => {
    // "all" and "root" are filters, not destinations, so a render must not be
    // filed into either.
    for (const folderId of ["all", "root"]) {
      const { result, state } = setup();
      act(() => result.current.handleSelectFolder(folderId));
      expect(state.selectedFolderId).toBe(folderId);
      expect(state.targetFolderId).toBe("");
    }
  });
});
