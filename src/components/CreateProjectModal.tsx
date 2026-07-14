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
  ownerId: string;
  onCreate: (project: Project) => void;
  onClose: () => void;
};

export function CreateProjectModal({ users, ownerId, onCreate, onClose }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Project["visibility"]>("team");
  const [members, setMembers] = useState<ProjectMember[]>([
    { userId: ownerId, role: "owner", addedAt: new Date().toISOString(), addedBy: ownerId },
  ]);
  const [error, setError] = useState("");

  const generatedFolderName = useMemo(() => {
    const code = shortName.trim().replace(/\D/g, "").slice(0, 4) || "1234";
    const safeName = folderNameSegment(name, "Client_Project");
    return `${code}_${safeName}`;
  }, [name, shortName]);
  const generatedFolder = `/projects/${generatedFolderName}/`;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (!name.trim() || !shortName.trim()) {
      setError("Project name and 4-digit code are required.");
      return;
    }
    if (!/^\d{4}$/.test(shortName.trim())) {
      setError("Short code must be exactly 4 digits.");
      return;
    }
    if (!BRICK_PROJECT_FOLDER_RE.test(generatedFolderName)) {
      setError(PROJECT_FOLDER_MESSAGE);
      return;
    }

    const now = new Date().toISOString();
    const normalizedMembers = [
      { userId: ownerId, role: "owner" as const, addedAt: now, addedBy: ownerId },
      ...members
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
      <form onSubmit={handleSubmit} className="relative z-[1010] max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white shadow-2xl">
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
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Project name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Abo Omer"
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
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Visibility</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as Project["visibility"])}
              className="mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="private">Private</option>
              <option value="team">Team</option>
              <option value="public">Public link</option>
            </select>
          </label>
          <div className="rounded-md border border-line bg-mist/70 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Folder preview</p>
            <p className="mt-2 break-all font-mono text-xs text-stone-700">{generatedFolder}</p>
          </div>
        </div>

        <div className="border-t border-line px-4 py-4">
          <TeamSelector
            users={users}
            ownerId={ownerId}
            members={members}
            onMembersChange={setMembers}
          />
        </div>

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

function folderNameSegment(value: string, fallback: string) {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}
