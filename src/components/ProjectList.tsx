import { FileText, Layers, Pin } from "lucide-react";
import type { ReactNode } from "react";
import { sortFoldersByName } from "../features/projects/folderSort";
import { orderTopLevelFolders, pinnedFolderIdsIn } from "../features/projects/folderTree";
import type { Project, ProjectFolder } from "../types";
import { ProjectCard, ProjectRowMenuButton } from "./ProjectCard";

type ProjectListProps = {
  projects: Project[];
  selectedProjectId: string;
  selectedFolderId: "all" | "root" | string;
  pinnedProjectIds: string[];
  /** This account's pinned top-level folders, as folderPinKey(projectId, folderId). */
  pinnedFolderKeys?: string[];
  canManageFolders: boolean;
  onSelectProject: (projectId: string) => void;
  onSelectFolder: (folderId: "all" | "root" | string) => void;
  onToggleProjectPin: (projectId: string) => void;
  onToggleFolderPin?: (projectId: string, folderId: string) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onRenameProject: (project: Project) => void;
  onCreateProjectFolder: (projectId: string, name: string, parentId?: string | null) => void;
  onRenameProjectFolder: (projectId: string, folderId: string, name: string) => void;
  onDeleteProjectFolder: (projectId: string, folderId: string) => void;
};

export function ProjectList({
  projects,
  selectedProjectId,
  selectedFolderId,
  pinnedProjectIds,
  pinnedFolderKeys = [],
  canManageFolders,
  onSelectProject,
  onSelectFolder,
  onToggleProjectPin,
  onToggleFolderPin,
  onOpenProjectSettings,
  onRenameProject,
  onCreateProjectFolder,
  onRenameProjectFolder,
  onDeleteProjectFolder,
}: ProjectListProps) {
  const pinnedSet = new Set(pinnedProjectIds);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => onSelectProject("all")}
        className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition ${
          selectedProjectId === "all"
            ? "border-ink bg-ink text-white"
            : "border-transparent bg-white text-ink hover:border-line hover:bg-stone-50"
        }`}
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${selectedProjectId === "all" ? "bg-white/15" : "bg-mist"}`}
        >
          <Layers className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-sm font-semibold">All projects</span>
          <span className={`mt-1 block text-[11px] ${selectedProjectId === "all" ? "text-white/70" : "text-stone-500"}`}>
            Browse team and personal jobs
          </span>
        </span>
      </button>

      {projects.map((project) => {
        const selectedProject = project.id === selectedProjectId;
        const folders = (project.folders ?? []).filter((folder) => !folder.archived);
        const foldersByParent = new Map<string, ProjectFolder[]>();
        for (const folder of folders) {
          const key = folder.parentId ?? "";
          foldersByParent.set(key, [...(foldersByParent.get(key) ?? []), folder]);
        }
        // Pinning is for the first level only -- each artist's own folder -- and is
        // open to everyone, unlike the admin-only folder actions.
        const pinnedFolderIds = pinnedFolderIdsIn(project.id, pinnedFolderKeys);
        const renderFolderRows = (parentId: string | null, depth = 0): ReactNode[] => {
          const siblings = foldersByParent.get(parentId ?? "") ?? [];
          const ordered = depth === 0 ? orderTopLevelFolders(siblings, pinnedFolderIds) : sortFoldersByName(siblings);
          return ordered.flatMap((folder) => [
            <FolderListRow
              key={folder.folderId}
              label={folder.name}
              selected={selectedFolderId === folder.folderId}
              count={0}
              depth={depth}
              canManage={canManageFolders}
              pinned={depth === 0 && pinnedFolderIds.has(folder.folderId)}
              onTogglePin={
                depth === 0 && onToggleFolderPin ? () => onToggleFolderPin(project.id, folder.folderId) : undefined
              }
              onSelect={() => onSelectFolder(folder.folderId)}
              onRename={() => {
                const name = window.prompt("Folder name", folder.name);
                if (!name?.trim() || name.trim() === folder.name) return;
                onRenameProjectFolder(project.id, folder.folderId, name.trim());
              }}
              onCreateSubfolder={() => {
                const name = window.prompt("New subfolder name");
                if (!name?.trim()) return;
                onCreateProjectFolder(project.id, name.trim(), folder.folderId);
              }}
              onDelete={() => onDeleteProjectFolder(project.id, folder.folderId)}
            />,
            ...renderFolderRows(folder.folderId, depth + 1),
          ]);
        };
        return (
          <div key={project.id} className="space-y-1">
            <ProjectCard
              project={project}
              selected={selectedProject && selectedFolderId === "all"}
              pinned={pinnedSet.has(project.id)}
              canManageFolders={canManageFolders}
              onSelect={(projectId) => {
                onSelectProject(projectId);
                onSelectFolder("all");
              }}
              onTogglePin={onToggleProjectPin}
              onOpenSettings={onOpenProjectSettings}
              onRenameProject={onRenameProject}
              onCreateProjectFolder={(projectId) => {
                const name = window.prompt("New subfolder name");
                if (!name?.trim()) return;
                onCreateProjectFolder(projectId, name.trim());
              }}
            />
            {selectedProject ? (
              <div className="ml-6 space-y-1 border-l border-line pl-2">
                <FolderListRow
                  label="Root"
                  selected={selectedFolderId === "root"}
                  count={rootCount(project)}
                  onSelect={() => onSelectFolder("root")}
                />
                {renderFolderRows(null)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FolderListRow({
  label,
  selected,
  count,
  depth = 0,
  canManage = false,
  pinned = false,
  onTogglePin,
  onSelect,
  onRename,
  onCreateSubfolder,
  onDelete,
}: {
  label: string;
  selected: boolean;
  count: number;
  depth?: number;
  canManage?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onSelect: () => void;
  onRename?: () => void;
  onCreateSubfolder?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm transition ${selected ? "bg-accent/10 text-accent" : "text-stone-700 hover:bg-stone-50"}`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <FileText className="h-3.5 w-3.5 shrink-0 text-stone-400" />
        <span className="truncate text-xs font-semibold">{label}</span>
      </button>
      {count ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-stone-500">{count}</span> : null}
      {onTogglePin ? (
        // Shown on hover until pinned, so a list of a hundred artist folders is not
        // a column of pin icons.
        <button
          type="button"
          onClick={onTogglePin}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent transition hover:border-line hover:bg-white ${
            pinned ? "text-accent" : "text-stone-400 opacity-0 hover:text-accent focus:opacity-100 group-hover:opacity-100"
          }`}
          title={pinned ? `Unpin ${label}` : `Pin ${label} to the top`}
          aria-label={pinned ? `Unpin folder ${label}` : `Pin folder ${label}`}
        >
          <Pin className={`h-3.5 w-3.5 ${pinned ? "fill-current" : ""}`} />
        </button>
      ) : null}
      {canManage ? (
        <ProjectRowMenuButton
          label={label}
          items={[
            ...(onRename ? [{ label: "Rename folder", icon: "rename" as const, onClick: onRename }] : []),
            ...(onCreateSubfolder ? [{ label: "New subfolder", icon: "new" as const, onClick: onCreateSubfolder }] : []),
            ...(onDelete ? [{ label: "Delete folder", icon: "delete" as const, danger: true, onClick: onDelete }] : []),
          ]}
        />
      ) : null}
    </div>
  );
}

function rootCount(project: Project) {
  return Math.max(0, project.jobCount - (project.folders ?? []).filter((folder) => !folder.archived).length);
}
