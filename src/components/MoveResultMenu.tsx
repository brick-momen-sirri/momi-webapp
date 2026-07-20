import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Folder, FolderInput, FolderRoot, Loader2, Search, ShieldCheck, X } from "lucide-react";
import type { Job, Project, ProjectFolder } from "../types";

type MoveResultMenuProps = {
  job: Job;
  project?: Project;
  onMove: (job: Job, destinationFolderId: string | null) => Promise<boolean>;
};

type Destination = {
  folderId: string | null;
  name: string;
  path: string;
  isRoot: boolean;
};

export function MoveResultMenu({ job, project, onMove }: MoveResultMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [movingTo, setMovingTo] = useState<string | null | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const destinations = useMemo(
    () => buildDestinations(project, job.folderId),
    [job.folderId, project],
  );
  const filteredDestinations = destinations.filter((destination) => (
    `${destination.name} ${destination.path}`.toLowerCase().includes(query.trim().toLowerCase())
  ));
  const currentLocation = currentFolderLabel(project?.folders ?? [], job.folderId);
  const result = job.resultUrl ?? job.thumbnailUrl;
  const canMove = Boolean(
    result
    && job.status === "completed"
    && job.source !== "existing_project_media"
    && project
    && destinations.length,
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function moveTo(destination: Destination) {
    if (!canMove || movingTo !== undefined) return;
    setMovingTo(destination.folderId);
    try {
      const moved = await onMove(job, destination.folderId);
      if (moved) {
        setOpen(false);
        setQuery("");
      }
    } finally {
      setMovingTo(undefined);
    }
  }

  const unavailableReason = job.source === "existing_project_media"
    ? "Only generated results with saved job metadata can be moved"
    : job.status !== "completed"
      ? "The result can be moved after generation completes"
      : destinations.length
        ? "Move result to another project folder"
        : "No other project folders are available";

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => canMove && setOpen((value) => !value)}
        disabled={!canMove}
        className={`flex h-8 w-8 items-center justify-center rounded-md border border-line transition ${
          open
            ? "bg-cyan-50 text-cyan-700"
            : canMove
              ? "text-stone-600 hover:bg-stone-50"
              : "cursor-not-allowed text-stone-300"
        }`}
        title={unavailableReason}
        aria-label="Move result to another folder"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <FolderInput className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          className="move-result-menu absolute right-0 top-10 z-50 w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-cyan-100 bg-white shadow-2xl shadow-stone-900/15"
          role="dialog"
          aria-label="Choose destination folder"
        >
          <div className="border-b border-cyan-100 bg-gradient-to-br from-cyan-50 via-white to-teal-50 px-4 pb-3 pt-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-teal-500 text-white shadow-lg shadow-cyan-200">
                <FolderInput className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink">Move result</p>
                <p className="mt-0.5 truncate text-xs text-stone-500">
                  From <span className="font-semibold text-stone-700">{currentLocation}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition hover:bg-white hover:text-ink hover:shadow-sm"
                aria-label="Close move menu"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {destinations.length > 4 ? (
              <label className="relative mt-3 block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a folder..."
                  className="h-9 w-full rounded-xl border border-cyan-100 bg-white/90 pl-9 pr-3 text-xs font-medium text-ink outline-none transition placeholder:text-stone-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100"
                  autoFocus
                />
              </label>
            ) : null}
          </div>

          <div className="max-h-72 overflow-y-auto p-2">
            {filteredDestinations.length ? filteredDestinations.map((destination) => {
              const isMovingHere = movingTo !== undefined && movingTo === destination.folderId;
              return (
                <button
                  key={destination.folderId ?? "project-root"}
                  type="button"
                  onClick={() => void moveTo(destination)}
                  disabled={movingTo !== undefined}
                  className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-gradient-to-r hover:from-cyan-50 hover:to-teal-50 disabled:cursor-wait disabled:opacity-60"
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${
                    destination.isRoot
                      ? "bg-violet-50 text-violet-600 group-hover:bg-violet-100"
                      : "bg-cyan-50 text-cyan-700 group-hover:bg-cyan-100"
                  }`}>
                    {destination.isRoot ? <FolderRoot className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-stone-800">{destination.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-stone-500">{destination.path}</span>
                  </span>
                  {isMovingHere
                    ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-600" />
                    : <ArrowRight className="h-4 w-4 shrink-0 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-cyan-600" />}
                </button>
              );
            }) : (
              <div className="px-4 py-8 text-center">
                <Folder className="mx-auto h-7 w-7 text-stone-300" />
                <p className="mt-2 text-xs font-semibold text-stone-500">No folders match your search.</p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-line bg-stone-50/80 px-4 py-2.5 text-[11px] font-medium text-stone-500">
            <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
            Files move safely. Credits and job details stay unchanged.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildDestinations(project: Project | undefined, currentFolderId: string | null | undefined): Destination[] {
  if (!project) return [];
  const folders = (project.folders ?? []).filter((folder) => !folder.archived);
  const destinations: Destination[] = currentFolderId
    ? [{ folderId: null, name: "Project root", path: project.name, isRoot: true }]
    : [];
  destinations.push(...folders
    .filter((folder) => folder.folderId !== currentFolderId)
    .map((folder) => ({
      folderId: folder.folderId,
      name: folder.name,
      path: folderPathLabel(folder, folders),
      isRoot: false,
    }))
    .sort((left, right) => left.path.localeCompare(right.path)));
  return destinations;
}

function currentFolderLabel(folders: ProjectFolder[], currentFolderId: string | null | undefined) {
  if (!currentFolderId) return "Project root";
  const current = folders.find((folder) => folder.folderId === currentFolderId);
  return current ? folderPathLabel(current, folders) : "Unknown folder";
}

function folderPathLabel(folder: ProjectFolder, folders: ProjectFolder[]) {
  const byId = new Map(folders.map((item) => [item.folderId, item]));
  const names = [folder.name];
  const visited = new Set([folder.folderId]);
  let parentId = folder.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}
