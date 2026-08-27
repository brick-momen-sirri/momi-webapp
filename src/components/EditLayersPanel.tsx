// The layer stack, as a lightweight Photoshop Layers panel.
//
// The panel's job is to make one question unambiguous at all times: what will the
// next action change? Photoshop answers it with two thumbnails per row and a ring
// around whichever one is armed, and that is what is copied here -- the generated
// pixels on the left, the layer's mask on the right, and exactly one of the two
// carrying the active outline. Everything else on the row (visibility, opacity,
// order, the mask switch, the chain) is a property of the layer that the composite
// reads live, so none of it costs a regeneration.
//
// The Original image keeps its own row at the bottom, locked. It is the one thing
// in the document that no edit may touch, and showing it as an ordinary layer that
// simply refuses every button is clearer than leaving it out and asking the artist
// to infer that the picture underneath is not in the list.

import {
  ChevronDown,
  ChevronUp,
  CircleOff,
  Contrast,
  Copy,
  Eye,
  EyeOff,
  Layers3,
  Link2,
  Link2Off,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RotateCcw,
  Scaling,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { layerMaskEnabled, layerMaskLinked, layerOffset, layerOpacity } from "../features/still-images/imageEditLayers";
import {
  isIdentityTransform,
  maskInverted,
  maskTransform,
  transformReadout,
  type MaskDrawing,
} from "../features/still-images/maskDrawing";
import { renderMaskThumbnailCanvas } from "../features/still-images/maskRaster";
import type { StillImageEditLayer, StillImageEditTarget } from "../features/still-images/stillImageCategories";
import { THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../services/backendApi";
import { cn } from "../utils/classNames";

type EditLayersPanelProps = {
  layers: StillImageEditLayer[];
  activeLayerId?: string;
  /** Which half of the selected layer the editor's tools are pointed at. */
  activeTarget: StillImageEditTarget;
  onNew: () => void;
  onSelect: (layerId: string, target: StillImageEditTarget) => void;
  onToggle: (layerId: string) => void;
  onDelete: (layerId: string) => void;
  onDuplicate: (layerId: string) => void;
  onMove: (layerId: string, direction: -1 | 1) => void;
  onRename: (layerId: string, name: string) => void;
  onOpacityChange: (layerId: string, opacity: number) => void;
  onMaskEnabledChange: (layerId: string, enabled: boolean) => void;
  onMaskLinkedChange: (layerId: string, linked: boolean) => void;
  onResetOffset: (layerId: string) => void;
  /** Act on the live drawing, so they are offered for the selected layer only. */
  onInvertMask?: () => void;
  onClearMask?: () => void;
  onResetMaskTransform?: () => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  regenerateHint?: string;
  disabled?: boolean;
  processingLabel?: string;
};

export function EditLayersPanel({
  layers,
  activeLayerId,
  activeTarget,
  onNew,
  onSelect,
  onToggle,
  onDelete,
  onDuplicate,
  onMove,
  onRename,
  onOpacityChange,
  onMaskEnabledChange,
  onMaskLinkedChange,
  onResetOffset,
  onInvertMask,
  onClearMask,
  onResetMaskTransform,
  onRegenerate,
  canRegenerate = false,
  regenerateHint,
  disabled = false,
  processingLabel = "Processing selected region",
}: EditLayersPanelProps) {
  // Displayed top-down the way every layer stack is, while order counts upwards.
  const ordered = [...layers].sort((a, b) => b.order - a.order);

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel" aria-disabled={disabled}>
      <div className="flex items-center gap-2">
        <Layers3 className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold">Layers</h2>
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
        {ordered.map((layer, displayedIndex) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            displayedIndex={displayedIndex}
            active={layer.id === activeLayerId}
            activeTarget={activeTarget}
            atTop={layer.order >= layers.length - 1}
            atBottom={layer.order <= 0}
            disabled={disabled}
            onSelect={onSelect}
            onToggle={onToggle}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onMove={onMove}
            onRename={onRename}
            onOpacityChange={onOpacityChange}
            onMaskEnabledChange={onMaskEnabledChange}
            onMaskLinkedChange={onMaskLinkedChange}
            onResetOffset={onResetOffset}
            onInvertMask={onInvertMask}
            onClearMask={onClearMask}
            onResetMaskTransform={onResetMaskTransform}
            onRegenerate={onRegenerate}
            canRegenerate={canRegenerate}
            regenerateHint={regenerateHint}
          />
        ))}

        <div
          className={cn(
            "flex h-11 items-center gap-2 rounded-md border px-2.5 text-xs font-semibold",
            activeLayerId ? "border-line bg-stone-50 text-stone-500" : "border-accent bg-cyan-50 text-ink",
          )}
          role="listitem"
          aria-label="Original image, locked"
        >
          <span className="h-7 w-9 shrink-0 rounded border border-stone-300 bg-gradient-to-br from-stone-100 to-stone-300" />
          <span className="min-w-0 flex-1 truncate">Original image</span>
          <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden="true" />
          <span className="sr-only">Locked</span>
        </div>
      </div>

      <p className="mt-2 text-xs leading-5 text-stone-500">
        {activeLayerId
          ? activeTarget === "mask"
            ? "Painting, selecting and moving change this layer's mask. The generated pixels are untouched."
            : "Move and transform act on this layer's pixels. Click its mask thumbnail to edit what the layer reveals."
          : "New edits are painted on the visible composite and land above every existing layer."}
      </p>
    </section>
  );
}

