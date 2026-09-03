import { AlertTriangle, FolderPlus, Globe, Pencil, Search, UserMinus, UserPlus, UsersRound, X } from "lucide-react";
import { FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatCredits, formatUsdTotal } from "../features/credits/creditUsageDashboardUtils";
import type { Project, ProjectMember, ProjectRole, User } from "../types";
import { useResetWhenChanged } from "../utils/useResetWhenChanged";
import { CreateProjectModal } from "./CreateProjectModal";
import { ProjectList } from "./ProjectList";
import { SpendLimitBar } from "./SpendLimitBar";

type RightProjectPanelProps = {
  projects: Project[];
  users: User[];
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
  onAddProjectMember: (projectId: string, userId: string, role: ProjectRole) => Promise<boolean>;
  onRemoveProjectMember: (projectId: string, userId: string) => Promise<boolean>;
  onCreateProjectFolder: (projectId: string, name: string, parentId?: string | null) => void;
  onRenameProjectFolder: (projectId: string, folderId: string, name: string) => void;
  onDeleteProjectFolder: (projectId: string, folderId: string) => void;
};

export function RightProjectPanel({
  projects,
  users,
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
  onAddProjectMember,
  onRemoveProjectMember,
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
            onOpenSettings={() => setSettingsProjectId(selectedProject.id)}
            onUpdateProject={onUpdateProject}
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
          projects={projects}
          ownerId={ownerId}
          onCreate={createProject}
          onOpenExisting={(projectId) => {
            onSelectProject(projectId);
            setModalOpen(false);
          }}
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
          onAddMember={onAddProjectMember}
          onRemoveMember={onRemoveProjectMember}
          onClose={() => setSettingsProjectId(null)}
        />
      ) : null}
    </div>
  );
}

