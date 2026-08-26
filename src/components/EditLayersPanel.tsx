import { Brush, ChevronDown, ChevronUp, Eye, EyeOff, Layers3, LoaderCircle, Plus, Trash2 } from "lucide-react";

import type { StillImageEditLayer } from "../features/still-images/stillImageCategories";
import { THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../services/backendApi";
import { cn } from "../utils/classNames";

type EditLayersPanelProps = {
  layers: StillImageEditLayer[];
  activeLayerId?: string;
  onNew: () => void;
  onSelect: (layerId: string) => void;
  onEditMask: (layerId: string) => void;
  onToggle: (layerId: string) => void;
  onDelete: (layerId: string) => void;
  onMove: (layerId: string, direction: -1 | 1) => void;
  disabled?: boolean;
  processingLabel?: string;
};

export function EditLayersPanel({
  layers,
  activeLayerId,
  onNew,
  onSelect,
  onEditMask,
  onToggle,
  onDelete,
  onMove,
  disabled = false,
  processingLabel = "Processing selected region",
}: EditLayersPanelProps) {
  const ordered = [...layers].sort((a, b) => b.order - a.order);

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel" aria-disabled={disabled}>
      <div className="flex items-center gap-2">
        <Layers3 className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold">Edit layers</h2>
        <button
          type="button"
          onClick={onNew}
          disabled={disabled}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-ink px-2.5 text-xs font-bold text-white transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus className="h-3.5 w-3.5" />
          New edit
        </button>
      </div>

      {disabled ? (
        <p
          className="mt-3 flex items-center gap-2 rounded-md bg-cyan-50 px-2.5 py-2 text-[11px] font-semibold text-cyan-800"
          role="status"
        >
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {processingLabel}
        </p>
      ) : null}

      <div className="mt-3 space-y-1.5" role="list" aria-label="Image edit layers">
        {ordered.map((layer, displayedIndex) => {
          const active = layer.id === activeLayerId;
          const actualIndex = layers.findIndex((entry) => entry.id === layer.id);
          const previewUrl = thumbnailMediaUrl(layer.generatedCropUrl ?? layer.resultUrl, THUMBNAIL_WIDTH.chip);
          return (
            <div
              key={layer.id}
              role="listitem"
              className={cn(
                "flex items-center gap-1 rounded-md border p-1.5 transition",
                active ? "border-accent bg-cyan-50" : "border-line bg-white",
              )}
            >
              <button
                type="button"
                onClick={() => onToggle(layer.id)}
                disabled={disabled}
                aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => onSelect(layer.id)}
                disabled={disabled}
                className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left disabled:cursor-not-allowed disabled:opacity-55"
              >
                <span className="h-10 w-12 shrink-0 overflow-hidden rounded border border-stone-200 bg-stone-100">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-[9px] font-bold uppercase text-stone-400">
                      {layer.status}
                    </span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-bold text-ink">{layer.name}</span>
                  <span className="block truncate text-[10px] capitalize text-stone-500">
                    {layer.status === "completed" ? layer.prompt || "Completed edit" : layer.status}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onEditMask(layer.id)}
                disabled={disabled}
                aria-label={`Edit mask for ${layer.name}`}
                title="Edit mask"
                className="flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Brush className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onMove(layer.id, 1)}
                disabled={disabled || actualIndex >= layers.length - 1}
                aria-label={`Move ${layer.name} up`}
                className="flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 disabled:opacity-25"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onMove(layer.id, -1)}
                disabled={disabled || actualIndex <= 0}
                aria-label={`Move ${layer.name} down`}
                className="flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 disabled:opacity-25"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDelete(layer.id)}
                disabled={disabled}
                aria-label={`Delete ${layer.name}`}
                className="flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <span className="sr-only">Layer {displayedIndex + 1}</span>
            </div>
          );
        })}

        <div
          className={cn(
            "flex h-10 items-center gap-2 rounded-md border px-2.5 text-xs font-semibold",
            activeLayerId ? "border-line bg-stone-50 text-stone-500" : "border-accent bg-cyan-50 text-ink",
          )}
        >
          <span className="h-4 w-4 rounded border border-stone-300 bg-gradient-to-br from-stone-100 to-stone-300" />
          Original image
        </div>
      </div>

      <p className="mt-2 text-xs leading-5 text-stone-500">
        {activeLayerId
          ? "The selected layer's mask and prompt are editable. Regeneration replaces it against its frozen original base."
          : "New edits use the visible composite and are added above the existing layers."}
      </p>
    </section>
  );
}