type LayerRowProps = {
  layer: StillImageEditLayer;
  displayedIndex: number;
  active: boolean;
  activeTarget: StillImageEditTarget;
  atTop: boolean;
  atBottom: boolean;
  disabled: boolean;
} & Pick<
  EditLayersPanelProps,
  | "onSelect"
  | "onToggle"
  | "onDelete"
  | "onDuplicate"
  | "onMove"
  | "onRename"
  | "onOpacityChange"
  | "onMaskEnabledChange"
  | "onMaskLinkedChange"
  | "onResetOffset"
  | "onInvertMask"
  | "onClearMask"
  | "onResetMaskTransform"
  | "onRegenerate"
  | "canRegenerate"
  | "regenerateHint"
>;

function LayerRow({
  layer,
  displayedIndex,
  active,
  activeTarget,
  atTop,
  atBottom,
  disabled,
  onSelect,
  onToggle,
  onDelete,
  onDuplicate,
  onMove,
  onRename,
  onOpacityChange,
  onMaskEnabledChange,
  onMaskLinkedChange,
  onResetOffset,
  onInvertMask,
  onClearMask,
  onResetMaskTransform,
  onRegenerate,
  canRegenerate = false,
  regenerateHint,
}: LayerRowProps) {
  const [renaming, setRenaming] = useState(false);
  const previewUrl = thumbnailMediaUrl(layer.generatedCropUrl ?? layer.resultUrl, THUMBNAIL_WIDTH.chip);
  const opacity = layerOpacity(layer);
  const maskOn = layerMaskEnabled(layer);
  const linked = layerMaskLinked(layer);
  const offset = layerOffset(layer);
  const moved = offset.x !== 0 || offset.y !== 0;
  const inverted = maskInverted(layer.mask);
  const transform = maskTransform(layer.mask);
  const transformed = !isIdentityTransform(transform);

  return (
    <div
      role="listitem"
      data-layer-id={layer.id}
      data-active={active || undefined}
      data-active-target={active ? activeTarget : undefined}
      className={cn(
        "rounded-md border p-1.5 transition",
        active ? "border-accent bg-cyan-50 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]" : "border-line bg-white",
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onToggle(layer.id)}
          disabled={disabled}
          aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
          aria-pressed={layer.visible}
          className="flex h-8 w-7 shrink-0 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>

        <ThumbnailButton
          label={`Edit ${layer.name} content`}
          title="Layer content — move and transform the generated pixels"
          selected={active && activeTarget === "content"}
          disabled={disabled}
          onClick={() => onSelect(layer.id, "content")}
        >
          {previewUrl ? (
            <img src={previewUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[9px] font-bold uppercase text-stone-400">
              {layer.status}
            </span>
          )}
        </ThumbnailButton>

        <span
          className="flex h-4 w-3 shrink-0 items-center justify-center text-stone-400"
          title={linked ? "Mask moves with the layer" : "Mask moves independently"}
          aria-hidden="true"
        >
          {linked ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3 text-amber-600" />}
        </span>

        <ThumbnailButton
          label={`Edit ${layer.name} mask`}
          title="Layer mask — paint, erase and select what this layer reveals"
          selected={active && activeTarget === "mask"}
          disabled={disabled}
          onClick={() => onSelect(layer.id, "mask")}
        >
          <MaskThumbnail drawing={layer.mask} dimmed={!maskOn} />
        </ThumbnailButton>

        <div className="ml-1 min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              defaultValue={layer.name}
              aria-label={`Rename ${layer.name}`}
              onBlur={(event) => {
                onRename(layer.id, event.target.value);
                setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenaming(false);
                event.stopPropagation();
              }}
              className="w-full rounded border border-accent bg-white px-1.5 py-0.5 text-xs font-bold text-ink outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => onSelect(layer.id, active ? activeTarget : "content")}
              onDoubleClick={() => !disabled && setRenaming(true)}
              disabled={disabled}
              title="Double-click to rename"
              className="block w-full min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="block truncate text-xs font-bold text-ink">{layer.name}</span>
              <span className="block truncate text-[10px] text-stone-500">
                {layer.status === "completed" ? statusLine(opacity, maskOn, inverted, moved, transformed) : layer.status}
              </span>
            </button>
          )}
        </div>

        <RowButton
          onClick={() => onMove(layer.id, 1)}
          disabled={disabled || atTop}
          label={`Move ${layer.name} up`}
          title="Move up"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton
          onClick={() => onMove(layer.id, -1)}
          disabled={disabled || atBottom}
          label={`Move ${layer.name} down`}
          title="Move down"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton
          onClick={() => onDuplicate(layer.id)}
          disabled={disabled}
          label={`Duplicate ${layer.name}`}
          title="Duplicate layer"
        >
          <Copy className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton
          onClick={() => onDelete(layer.id)}
          disabled={disabled}
          label={`Delete ${layer.name}`}
          title="Delete layer"
          destructive
        >
          <Trash2 className="h-3.5 w-3.5" />
        </RowButton>
        <span className="sr-only">Layer {displayedIndex + 1}</span>
      </div>

      {active ? (
        <div className="mt-2 space-y-2 border-t border-cyan-200/70 pt-2">
          <label className="flex items-center gap-2 text-[11px] font-semibold text-stone-600">
            Opacity
            <input
              type="range"
              min={0}
              max={100}
              value={opacity}
              disabled={disabled}
              onChange={(event) => onOpacityChange(layer.id, Number(event.target.value))}
              className="min-w-0 flex-1 accent-accent disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`${layer.name} opacity`}
            />
            <span className="w-9 text-right tabular-nums text-stone-800">{opacity}%</span>
          </label>

          <div className="flex flex-wrap items-center gap-1">
            <ChipButton
              onClick={() => onMaskEnabledChange(layer.id, !maskOn)}
              disabled={disabled}
              pressed={!maskOn}
              title={maskOn ? "Turn the mask off — the whole layer shows" : "Turn the mask back on"}
            >
              <CircleOff className="h-3 w-3" />
              {maskOn ? "Disable mask" : "Mask off"}
            </ChipButton>
            <ChipButton
              onClick={() => onMaskLinkedChange(layer.id, !linked)}
              disabled={disabled}
              pressed={!linked}
              title={linked ? "Unlink the mask so it moves on its own" : "Link the mask back to the layer"}
            >
              {linked ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
              {linked ? "Linked" : "Unlinked"}
            </ChipButton>
            {onInvertMask ? (
              <ChipButton onClick={onInvertMask} disabled={disabled} pressed={inverted} title="Invert the mask">
                <Contrast className="h-3 w-3" />
                Invert
              </ChipButton>
            ) : null}
            {onClearMask ? (
              <ChipButton onClick={onClearMask} disabled={disabled} title="Clear the mask">
                <Trash2 className="h-3 w-3" />
                Clear
              </ChipButton>
            ) : null}
            {moved ? (
              <ChipButton
                onClick={() => onResetOffset(layer.id)}
                disabled={disabled}
                title={`Put the layer back at its generated position (${offset.x >= 0 ? "+" : ""}${Math.round(offset.x)}, ${offset.y >= 0 ? "+" : ""}${Math.round(offset.y)} px)`}
              >
                <RotateCcw className="h-3 w-3" />
                Reset move
              </ChipButton>
            ) : null}
            {transformed && onResetMaskTransform ? (
              <ChipButton
                onClick={onResetMaskTransform}
                disabled={disabled}
                title={`Put the mask back to the shape it was painted (${transformSummary(transform)})`}
              >
                <Scaling className="h-3 w-3" />
                Reset transform
              </ChipButton>
            ) : null}
          </div>

          {onRegenerate ? (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={disabled || !canRegenerate}
              title={canRegenerate ? "Run this layer's edit again against its frozen base" : regenerateHint}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-accent/60 bg-white px-2 text-[11px] font-bold text-accent transition hover:bg-cyan-50 disabled:cursor-not-allowed disabled:border-line disabled:text-stone-400"
            >
              <WandSparkles className="h-3.5 w-3.5" />
              Regenerate this layer
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The one-line "what is different about this layer" summary under its name. */
function statusLine(opacity: number, maskEnabled: boolean, inverted: boolean, moved: boolean, transformed: boolean) {
  const notes = [`${opacity}%`];
  if (!maskEnabled) notes.push("mask off");
  else if (inverted) notes.push("mask inverted");
  if (moved) notes.push("moved");
  if (transformed) notes.push("mask transformed");
  return notes.join(" · ");
}

/** The scale and angle a mask is carrying, for the reset button's tooltip. */
function transformSummary(transform: ReturnType<typeof maskTransform>) {
  const { scaleX, scaleY, degrees } = transformReadout(transform);
  const angle = Math.round(degrees);
  return `${Math.round(scaleX * 100)}% × ${Math.round(scaleY * 100)}%${angle ? `, ${angle}°` : ""}`;
}

function ThumbnailButton({
  label,
  title,
  selected,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={selected}
      title={title}
      className={cn(
        "h-10 w-12 shrink-0 overflow-hidden rounded-sm bg-stone-100 transition disabled:cursor-not-allowed disabled:opacity-50",
        // The ring is the whole point: it is the only thing on screen that says
        // which of the two an action lands on.
        selected
          ? "outline outline-2 outline-offset-1 outline-accent ring-1 ring-inset ring-white"
          : "border border-stone-300 hover:border-stone-500",
      )}
    >
      {children}
    </button>
  );
}

function MaskThumbnail({ drawing, dimmed }: { drawing: MaskDrawing; dimmed: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rendered = renderMaskThumbnailCanvas(drawing, 128);
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(rendered, 0, 0);
  }, [drawing]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-mask-thumbnail
      className={cn("h-full w-full bg-black object-cover", dimmed && "opacity-30")}
    />
  );
}

function RowButton({
  onClick,
  disabled,
  label,
  title,
  destructive,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  title: string;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "flex h-7 w-6 shrink-0 items-center justify-center rounded text-stone-400 transition disabled:cursor-not-allowed disabled:opacity-25",
        destructive ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-stone-100 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ChipButton({
  onClick,
  disabled,
  pressed,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      className={cn(
        "flex h-7 items-center gap-1 rounded border px-1.5 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40",
        pressed ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white text-stone-600 hover:bg-stone-100",
      )}
    >
      {children}
    </button>
  );
}
