import { FormEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus, Save, X } from "lucide-react";
import type { Project, ProjectMember, User } from "../types";
import { createClientId } from "../utils/id";
import { TeamSelector } from "./TeamSelector";

const BRICK_PROJECT_FOLDER_RE = /^\d{4}_[A-Za-z0-9][A-Za-z0-9 .,&()+\-']*_[A-Za-z0-9][A-Za-z0-9 _.,&()+\-']*$/;
const PROJECT_FOLDER_MESSAGE = "Use folder format 1234_Client_Project, for example 1234_Abo_Omer.";

type CreateProjectModalProps = {
  users: User[];
  projects: Project[];
  ownerId: string;
  onCreate: (project: Project) => void;
  onOpenExisting: (projectId: string) => void;
  onClose: () => void;
};

export function CreateProjectModal({
  users,
  projects,
  ownerId,
  onCreate,
  onOpenExisting,
  onClose,
}: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [shortName, setShortName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Project["visibility"]>("team");
  const [members, setMembers] = useState<ProjectMember[]>([
    { userId: ownerId, role: "owner", addedAt: new Date().toISOString(), addedBy: ownerId },
  ]);
  const [duplicateCodeAccepted, setDuplicateCodeAccepted] = useState(false);
  const [error, setError] = useState("");

  // The 4-digit code is the company's project identifier, so two projects
  // sharing one is a duplicate however the folder text reads. Uniqueness in the
  // store is enforced on the folder name only, and that does not catch it: the
  // folders on disk use a space in the client segment ("7982_Groupe Rawji_...")
  // where this dialog writes an underscore, so the two names never collide. This
  // check is what actually notices, and it warns rather than blocks -- reusing a
  // code for a second phase is legitimate, so the call stays with the artist.
  const codeConflict = useMemo(() => {
    const code = shortName.trim().replace(/\D/g, "");
    if (code.length !== 4) return undefined;
    return projects.find((project) => (project.code ?? project.shortName ?? "").trim().toUpperCase() === code);
  }, [projects, shortName]);
  // A team project is open to the whole workspace, so its member list would only
  // ever be the owner. Asking for one there is what trained people to fill in a
  // list that then decided nothing.
  const needsMemberList = visibility === "private";

  // Mirrors buildProjectDiskName in backend/src/projectMetadataService.ts: the
  // company format is code_Client_Project, three segments. This dialog used to
  // build code_Name from the project name alone, so "Azari project" + 7982
  // produced 7982_Azari_project instead of 7982_Groupe Rawji_Azari_Project --
  // a new folder beside the real one rather than a name that could collide with
  // it. Whitespace becomes an underscore and nothing else is rewritten, which is
  // what the server does; anything it would reject is caught below instead of
  // being silently mangled into a different folder.
  const generatedFolderName = useMemo(() => {
    const code = shortName.trim().replace(/\D/g, "").slice(0, 4) || "1234";
    return `${code}_${folderNameSegment(client, "Client")}_${folderNameSegment(name, "Project")}`;
  }, [client, name, shortName]);
  const generatedFolder = `/projects/${generatedFolderName}/`;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (!name.trim() || !client.trim() || !shortName.trim()) {
      setError("Client, project name and 4-digit code are all required.");
      return;
    }
    if (!/^\d{4}$/.test(shortName.trim())) {
      setError("Short code must be exactly 4 digits.");
      return;
    }
    for (const [label, value] of [
      ["Client", client],
      ["Project name", name],
    ] as const) {
      const invalid = invalidNameReason(value);
      if (invalid) {
        setError(`${label} ${invalid}`);
        return;
      }
    }
    if (!BRICK_PROJECT_FOLDER_RE.test(generatedFolderName)) {
      setError(PROJECT_FOLDER_MESSAGE);
      return;
    }
    if (codeConflict && !duplicateCodeAccepted) {
      setError(`Code ${shortName.trim()} already belongs to ${projectLabel(codeConflict)}. Open that one, or tick the box to create a second project with the same code.`);
      return;
    }

    const now = new Date().toISOString();
    const normalizedMembers = [
      { userId: ownerId, role: "owner" as const, addedAt: now, addedBy: ownerId },
      ...(needsMemberList ? members : [])
        .filter((member) => member.userId !== ownerId)
        .map((member) => ({
          ...member,
          addedAt: member.addedAt ?? now,
          addedBy: member.addedBy ?? ownerId,
        })),
    ];
    onCreate({
      id: createClientId("prj_").slice(0, 12),
      name: name.trim(),
      client: client.trim(),
      shortName: shortName.trim().toUpperCase(),
      folderName: generatedFolderName,
      description: description.trim(),
      ownerId,
      members: normalizedMembers,
      groupMembers: [],
      jobCount: 0,
      memberCount: normalizedMembers.length,
      unreadCount: 0,
      createdAt: new Date().toISOString(),
      visibility,
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/50 p-4 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="relative z-[1010] max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <FolderPlus className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold">New project</h2>
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

        <div className="grid gap-4 p-4 md:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Client / office</span>
            <input
              value={client}
              onChange={(event) => setClient(event.target.value)}
              placeholder="Groupe Rawji"
              className="mt-1 h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Project name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Azari Project"
              className="mt-1 h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">4-digit code</span>
            <input
              value={shortName}
              onChange={(event) => setShortName(event.target.value)}
              placeholder="1234"
              className="mt-1 h-10 w-full rounded-md border border-line px-3 text-sm uppercase outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>

          {codeConflict ? (
            <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 md:col-span-2">
              <p className="text-xs font-bold text-amber-900">
                Code {shortName.trim()} already belongs to {projectLabel(codeConflict)}.
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                Its folder is <span className="font-mono">{codeConflict.folderName ?? "unknown"}</span>. Creating another
                project with this code makes a second folder beside it.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onOpenExisting(codeConflict.id)}
                  className="h-8 rounded-md bg-ink px-3 text-xs font-bold text-white transition hover:bg-stone-700"
                >
                  Open {projectLabel(codeConflict)} instead
                </button>
                <label className="flex items-center gap-2 text-xs font-semibold text-amber-900">
                  <input
                    type="checkbox"
                    checked={duplicateCodeAccepted}
                    onChange={(event) => setDuplicateCodeAccepted(event.target.checked)}
                    className="h-4 w-4 rounded border-amber-400 accent-accent"
                  />
                  This is a separate project, use the code anyway
                </label>
              </div>
            </div>
          ) : null}
          <label className="block md:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What kind of generations should live here?"
              className="mt-1 min-h-20 w-full resize-none rounded-md border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Who can work in it</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as Project["visibility"])}
              className="mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="team">Whole workspace</option>
              <option value="private">Only people I add</option>
            </select>
            <span className="mt-1 block text-xs leading-5 text-stone-500">
              {visibility === "private"
                ? "Nobody but you and the people below can open or generate in this project."
                : "Everyone signed in can open it and generate into its folder. Nothing else to set up."}
            </span>
          </label>
          <div className="rounded-md border border-line bg-mist/70 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Folder preview</p>
            <p className="mt-2 break-all font-mono text-xs text-stone-700">{generatedFolder}</p>
          </div>
        </div>

        {needsMemberList ? (
          <div className="border-t border-line px-4 py-4">
            <TeamSelector users={users} ownerId={ownerId} members={members} onMembersChange={setMembers} />
          </div>
        ) : null}

        {error ? <p className="px-4 text-xs font-semibold text-red-600">{error}</p> : null}

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-white px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-line px-4 text-sm font-semibold text-stone-600 transition hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-stone-700"
          >
            <Save className="h-4 w-4" />
            Create project
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function projectLabel(project: Project) {
  return project.displayName ?? (project.client ? `${project.client} - ${project.name}` : project.name);
}

function folderNameSegment(value: string, fallback: string) {
  return value.trim().replace(/\s+/g, "_") || fallback;
}

// The server's validateDisplayName rules, so a name it would refuse is reported
// here instead of coming back as a 400 after the dialog has been filled in.
function invalidNameReason(value: string) {
  const trimmed = value.trim();
  if (trimmed.length > 80) return "is too long (80 characters maximum).";
  if (/[<>:"/\\|?*]/.test(trimmed)) return 'cannot contain any of < > : " / \\ | ? *';
  if (trimmed.endsWith(".")) return "cannot end with a dot.";
  return "";
}
