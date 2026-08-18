// The two controls that decide what the results panel is showing: which set of
// results (active or archived) and in what shape (cards or a contact sheet).
//
// Shared rather than mirrored. Animation had the archive switch and Still Images
// had the layout switch, and each section wanted the other's -- reimplementing
// either would have left two segmented controls that drift apart in padding, in
// wording, and eventually in behaviour. Both sections now render the same ones.

import { Archive, CheckCircle2, LayoutGrid, Loader2, Rows3, TriangleAlert } from "lucide-react";
import type { Job } from "../types";
import { cn } from "../utils/classNames";

export type ResultLayout = "list" | "grid";

/**
 * Active results against archived ones.
 *
 * A toggle rather than a filter, because the two are different fetches: archived
 * jobs are paged in from the backend with archived=true, so this changes what is
 * loaded, not just what is drawn.
 */
export function ArchiveViewToggle({ archiveView, onToggle }: { archiveView: boolean; onToggle: () => void }) {
  return (
    <div className="grid h-10 shrink-0 grid-cols-2 rounded-md border border-line bg-mist/70 p-1">
      <button
        type="button"
        onClick={() => {
          if (archiveView) onToggle();
        }}
        className={cn(
          "rounded px-3 text-sm font-semibold transition",
          archiveView ? "text-stone-600 hover:bg-white hover:text-ink" : "bg-white text-ink shadow-sm",
        )}
        aria-pressed={!archiveView}
      >
        Active
      </button>
      <button
        type="button"
        onClick={() => {
          if (!archiveView) onToggle();
        }}
        className={cn(
          "flex items-center justify-center gap-1.5 rounded px-3 text-sm font-semibold transition",
          archiveView ? "bg-white text-ink shadow-sm" : "text-stone-600 hover:bg-white hover:text-ink",
        )}
        aria-pressed={archiveView}
      >
        <Archive className="h-3.5 w-3.5" />
        Archived
      </button>
    </div>
  );
}

/**
 * Full cards against a contact sheet.
 *
 * A card is how one result is judged -- inputs, metadata, the compare slider, the
 * whole toolbar -- and that is exactly what makes thirty of them unscannable. The
 * grid trades all of it for thumbnails, and a tile goes back to its card.
 */
export function ResultLayoutToggle({ layout, onChange }: { layout: ResultLayout; onChange: (layout: ResultLayout) => void }) {
  const options = [
    { value: "list", label: "List", icon: Rows3 },
    { value: "grid", label: "Grid", icon: LayoutGrid },
  ] as const;

  return (
    <div className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-mist/60 p-1">
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === layout;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-semibold transition",
              selected ? "bg-white text-ink shadow-card" : "text-stone-500 hover:text-ink",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function JobStatusBadge({ status }: { status: Job["status"] }) {
  const running = status === "queued" || status === "sending" || status === "running";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold capitalize",
        status === "completed"
          ? "bg-teal-50 text-teal-700"
          : status === "failed" || status === "canceled"
            ? "bg-rose-50 text-rose-700"
            : "bg-amber-50 text-amber-800",
      )}
    >
      {status === "completed" ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : running ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <TriangleAlert className="h-3 w-3" />
      )}
      {status}
    </span>
  );
}
