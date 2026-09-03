import { Folder, FolderPlus, Pencil, Pin, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatCredits, formatUsdTotal } from "../features/credits/creditUsageDashboardUtils";
import type { Project } from "../types";
import { SpendLimitBar } from "./SpendLimitBar";

type MenuItem = {
  label: string;
  icon: "rename" | "new" | "delete" | "settings";
  danger?: boolean;
  onClick: () => void;
};

type ProjectCardProps = {
  project: Project;
  selected: boolean;
  pinned: boolean;
  canManageFolders: boolean;
  onSelect: (projectId: string) => void;
  onTogglePin: (projectId: string) => void;
  onOpenSettings: (projectId: string) => void;
  onRenameProject: (project: Project) => void;
  onCreateProjectFolder: (projectId: string) => void;
};

export function ProjectCard({
  project,
  selected,
  pinned,
  canManageFolders,
  onSelect,
  onTogglePin,
  onOpenSettings,
  onRenameProject,
  onCreateProjectFolder,
}: ProjectCardProps) {
  const menuItems: MenuItem[] = [
    ...(canManageFolders
      ? [
          { label: "Rename folder", icon: "rename" as const, onClick: () => onRenameProject(project) },
          { label: "New subfolder", icon: "new" as const, onClick: () => onCreateProjectFolder(project.id) },
        ]
      : []),
    { label: "Manage members", icon: "settings" as const, onClick: () => onOpenSettings(project.id) },
  ];

  return (
    <div
      className={`relative flex w-full flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition ${
        selected ? "border-accent bg-accent/10" : "border-transparent bg-white hover:border-line hover:bg-stone-50"
      }`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`Select project ${project.name}`}
          onClick={() => onSelect(project.id)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-mist text-stone-600">
            <Folder className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{project.name}</span>
              {project.unreadCount ? (
                <span className="rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">
                  {project.unreadCount}
                </span>
              ) : null}
            </span>
            {/* Two tiers rather than one run of five numbers: what the project is
                and how busy it is, then what it has cost. The spend is the figure
                people come here for, so it gets its own line and the only emphasis. */}
            <span className="mt-1 block truncate text-[11px] tabular-nums text-stone-500">
              {project.shortName} &middot; {project.jobCount === 1 ? "1 job" : `${project.jobCount} jobs`} &middot;{" "}
              {project.memberCount === 1 ? "1 member" : `${project.memberCount} members`}
            </span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate tabular-nums text-stone-500">
                {formatCredits(project.creditsUsed ?? 0)} credits
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-ink">{formatUsdTotal(project.usdUsed ?? 0)}</span>
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => onTogglePin(project.id)}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent transition hover:border-line hover:bg-white ${
            pinned ? "text-accent" : "text-stone-400 hover:text-accent"
          }`}
          title={pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
          aria-label={pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
        >
          <Pin className={`h-3.5 w-3.5 ${pinned ? "fill-current" : ""}`} />
        </button>
        <ProjectRowMenuButton label={project.name} items={menuItems} />
      </div>
      {project.spendLimitUsd ? (
        <div className="pl-12">
          <SpendLimitBar usdUsed={project.usdUsed ?? 0} spendLimitUsd={project.spendLimitUsd} variant="compact" />
        </div>
      ) : null}
    </div>
  );
}

export function ProjectRowMenuButton({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-stone-400 transition hover:border-line hover:bg-white hover:text-accent"
        title={`${label} actions`}
        aria-label={`${label} actions`}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-50 w-48 overflow-hidden rounded-md border border-line bg-white py-1 shadow-2xl">
          <p className="truncate border-b border-line px-3 py-2 text-xs font-bold text-stone-600">{label}</p>
          {items.map((item) => {
            const Icon = menuIcon(item.icon);
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className={`flex h-9 w-full items-center gap-2 px-3 text-left text-xs font-semibold transition ${
                  item.danger ? "text-red-600 hover:bg-red-50" : "text-stone-700 hover:bg-stone-50"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function menuIcon(icon: MenuItem["icon"]) {
  if (icon === "rename") return Pencil;
  if (icon === "new") return FolderPlus;
  if (icon === "delete") return Trash2;
  return Settings2;
}