// Folder selection and folder CRUD live in ProjectList; this panel only shows
// the selected project's details, so it takes no folder props.
function ProjectDetails({
  project,
  users,
  currentUserId,
  currentUserRole,
  onOpenSettings,
  onUpdateProject,
}: {
  project: Project;
  users: User[];
  currentUserId: string;
  currentUserRole: "admin" | "user";
  onOpenSettings: () => void;
  onUpdateProject: (project: Project) => void;
}) {
  const currentRole = getProjectRole(project, currentUserId);
  const isAdmin = currentUserRole === "admin";
  const canManage = isAdmin || currentRole === "owner" || project.ownerId === currentUserId;
  const folderName = projectFolderName(project);
  const memberCount = project.members.length + (project.groupMembers?.length ?? 0);

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
        <span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
          {visibilityLabel(project)}
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
          <p className="text-stone-500">credits &middot; {formatUsdTotal(project.usdUsed ?? 0)}</p>
        </div>
      </div>

      {project.spendLimitUsd ? (
        <div className="mt-3">
          <SpendLimitBar usdUsed={project.usdUsed ?? 0} spendLimitUsd={project.spendLimitUsd} variant="full" />
        </div>
      ) : null}

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
        <p className="mb-2 text-xs leading-5 text-stone-500">
          {project.visibility === "private"
            ? "Only these people can open this project."
            : "Everyone in the workspace can generate here. This list only records owners and view-only exceptions."}
        </p>
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
  onAddMember,
  onRemoveMember,
  onClose,
}: {
  project: Project;
  users: User[];
  currentUserId: string;
  currentUserRole: "admin" | "user";
  onUpdateProject: (project: Project) => void;
  onAddMember: (projectId: string, userId: string, role: ProjectRole) => Promise<boolean>;
  onRemoveMember: (projectId: string, userId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  // Editor by default, matching the create dialog: adding someone means letting
  // them work here.
  const [userRole, setUserRole] = useState<Exclude<ProjectRole, "owner">>("editor");
  const [feedback, setFeedback] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [spendLimitInput, setSpendLimitInput] = useState(project.spendLimitUsd != null ? String(project.spendLimitUsd) : "");
  const currentRole = getProjectRole(project, currentUserId);
  const isAdmin = currentUserRole === "admin";
  const isOwner = currentRole === "owner";
  // ownerId counts as well, matching the server's canManageProject. Projects
  // discovered on disk carry a placeholder owner and no owner row, so reading the
  // members list alone locked admins out of their own dialog.
  const canManage = isAdmin || isOwner || project.ownerId === currentUserId;
  const openToWorkspace = project.visibility !== "private";
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

  // Reset during render rather than in an effect: the input is state we own,
  // seeded from a project we do not. An effect would paint one frame showing the
  // previous project's limit before correcting itself.
  useResetWhenChanged(`${project.id}:${project.spendLimitUsd ?? ""}`, () => {
    setSpendLimitInput(project.spendLimitUsd != null ? String(project.spendLimitUsd) : "");
  });

  // No effect needed: "first available user unless one was picked" is derivable.
  // Storing it meant an extra render once the user list arrived, and a stale id if
  // the list changed under it.
  const effectiveUserId = selectedUserId || availableUsers[0]?.id || "";

  function closeOnOverlay(event: MouseEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target) {
      onClose();
    }
  }

  function nameFor(userId: string) {
    return users.find((user) => user.id === userId)?.name ?? userId;
  }

  // Every mutation waits for the server and reports what actually happened. The
  // previous version printed "User added to project." before the request was
  // even sent, so a rejected change still read as a success while the list
  // quietly reverted underneath it.
  async function addUser(event: FormEvent) {
    event.preventDefault();

    if (!canManage) {
      setFeedback({ tone: "bad", text: "You do not have permission to manage members for this project." });
      return;
    }

    if (!effectiveUserId) {
      setFeedback({ tone: "bad", text: "Select a user to add." });
      return;
    }

    setBusy(true);
    const added = await onAddMember(project.id, effectiveUserId, userRole);
    setBusy(false);
    setFeedback(
      added
        ? { tone: "ok", text: `${nameFor(effectiveUserId)} added as ${userRole}.` }
        : { tone: "bad", text: "Nothing was changed -- the server refused that member." },
    );
    if (!added) return;
    setSelectedUserId("");
    setSearch("");
  }

  async function removeMember(member: ProjectMember) {
    if (!canRemoveMember(project, currentRole, member, canManage)) {
      setFeedback({ tone: "bad", text: "This member cannot be removed with your current permission." });
      return;
    }

    setBusy(true);
    const removed = await onRemoveMember(project.id, member.userId);
    setBusy(false);
    setFeedback(
      removed
        ? { tone: "ok", text: `${nameFor(member.userId)} removed.` }
        : { tone: "bad", text: "Nothing was changed -- the server refused that removal." },
    );
  }

  async function updateRole(member: ProjectMember, role: ProjectRole) {
    if (!canManage) {
      setFeedback({ tone: "bad", text: "Only owners and admins can change member roles." });
      return;
    }

    if (member.role === "owner" && role !== "owner" && ownerCount <= 1) {
      setFeedback({ tone: "bad", text: "Every project must keep at least one owner." });
      return;
    }

    setBusy(true);
    // Adding an existing member is how the server records a role change.
    const saved = await onAddMember(project.id, member.userId, role);
    setBusy(false);
    setFeedback(
      saved
        ? { tone: "ok", text: `${nameFor(member.userId)} is now ${role}.` }
        : { tone: "bad", text: "The role was not changed." },
    );
  }

  function updateVisibility(visibility: Project["visibility"]) {
    if (!canManage) {
      setFeedback({ tone: "bad", text: "You do not have permission to change this project." });
      return;
    }
    onUpdateProject(normalizeProjectMemberCount({ ...project, visibility }));
    setFeedback({
      tone: "ok",
      text:
        visibility === "private"
          ? "Now private: only the members below can open this project."
          : "Now open to the workspace: everyone signed in can generate here.",
    });
  }

  function saveSpendLimit(event: FormEvent) {
    event.preventDefault();
    if (!isAdmin) {
      setFeedback({ tone: "bad", text: "Only admins can change the spend limit." });
      return;
    }
    const trimmed = spendLimitInput.trim();
    if (!trimmed) {
      onUpdateProject({ ...project, spendLimitUsd: null });
      setFeedback({ tone: "ok", text: "Spend limit removed." });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setFeedback({ tone: "bad", text: "Enter a non-negative dollar amount." });
      return;
    }
    onUpdateProject({ ...project, spendLimitUsd: parsed });
    setFeedback({ tone: "ok", text: `Spend limit set to ${formatUsdTotal(parsed)}.` });
  }

  function clearSpendLimit() {
    if (!isAdmin) {
      setFeedback({ tone: "bad", text: "Only admins can change the spend limit." });
      return;
    }
    setSpendLimitInput("");
    onUpdateProject({ ...project, spendLimitUsd: null });
    setFeedback({ tone: "ok", text: "Spend limit removed." });
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
              <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
                {visibilityLabel(project)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center text-xs md:grid-cols-6">
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
              <div className="rounded-md bg-mist/80 px-2 py-2">
                <p className="font-bold text-ink">{formatUsdTotal(project.usdUsed ?? 0)}</p>
                <p className="text-stone-500">spent (USD)</p>
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

          <section className="rounded-lg border border-line bg-white p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <Globe className="h-3.5 w-3.5" />
              Who can work in it
            </div>
            <select
              aria-label="Project access"
              value={openToWorkspace ? "team" : "private"}
              disabled={!canManage || busy}
              onChange={(event) => updateVisibility(event.target.value as Project["visibility"])}
              className="h-9 w-full rounded-md border border-line bg-white px-3 text-sm outline-none disabled:opacity-60 md:w-72"
            >
              <option value="team">Whole workspace</option>
              <option value="private">Only the people listed below</option>
            </select>
            <p className="mt-2 text-xs leading-5 text-stone-500">
              {openToWorkspace
                ? "Everyone signed in can open this project and generate into its folder. You only need the list below to add another owner, or to hold someone to view-only."
                : "Only the people listed below can open this project. Editors can generate, viewers can only look."}
            </p>
          </section>

          <section className="rounded-lg border border-line bg-white p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <AlertTriangle className="h-3.5 w-3.5" />
              Spend limit
            </div>
            {isAdmin ? (
              <form onSubmit={saveSpendLimit} className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-stone-400">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={spendLimitInput}
                    onChange={(event) => setSpendLimitInput(event.target.value)}
                    placeholder="No limit"
                    disabled={busy}
                    aria-label="Spend limit in USD"
                    className="h-9 w-40 rounded-md border border-line bg-white pl-6 pr-3 text-sm outline-none disabled:opacity-60"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="h-9 rounded-md border border-line px-3 text-xs font-semibold text-stone-600 transition hover:bg-stone-50 disabled:opacity-60"
                >
                  Save
                </button>
                {project.spendLimitUsd ? (
                  <button
                    type="button"
                    onClick={clearSpendLimit}
                    disabled={busy}
                    className="h-9 rounded-md px-3 text-xs font-semibold text-stone-500 transition hover:bg-stone-50 disabled:opacity-60"
                  >
                    Remove limit
                  </button>
                ) : null}
              </form>
            ) : (
              <p className="text-xs leading-5 text-stone-500">
                {project.spendLimitUsd
                  ? `Capped at ${formatUsdTotal(project.spendLimitUsd)}. Only admins can change this.`
                  : "No spend limit set. Only admins can set one."}
              </p>
            )}
            <div className="mt-3">
              <SpendLimitBar usdUsed={project.usdUsed ?? 0} spendLimitUsd={project.spendLimitUsd} variant="full" />
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
                const removable = canRemoveMember(project, currentRole, member, canManage);
                return (
                  <div
                    key={member.userId}
                    className="flex flex-col gap-2 rounded-md border border-line bg-white px-3 py-2 sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <UserAvatar user={user} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{user?.name ?? member.userId}</p>
                        <p className="truncate text-xs text-stone-500">{user?.email ?? "No email"}</p>
                      </div>
                    </div>
                    <select
                      aria-label={`Role for ${user?.name ?? member.userId}`}
                      value={member.role}
                      disabled={!canManage || busy}
                      onChange={(event) => void updateRole(member, event.target.value as ProjectRole)}
                      className="h-8 rounded-md border border-line bg-white px-2 text-xs font-semibold capitalize outline-none disabled:opacity-60"
                    >
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void removeMember(member)}
                      disabled={!removable || busy}
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

          <form onSubmit={(event) => void addUser(event)} className="rounded-lg border border-line bg-white p-3">
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
                  aria-label="User to add"
                  value={effectiveUserId}
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
                aria-label="Role for the new member"
                value={userRole}
                disabled={!canManage || busy}
                onChange={(event) => setUserRole(event.target.value as Exclude<ProjectRole, "owner">)}
                className="h-9 rounded-md border border-line bg-white px-3 text-sm outline-none disabled:opacity-60"
              >
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <button
                type="submit"
                disabled={!canManage || busy}
                className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-xs font-bold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
          </form>

          {feedback ? (
            <p
              role="status"
              className={
                feedback.tone === "ok"
                  ? "rounded-md bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800"
                  : "rounded-md bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
              }
            >
              {feedback.text}
            </p>
          ) : null}
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

function visibilityLabel(project: Project) {
  return project.visibility === "private" ? "Private" : "Whole workspace";
}

function projectFolderName(project: Project) {
  return `${project.shortName}_${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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

function UserAvatar({ user }: { user?: User }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white"
      style={{ backgroundColor: user?.avatarColor ?? "#d6d0c4" }}
    >
      {user?.profileImageUrl ? (
        <img src={user.profileImageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        (user?.avatar ?? "US")
      )}
    </span>
  );
}
