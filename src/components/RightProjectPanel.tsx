import {
  Check,
  Folder,
  FolderPlus,
  Pencil,
  Search,
  UserMinus,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Project, ProjectMember, ProjectRole, Team, User } from "../types";
import { CreateProjectModal } from "./CreateProjectModal";
import { ProjectList } from "./ProjectList";

type RightProjectPanelProps = {
  projects: Project[];
  users: User[];
  teams: Team[];
  ownerId: string;
  currentUserRole?: "admin" | "user";
  selectedProjectId: string;
  selectedFolderId: "all" | "root" | string;
  pinnedProjectIds: string[];
  onSelectProject: (projectId: string) => void;
  onSelectFolder: (folderId: "all" | "root" | string) => void;
  onToggleProjectPin: (projectId: string) => void;
  onCreateProject: (project: Project) => void;
  onUpdateProject: (project: Project) => void;
  onCreateProjectFolder: (projectId: string, name: string, parentId?: string | null) => void;
  onRenameProjectFolder: (projectId: string, folderId: string, name: string) => void;
  onDeleteProjectFolder: (projectId: string, folderId: string) => void;
};

export function RightProjectPanel({
  projects,
  users,
  teams,
  ownerId,
  currentUserRole = "user",
  selectedProjectId,
  selectedFolderId,
  pinnedProjectIds,
  onSelectProject,
  onSelectFolder,
  onToggleProjectPin,
  onCreateProject,
  onUpdateProject,
  onCreateProjectFolder,
  onRenameProjectFolder,
  onDeleteProjectFolder,
}: RightProjectPanelProps) {
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const settingsProject = settingsProjectId ? projects.find((project) => project.id === settingsProjectId) : undefined;

  const filteredProjects = useMemo(() => {
    const pinnedRank = new Map(pinnedProjectIds.map((projectId, index) => [projectId, index]));
    return projects
      .map((project, index) => ({ project, index }))
      .filter(({ project }) => {
        const text = `${project.name} ${project.shortName} ${project.description ?? ""}`.toLowerCase();
        return text.includes(query.toLowerCase());
      })
      .sort((a, b) => {
        const aPinned = pinnedRank.has(a.project.id);
        const bPinned = pinnedRank.has(b.project.id);
        if (aPinned && bPinned) return (pinnedRank.get(a.project.id) ?? 0) - (pinnedRank.get(b.project.id) ?? 0);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ project }) => project);
  }, [pinnedProjectIds, projects, query]);

  function createProject(project: Project) {
    onCreateProject(project);
    setModalOpen(false);
  }

  function openProjectSettings(projectId: string) {
    onSelectProject(projectId);
    setSettingsProjectId(projectId);
  }

  function renameProject(project: Project) {
    const client = window.prompt("Client", project.client ?? "");
    if (client == null) return;
    const name = window.prompt("Project name", project.name);
    if (!name?.trim()) return;
    onUpdateProject({ ...project, client: client.trim(), name: name.trim() });
  }

  return (
    <div className="space-y-3 pb-3">
      <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-bold text-white transition hover:bg-stone-700"
        >
          <FolderPlus className="h-4 w-4" />
          New project
        </button>

        <label className="relative mt-3 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects..."
            className="h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>

        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Projects</p>
          </div>
          <ProjectList
            projects={filteredProjects}
            selectedProjectId={selectedProjectId}
            selectedFolderId={selectedFolderId}
            pinnedProjectIds={pinnedProjectIds}
            canManageFolders={currentUserRole === "admin"}
            onSelectProject={onSelectProject}
            onSelectFolder={onSelectFolder}
            onToggleProjectPin={onToggleProjectPin}
            onOpenProjectSettings={openProjectSettings}
            onRenameProject={renameProject}
            onCreateProjectFolder={onCreateProjectFolder}
            onRenameProjectFolder={onRenameProjectFolder}
            onDeleteProjectFolder={onDeleteProjectFolder}
          />
        </div>
      </section>

      <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
        {selectedProject ? (
          <ProjectDetails
            project={selectedProject}
            users={users}
            currentUserId={ownerId}
            currentUserRole={currentUserRole}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onOpenSettings={() => setSettingsProjectId(selectedProject.id)}
            onUpdateProject={onUpdateProject}
            onCreateProjectFolder={onCreateProjectFolder}
            onRenameProjectFolder={onRenameProjectFolder}
            onDeleteProjectFolder={onDeleteProjectFolder}
          />
        ) : (
          <div className="py-5 text-center">
            <p className="text-sm font-semibold">No project selected</p>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              Select a project to generate into its folder, or stay in all-project browsing mode.
            </p>
          </div>
        )}
      </section>

      {modalOpen ? (
        <CreateProjectModal
          users={users}
          ownerId={ownerId}
          onCreate={createProject}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
      {settingsProject ? (
        <ManageMembersModal
          project={settingsProject}
          users={users}
          currentUserId={ownerId}
          currentUserRole={currentUserRole}
          onUpdateProject={onUpdateProject}
          onClose={() => setSettingsProjectId(null)}
        />
      ) : null}
    </div>
  );
}

function ProjectFolderPicker({
  project,
  selectedFolderId,
  isAdmin,
  onSelectFolder,
  onCreateProjectFolder,
  onRenameProjectFolder,
}: {
  project: Project;
  selectedFolderId: "all" | "root" | string;
  isAdmin: boolean;
  onSelectFolder: (folderId: "all" | "root" | string) => void;
  onCreateProjectFolder: (projectId: string, name: string) => void;
  onRenameProjectFolder: (projectId: string, folderId: string, name: string) => void;
}) {
  const activeFolders = (project.folders ?? []).filter((folder) => !folder.archived);

  function createFolder() {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    onCreateProjectFolder(project.id, name.trim());
  }

  function renameFolder(folderId: string, currentName: string) {
    const name = window.prompt("Folder name", currentName);
    if (!name?.trim() || name.trim() === currentName) return;
    onRenameProjectFolder(project.id, folderId, name.trim());
  }

  return (
    <div className="mt-3 rounded-md border border-line bg-mist/50 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
          <Folder className="h-3.5 w-3.5" />
          Folders
        </span>
        {isAdmin ? (
          <button
            type="button"
            onClick={createFolder}
            className="flex h-8 items-center gap-1.5 rounded-md bg-ink px-2 text-xs font-bold text-white transition hover:bg-stone-700"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New folder
          </button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <FolderRow
          label="All results"
          selected={selectedFolderId === "all"}
          onSelect={() => onSelectFolder("all")}
        />
        <FolderRow
          label="Root"
          selected={selectedFolderId === "root"}
          onSelect={() => onSelectFolder("root")}
        />
        {activeFolders.map((folder) => (
          <FolderRow
            key={folder.folderId}
            label={folder.name}
            selected={selectedFolderId === folder.folderId}
            onSelect={() => onSelectFolder(folder.folderId)}
            onRename={isAdmin ? () => renameFolder(folder.folderId, folder.name) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectDetails({
  project,
  users,
  currentUserId,
  currentUserRole,
  selectedFolderId,
  onSelectFolder,
  onOpenSettings,
  onUpdateProject,
  onCreateProjectFolder,
  onRenameProjectFolder,
}: {
  project: Project;
  users: User[];
  currentUserId: string;
  currentUserRole: "admin" | "user";
  selectedFolderId: "all" | "root" | string;
  onSelectFolder: (folderId: "all" | "root" | string) => void;
  onOpenSettings: () => void;
  onUpdateProject: (project: Project) => void;
  onCreateProjectFolder: (projectId: string, name: string, parentId?: string | null) => void;
  onRenameProjectFolder: (projectId: string, folderId: string, name: string) => void;
  onDeleteProjectFolder: (projectId: string, folderId: string) => void;
}) {
  const currentRole = getProjectRole(project, currentUserId);
  const isAdmin = currentUserRole === "admin";
  const canManage = isAdmin || currentRole === "owner";
  const activeFolders = (project.folders ?? []).filter((folder) => !folder.archived);
  const folderName = projectFolderName(project);
  const memberCount = project.members.length + (project.groupMembers?.length ?? 0);

  function createFolder() {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    onCreateProjectFolder(project.id, name.trim());
  }

  function renameFolder(folderId: string, currentName: string) {
    const name = window.prompt("Folder name", currentName);
    if (!name?.trim() || name.trim() === currentName) return;
    onRenameProjectFolder(project.id, folderId, name.trim());
  }

  function renameProject() {
    const client = window.prompt("Client", project.client ?? "");
    if (client == null) return;
    const name = window.prompt("Project name", project.name);
    if (!name?.trim()) return;
    onUpdateProject({ ...project, client: client.trim(), name: name.trim() });
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold">{project.name}</h2>
          <p className="mt-1 text-xs leading-5 text-stone-500">{project.description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold capitalize text-stone-600">
          {project.visibility}
        </span>
      </div>
      {isAdmin ? (
        <button
          type="button"
          onClick={renameProject}
          className="mt-3 flex h-8 items-center gap-1.5 rounded-md border border-line px-2 text-xs font-semibold text-stone-600 transition hover:bg-stone-50 hover:text-ink"
        >
          <Pencil className="h-3.5 w-3.5" />
          Rename project
        </button>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
        <div className="rounded-md bg-mist/80 px-2 py-2">
          <p className="font-bold text-ink">{project.jobCount}</p>
          <p className="text-stone-500">jobs</p>
        </div>
        <div className="rounded-md bg-mist/80 px-2 py-2">
          <p className="font-bold text-ink">{memberCount}</p>
          <p className="text-stone-500">members</p>
        </div>
        <div className="rounded-md bg-mist/80 px-2 py-2">
          <p className="font-bold text-ink">{project.unreadCount ?? 0}</p>
          <p className="text-stone-500">new</p>
        </div>
        <div className="rounded-md bg-mist/80 px-2 py-2">
          <p className="font-bold text-ink">{formatCredits(project.creditsUsed ?? 0)}</p>
          <p className="text-stone-500">credits</p>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-line bg-mist/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Storage</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-stone-700">{`/projects/
  ${folderName}/
    jobs/
    inputs/
    results/
    thumbnails/
    metadata.json`}</pre>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            <UsersRound className="h-3.5 w-3.5" />
            Permissions
          </span>
          <button
            type="button"
            onClick={onOpenSettings}
            disabled={!canManage}
            className="h-8 rounded-md border border-line px-2 text-xs font-semibold text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Manage members
          </button>
        </div>
        {!canManage ? (
          <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            You do not have permission to manage members for this project.
          </p>
        ) : null}
        <div className="space-y-2">
          {project.members.map((member) => {
            const user = users.find((item) => item.id === member.userId);
            return (
              <div key={member.userId} className="flex items-center justify-between rounded-md border border-line px-2 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <UserAvatar user={user} />
                  <span className="truncate text-sm font-semibold">{user?.name ?? member.userId}</span>
                </span>
                <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold capitalize text-stone-600">
                  {member.role}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ManageMembersModal({
  project,
  users,
  currentUserId,
  currentUserRole,
  onUpdateProject,
  onClose,
}: {
  project: Project;
  users: User[];
  currentUserId: string;
  currentUserRole: "admin" | "user";
  onUpdateProject: (project: Project) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userRole, setUserRole] = useState<Exclude<ProjectRole, "owner">>("viewer");
  const [message, setMessage] = useState("");
  const currentRole = getProjectRole(project, currentUserId);
  const isAdmin = currentUserRole === "admin";
  const isOwner = currentRole === "owner";
  const canManage = isAdmin || isOwner;
  const ownerCount = project.members.filter((member) => member.role === "owner").length;
  const memberCount = project.members.length + (project.groupMembers?.length ?? 0);
  const folderName = projectFolderName(project);
  const availableUsers = users.filter((user) => {
    const text = `${user.name} ${user.email ?? ""}`.toLowerCase();
    return !project.members.some((member) => member.userId === user.id) && text.includes(search.toLowerCase());
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!selectedUserId && availableUsers[0]) {
      setSelectedUserId(availableUsers[0].id);
    }
  }, [availableUsers, selectedUserId]);

  function closeOnOverlay(event: MouseEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target) {
      onClose();
    }
  }

  function save(nextProject: Project, confirmation: string) {
    const updated = normalizeProjectMemberCount(nextProject);
    onUpdateProject(updated);
    setMessage(confirmation);
  }

  function addUser(event: FormEvent) {
    event.preventDefault();

    if (!canManage) {
      setMessage("You do not have permission to manage members for this project.");
      return;
    }

    if (!selectedUserId) {
      setMessage("Select a user to add.");
      return;
    }

    const member: ProjectMember = {
      userId: selectedUserId,
      role: userRole,
      addedAt: new Date().toISOString(),
      addedBy: currentUserId,
    };

    save({ ...project, members: [...project.members, member] }, "User added to project.");
    setSelectedUserId("");
    setSearch("");
  }

  function removeMember(member: ProjectMember) {
    if (!canRemoveMember(project, currentRole, member, isAdmin)) {
      setMessage("This member cannot be removed with your current permission.");
      return;
    }

    save(
      { ...project, members: project.members.filter((item) => item.userId !== member.userId) },
      "Member removed.",
    );
  }

  function updateRole(member: ProjectMember, role: ProjectRole) {
    if (!isAdmin && !isOwner) {
      setMessage("Only owners can change member roles.");
      return;
    }

    if (member.role === "owner" && role !== "owner" && ownerCount <= 1) {
      setMessage("Every project must keep at least one owner.");
      return;
    }

    save(
      {
        ...project,
        members: project.members.map((item) =>
          item.userId === member.userId ? { ...item, role } : item,
        ),
      },
      "Member role updated.",
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/50 p-4 backdrop-blur-sm"
      onMouseDown={closeOnOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-members-title"
    >
      <div className="relative z-[1010] max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-line bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white px-4 py-3">
          <div>
            <h2 id="manage-members-title" className="text-sm font-bold">
              Manage members
            </h2>
            <p className="mt-1 text-xs text-stone-500">{project.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-500 transition hover:bg-stone-50"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {!canManage ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              You do not have permission to manage members for this project.
            </p>
          ) : null}

          <section className="rounded-lg border border-line bg-white p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{project.name}</p>
                <p className="mt-1 text-xs leading-5 text-stone-500">{project.description}</p>
              </div>
              <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold capitalize text-stone-600">
                {project.visibility}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center text-xs md:grid-cols-5">
              <div className="rounded-md bg-mist/80 px-2 py-2">
                <p className="font-bold text-ink">{project.jobCount}</p>
                <p className="text-stone-500">jobs</p>
              </div>
              <div className="rounded-md bg-mist/80 px-2 py-2">
                <p className="font-bold text-ink">{memberCount}</p>
                <p className="text-stone-500">members</p>
              </div>
              <div className="rounded-md bg-mist/80 px-2 py-2">
                <p className="font-bold text-ink">{project.unreadCount ?? 0}</p>
                <p className="text-stone-500">new</p>
              </div>
              <div className="rounded-md bg-mist/80 px-2 py-2">
                <p className="font-bold text-ink">{formatCredits(project.creditsUsed ?? 0)}</p>
                <p className="text-stone-500">credits</p>
              </div>
              <div className="rounded-md bg-mist/80 px-2 py-2">
                <p className="font-bold text-ink">{formatCredits(project.monthCreditsUsed ?? 0)}</p>
                <p className="text-stone-500">this month</p>
              </div>
            </div>
            <div className="mt-3 rounded-md border border-line bg-mist/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Storage</p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-stone-700">{`/projects/
  ${folderName}/
    jobs/
    inputs/
    results/
    thumbnails/
    metadata.json`}</pre>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-mist/40 p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <UsersRound className="h-3.5 w-3.5" />
              Current members
            </div>
            <div className="space-y-2">
              {project.members.map((member) => {
                const user = users.find((item) => item.id === member.userId);
                const removable = canRemoveMember(project, currentRole, member, isAdmin);
                return (
                  <div key={member.userId} className="flex flex-col gap-2 rounded-md border border-line bg-white px-3 py-2 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <UserAvatar user={user} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{user?.name ?? member.userId}</p>
                        <p className="truncate text-xs text-stone-500">{user?.email ?? "No email"}</p>
                      </div>
                    </div>
                    <select
                      value={member.role}
                      disabled={!isOwner}
                      onChange={(event) => updateRole(member, event.target.value as ProjectRole)}
                      className="h-8 rounded-md border border-line bg-white px-2 text-xs font-semibold capitalize outline-none disabled:opacity-60"
                    >
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeMember(member)}
                      disabled={!removable}
                      className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-semibold text-stone-600 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <form onSubmit={addUser} className="rounded-lg border border-line bg-white p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <UserPlus className="h-3.5 w-3.5" />
              Invite users
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_120px]">
              <div className="space-y-2">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name or email"
                  className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <select
                  value={selectedUserId}
                  onChange={(event) => setSelectedUserId(event.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-white px-3 text-sm outline-none"
                >
                  {availableUsers.length ? (
                    availableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} - {user.email}
                      </option>
                    ))
                  ) : (
                    <option value="">No matching users</option>
                  )}
                </select>
              </div>
              <select
                value={userRole}
                disabled={!canManage}
                onChange={(event) => setUserRole(event.target.value as Exclude<ProjectRole, "owner">)}
                className="h-9 rounded-md border border-line bg-white px-3 text-sm outline-none disabled:opacity-60"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button
                type="submit"
                disabled={!canManage}
                className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-xs font-bold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
          </form>

          {message ? <p className="rounded-md bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800">{message}</p> : null}
        </div>

        <div className="sticky bottom-0 flex justify-end border-t border-line bg-white px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-line px-4 text-xs font-bold text-stone-700 transition hover:bg-stone-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function getProjectRole(project: Project, userId: string): ProjectRole | undefined {
  return project.members.find((member) => member.userId === userId)?.role;
}

function projectFolderName(project: Project) {
  return `${project.shortName}_${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function formatCredits(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function canRemoveMember(project: Project, currentRole: ProjectRole | undefined, member: ProjectMember, isAdmin = false) {
  if (isAdmin || currentRole === "owner") {
    return member.role !== "owner" || project.members.filter((item) => item.role === "owner").length > 1;
  }

  if (currentRole === "editor") {
    return member.role === "viewer";
  }

  return false;
}

function normalizeProjectMemberCount(project: Project): Project {
  return {
    ...project,
    memberCount: project.members.length + (project.groupMembers?.length ?? 0),
  };
}

function FolderRow({
  label,
  selected,
  onSelect,
  onRename,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  onRename?: () => void;
}) {
  return (
    <div className={`flex items-center gap-1 rounded-md border px-2 py-1.5 ${selected ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"}`}>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-stone-400" />}
        <span className="truncate text-xs font-semibold">{label}</span>
      </button>
      {onRename ? (
        <button
          type="button"
          onClick={onRename}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition ${selected ? "text-white/80 hover:bg-white/10" : "text-stone-500 hover:bg-stone-50 hover:text-ink"}`}
          title="Rename folder"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function UserAvatar({ user }: { user?: User }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white"
      style={{ backgroundColor: user?.avatarColor ?? "#d6d0c4" }}
    >
      {user?.profileImageUrl ? <img src={user.profileImageUrl} alt="" className="h-full w-full object-cover" /> : user?.avatar ?? "US"}
    </span>
  );
}
