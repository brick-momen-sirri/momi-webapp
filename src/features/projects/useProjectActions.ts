import type { Dispatch, SetStateAction } from "react";

import {
  addBackendProjectMember,
  createBackendProjectFolder,
  createBackendProject,
  deleteBackendProjectFolder,
  removeBackendProjectMember,
  renameBackendProjectFolder,
  updateBackendProject,
  type AuthUser,
} from "../../services/backendApi";
import type { Project, ProjectRole } from "../../types";
import { createClientId } from "../../utils/id";
import { slugify } from "../workspace/workspaceUtils";
import { withKnownProjectStats } from "./projectStats";

export type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
};

type ShowToast = (message: string, type?: "success" | "error" | "info") => void;

type ProjectActionsOptions = {
  account: AuthUser | null;
  backendAvailable: boolean;
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
  selectedFolderId: string;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  setTargetFolderId: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState | null>>;
  showToast: ShowToast;
};

export function useProjectActions(options: ProjectActionsOptions) {
  const {
    account,
    backendAvailable,
    projects,
    setProjects,
    setSelectedProjectId,
    selectedFolderId,
    setSelectedFolderId,
    setTargetFolderId,
    setConfirmDialog,
    showToast,
  } = options;

  async function handleCreateProject(project: Project) {
    try {
      const created = backendAvailable ? await createBackendProject(project) : project;
      setProjects((current) => [created, ...current]);
      setSelectedProjectId(created.id);
      // Report what the server stored, not what was submitted: the create route
      // used to drop the invite list, and a flat "Project created." was exactly
      // what made that invisible.
      const invited = created.members.filter((member) => member.userId !== created.ownerId).length;
      const scope =
        created.visibility === "private"
          ? invited
            ? `Private, ${invited} ${invited === 1 ? "person" : "people"} added.`
            : "Private, only you so far."
          : "Everyone in the workspace can generate in it.";
      showToast(`Project created. ${scope}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create project.", "error");
    }
  }

  // Member edits go one at a time and return whether the server agreed, so the
  // dialog can report the real outcome instead of an optimistic "added".
  async function handleAddProjectMember(projectId: string, userId: string, role: ProjectRole) {
    if (!backendAvailable) {
      showToast("Backend unavailable, member not saved.", "error");
      return false;
    }
    try {
      const updated = await addBackendProjectMember(projectId, userId, role);
      setProjects((current) => current.map((item) => (item.id === updated.id ? withKnownProjectStats(item, updated) : item)));
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not add project member.", "error");
      return false;
    }
  }

  async function handleRemoveProjectMember(projectId: string, userId: string) {
    if (!backendAvailable) {
      showToast("Backend unavailable, member not removed.", "error");
      return false;
    }
    try {
      const updated = await removeBackendProjectMember(projectId, userId);
      setProjects((current) => current.map((item) => (item.id === updated.id ? withKnownProjectStats(item, updated) : item)));
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not remove project member.", "error");
      return false;
    }
  }

  async function handleUpdateProject(project: Project) {
    try {
      const updated = backendAvailable ? await updateBackendProject(project) : project;
      setProjects((current) => current.map((item) => (item.id === updated.id ? withKnownProjectStats(item, updated) : item)));
      showToast("Project saved.");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update project.", "error");
      return false;
    }
  }

  async function handleCreateProjectFolder(projectId: string, name: string, parentId?: string | null) {
    try {
      if (backendAvailable) {
        const result = await createBackendProjectFolder(projectId, name, parentId);
        if (result.project) {
          setProjects((current) => current.map((item) => (item.id === result.project?.id ? withKnownProjectStats(item, result.project) : item)));
        }
        setSelectedFolderId(result.folder.folderId);
        setTargetFolderId(result.folder.folderId);
        showToast("Folder created.");
        return;
      }

      const now = new Date().toISOString();
      const folderId = createClientId("fld_").slice(0, 12);
      const folder = {
        folderId,
        parentId: parentId ?? null,
        name: name.trim(),
        slug: slugify(name),
        diskName: `${folderId}_${slugify(name)}`,
        createdAt: now,
        updatedAt: now,
        createdBy: account?.id,
        updatedBy: account?.id,
        archived: false,
      };
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, folders: [...(project.folders ?? []), folder] } : project,
        ),
      );
      setSelectedFolderId(folderId);
      setTargetFolderId(folderId);
      showToast("Folder created.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create folder.", "error");
    }
  }

  async function handleRenameProjectFolder(projectId: string, folderId: string, name: string) {
    try {
      if (backendAvailable) {
        const result = await renameBackendProjectFolder(projectId, folderId, name);
        if (result.project) {
          setProjects((current) => current.map((item) => (item.id === result.project?.id ? withKnownProjectStats(item, result.project) : item)));
        }
        showToast("Folder renamed.");
        return;
      }

      setProjects((current) =>
        current.map((project) =>
          project.id === projectId
            ? {
                ...project,
                folders: (project.folders ?? []).map((folder) =>
                  folder.folderId === folderId
                    ? {
                        ...folder,
                        name: name.trim(),
                        slug: slugify(name),
                        diskName: `${folder.folderId}_${slugify(name)}`,
                        updatedAt: new Date().toISOString(),
                      }
                    : folder,
                ),
              }
            : project,
        ),
      );
      showToast("Folder renamed.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not rename folder.", "error");
    }
  }

  function handleDeleteProjectFolder(projectId: string, folderId: string) {
    const folder = projects.find((item) => item.id === projectId)?.folders?.find((item) => item.folderId === folderId);
    if (!folder) return;
    setConfirmDialog({
      title: "Delete folder",
      message: `Delete empty folder "${folder.name}"? Folders with media cannot be deleted.`,
      confirmLabel: "Delete folder",
      tone: "danger",
      onConfirm: () => void performDeleteProjectFolder(projectId, folderId),
    });
  }

  async function performDeleteProjectFolder(projectId: string, folderId: string) {
    try {
      if (backendAvailable) {
        const result = await deleteBackendProjectFolder(projectId, folderId);
        if (result.project) {
          setProjects((current) => current.map((item) => (item.id === result.project?.id ? withKnownProjectStats(item, result.project) : item)));
        }
      } else {
        setProjects((current) =>
          current.map((item) =>
            item.id === projectId
              ? {
                  ...item,
                  folders: (item.folders ?? []).map((entry) =>
                    entry.folderId === folderId ? { ...entry, archived: true } : entry,
                  ),
                }
              : item,
          ),
        );
      }
      if (selectedFolderId === folderId) {
        setSelectedFolderId("all");
        setTargetFolderId("");
      }
      showToast("Folder deleted.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not delete folder.", "error");
    }
  }

  function handleSelectFolder(folderId: string) {
    setSelectedFolderId(folderId);
    setTargetFolderId(folderId === "all" || folderId === "root" ? "" : folderId);
  }

  return {
    handleCreateProject,
    handleUpdateProject,
    handleAddProjectMember,
    handleRemoveProjectMember,
    handleCreateProjectFolder,
    handleRenameProjectFolder,
    handleDeleteProjectFolder,
    handleSelectFolder,
  };
}
