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
  Feather,
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

import {
  editCropHeight,
  editCropWidth,
  layerMaskEnabled,
  layerMaskFeather,
  layerMaskLinked,
  layerOffset,
  layerOpacity,
} from "../features/still-images/imageEditLayers";
import {
  isIdentityTransform,
  maskInverted,
  maskTransform,
  transformReadout,
  type MaskDrawing,
} from "../features/still-images/maskDrawing";
import type { EditSessionCost } from "../features/still-images/editDocument";
import { formatUsd } from "../features/still-images/podRuntimeCost";
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
  onDeselect: () => void;
  onSelect: (layerId: string, target: StillImageEditTarget) => void;
  onToggle: (layerId: string) => void;
  onDelete: (layerId: string) => void;
  onDuplicate: (layerId: string) => void;
  onMove: (layerId: string, direction: -1 | 1) => void;
  onRename: (layerId: string, name: string) => void;
  onOpacityChange: (layerId: string, opacity: number) => void;
  onMaskFeatherChange: (layerId: string, feather: number) => void;
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
  /** What this document has cost so far, counting takes that were replaced. */
  sessionCost?: EditSessionCost;
  disabled?: boolean;
  /**
   * Edits are on the pods, but the panel stays usable.
   *
   * Distinct from `disabled`: a running edit no longer blocks anything, because
   * edits on different regions compose independently. This only says so.
   */
  busy?: boolean;
  processingLabel?: string;
};

export function EditLayersPanel({
  layers,
  activeLayerId,
  activeTarget,
  onNew,
  onDeselect,
  onSelect,
  onToggle,
  onDelete,
  onDuplicate,
  onMove,
  onRename,
  onOpacityChange,
  onMaskFeatherChange,
  onMaskEnabledChange,
  onMaskLinkedChange,
  onResetOffset,
  onInvertMask,
  onClearMask,
  onResetMaskTransform,
  onRegenerate,
  canRegenerate = false,
  regenerateHint,
  sessionCost,
  disabled = false,
  busy = false,
  processingLabel = "Processing selected region",
}: EditLayersPanelProps) {
  // Displayed top-down the way every layer stack is, while order counts upwards.
  const ordered = [...layers].sort((a, b) => b.order - a.order);

  function handleEmptyPanelClick(event: React.MouseEvent<HTMLElement>) {
    if (disabled || !activeLayerId) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.layerPanelEmptySurface === undefined) return;
    onDeselect();
  }

  return (
    <section
      className="rounded-lg border border-line bg-white p-3 shadow-panel"
      aria-disabled={disabled}
      data-testid="edit-layers-panel"
      data-layer-panel-empty-surface=""
      onClick={handleEmptyPanelClick}
    >
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

      {disabled || busy ? (
        <p
          className="mt-3 flex items-center gap-2 rounded-md bg-cyan-50 px-2.5 py-2 text-[11px] font-semibold text-cyan-800"
          role="status"
          data-testid="edit-layers-busy"
        >
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {processingLabel}
          {busy && !disabled ? (
            <span className="ml-auto font-medium text-cyan-700">Keep painting — this runs in the background</span>
          ) : null}
        </p>
      ) : null}

      <div className="mt-3 space-y-1.5" role="list" aria-label="Image edit layers" data-layer-panel-empty-surface="">
        {ordered.map((layer, displayedIndex) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            displayedIndex={displayedIndex}
            // Resolved here, where the sibling layers are in scope. Named rather
            // than id'd because the note is read by someone deciding whether to
            // regenerate; a layer since deleted drops out instead of dangling.
            paintedOverNames={(layer.paintedOver ?? [])
              .map((layerId) => layers.find((candidate) => candidate.id === layerId)?.name)
              .filter((name): name is string => Boolean(name))}
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
            onMaskFeatherChange={onMaskFeatherChange}
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

      {sessionCost && sessionCost.generations > 0 ? <SessionCost cost={sessionCost} /> : null}

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

/**
 * What the session has cost, where the next generation is decided.
 *
 * On the panel rather than a status bar because this is the surface an artist is
 * looking at when they choose to regenerate, and a regeneration is the thing
 * that quietly doubles a layer's cost. The generation count is shown next to the
 * layer count precisely when they differ -- that gap is the redone work, and it
 * is the only part of the bill that is not visible as a layer on screen.
 */
function SessionCost({ cost }: { cost: EditSessionCost }) {
  const redone = cost.generations - cost.layers;
  const floor = cost.unmeasured > 0;
  return (
    <div
      className="mt-3 space-y-1 rounded-md border border-line bg-mist/60 px-2.5 py-2"
      data-testid="edit-session-cost"
      data-generations={cost.generations}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">This session</span>
        <span
          className="ml-auto text-sm font-bold tabular-nums text-ink"
          title={`${cost.credits} credits across ${cost.generations} generation${cost.generations === 1 ? "" : "s"}${
            floor ? `. ${cost.unmeasured} could not be priced, so this is a floor.` : "."
          }`}
        >
          {floor && !cost.usd ? "--" : `${floor ? "≥ " : ""}${formatUsd(cost.usd) ?? "--"}`}
        </span>
      </div>
      {/* The two vendors, apart. Which half is growing is what tells an artist
          whether a session is expensive because the pod is slow or because the
          model has been called a lot -- and only the second is theirs to change. */}
      <div className="flex items-baseline gap-2 text-[10px] tabular-nums text-stone-500">
        <span data-testid="session-pod-cost">Pod {formatUsd(cost.podUsd) ?? "--"}</span>
        <span className="text-stone-300">·</span>
        <span data-testid="session-comfy-cost">Comfy {formatUsd(cost.comfyUsd) ?? "--"}</span>
        <span className="ml-auto">
          {cost.generations} run{cost.generations === 1 ? "" : "s"}
          {redone > 0 ? ` · ${redone} redone` : ""}
        </span>
      </div>
    </div>
  );
}

type LayerRowProps = {
  layer: StillImageEditLayer;
  displayedIndex: number;
  /** Names of the layers that were still running when this one's base was built. */
  paintedOverNames: string[];
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
  | "onMaskFeatherChange"
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
  paintedOverNames,
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
  onMaskFeatherChange,
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
  const feather = layerMaskFeather(layer);
  const maximumFeather = Math.max(
    feather,
    Math.min(500, Math.max(1, Math.round(Math.min(editCropWidth(layer.crop), editCropHeight(layer.crop)) / 2))),
  );
  const maskOn = layerMaskEnabled(layer);
  const linked = layerMaskLinked(layer);
  const offset = layerOffset(layer);
  const moved = offset.x !== 0 || offset.y !== 0;
  const inverted = maskInverted(layer.mask);
  const transform = maskTransform(layer.mask);
  const transformed = !isIdentityTransform(transform);
  const adjustments = adjustmentSummary(opacity, feather, maskOn, inverted, moved, transformed);
  // Named, not id'd: the amber note is read by someone deciding whether to
  // regenerate, and a layer id tells them nothing. A layer that has since been
  // deleted simply drops out rather than showing a dangling id.


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
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onToggle(layer.id)}
          disabled={disabled}
          aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
          aria-pressed={layer.visible}
          className="flex h-8 w-7 shrink-0 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
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

        <button
          type="button"
          onClick={() => onMaskLinkedChange(layer.id, !linked)}
          disabled={disabled}
          className={cn(
            "flex h-8 w-6 shrink-0 items-center justify-center rounded transition disabled:cursor-not-allowed disabled:opacity-45",
            linked ? "text-stone-400 hover:bg-stone-100 hover:text-ink" : "bg-amber-50 text-amber-700",
          )}
          title={linked ? "Mask moves with the layer" : "Mask moves independently"}
          aria-label={`Mask ${linked ? "linked" : "unlinked"} — ${linked ? "unlink" : "link"} ${layer.name}`}
          aria-pressed={linked}
        >
          {linked ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
        </button>

        <ThumbnailButton
          label={`Edit ${layer.name} mask`}
          title="Layer mask — paint, erase and select what this layer reveals"
          selected={active && activeTarget === "mask"}
          disabled={disabled}
          onClick={() => onSelect(layer.id, "mask")}
        >
          <MaskThumbnail drawing={layer.mask} feather={feather} dimmed={!maskOn} />
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
              title={`${layer.name}${adjustments ? ` — ${adjustments}` : ""}\nDouble-click to rename`}
              className="block w-full min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-xs font-bold text-ink">{layer.name}</span>
                {adjustments ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" data-adjusted-marker />
                ) : null}
              </span>
              {/*
                The prompt, not the adjustment summary. Twelve rows all reading
                "100%" answer no question anybody has; the thing an artist scans
                for is which layer was the sky. What has been adjusted is a dot,
                the hover title, and the whole expanded panel once selected.
              */}
              <span className="block truncate text-[10px] text-stone-500">
                {layer.status === "completed" ? layer.prompt.trim() || "Completed edit" : layer.status}
              </span>
              {adjustments ? <span className="sr-only">{adjustments}</span> : null}
            </button>
          )}
        </div>

        <div className="flex shrink-0 flex-col rounded border border-stone-200 bg-white" aria-label={`${layer.name} order`}>
          <RowButton
            onClick={() => onMove(layer.id, 1)}
            disabled={disabled || atTop}
            label={`Move ${layer.name} up`}
            title="Move up"
            compact
          >
            <ChevronUp className="h-3 w-3" />
          </RowButton>
          <RowButton
            onClick={() => onMove(layer.id, -1)}
            disabled={disabled || atBottom}
            label={`Move ${layer.name} down`}
            title="Move down"
            compact
          >
            <ChevronDown className="h-3 w-3" />
          </RowButton>
        </div>
        <span className="sr-only">Layer {displayedIndex + 1}</span>
      </div>

      {active ? (
        <div className="mt-2 space-y-2.5 border-t border-cyan-200/70 pt-2.5">
          <div className="space-y-2 rounded-md border border-stone-200 bg-stone-50/80 p-2">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400">Adjustments</p>
            <LayerSlider
              label="Opacity"
              value={opacity}
              maximum={100}
              suffix="%"
              disabled={disabled}
              ariaLabel={`${layer.name} opacity`}
              onChange={(value) => onOpacityChange(layer.id, value)}
            />
            <LayerSlider
              label="Feather"
              icon={<Feather className="h-3 w-3" />}
              value={feather}
              maximum={maximumFeather}
              suffix="px"
              disabled={disabled}
              ariaLabel={`${layer.name} mask feather`}
              onChange={(value) => onMaskFeatherChange(layer.id, value)}
            />
          </div>

          <div>
            <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400">Mask</p>
            <div className="flex flex-wrap items-center gap-1">
              <ChipButton
                onClick={() => onMaskEnabledChange(layer.id, !maskOn)}
                disabled={disabled}
                pressed={!maskOn}
                title={maskOn ? "Turn the mask off — the whole layer shows" : "Turn the mask back on"}
              >
                <CircleOff className="h-3 w-3 shrink-0" />
                {maskOn ? "Disable mask" : "Mask off"}
              </ChipButton>
              {onInvertMask ? (
                <ChipButton onClick={onInvertMask} disabled={disabled} pressed={inverted} title="Invert the mask">
                  <Contrast className="h-3 w-3 shrink-0" />
                  Invert
                </ChipButton>
              ) : null}
              {onClearMask ? (
                <ChipButton onClick={onClearMask} disabled={disabled} title="Clear the mask">
                  <Trash2 className="h-3 w-3 shrink-0" />
                  Clear
                </ChipButton>
              ) : null}
              {moved ? (
                <ChipButton
                  onClick={() => onResetOffset(layer.id)}
                  disabled={disabled}
                  title={`Put the layer back at its generated position (${offset.x >= 0 ? "+" : ""}${Math.round(offset.x)}, ${offset.y >= 0 ? "+" : ""}${Math.round(offset.y)} px)`}
                >
                  <RotateCcw className="h-3 w-3 shrink-0" />
                  Reset move
                </ChipButton>
              ) : null}
              {transformed && onResetMaskTransform ? (
                <ChipButton
                  onClick={onResetMaskTransform}
                  disabled={disabled}
                  title={`Put the mask back to the shape it was painted (${transformSummary(transform)})`}
                >
                  <Scaling className="h-3 w-3 shrink-0" />
                  Reset transform
                </ChipButton>
              ) : null}
            </div>
          </div>

          {paintedOverNames.length ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-900">
              Generated while {paintedOverNames.join(" and ")} {paintedOverNames.length === 1 ? "was" : "were"} still
              running, so where they meet this layer, the model was working from the picture without{" "}
              {paintedOverNames.length === 1 ? "that edit" : "those edits"}. Regenerate to build it on the finished
              composite.
            </p>
          ) : null}

          <div>
            <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400">Layer actions</p>
            <div className="grid grid-cols-2 gap-1.5">
              {onRegenerate ? (
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={disabled || !canRegenerate}
                  title={canRegenerate ? "Run this layer's edit again against its frozen base" : regenerateHint}
                  className="col-span-2 flex h-8 items-center justify-center gap-1.5 rounded-md border border-accent/60 bg-white px-2 text-[11px] font-bold text-accent transition hover:bg-cyan-50 disabled:cursor-not-allowed disabled:border-line disabled:text-stone-400"
                >
                  <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                  Regenerate this layer
                </button>
              ) : null}
              <LayerActionButton onClick={() => onDuplicate(layer.id)} disabled={disabled}>
                <Copy className="h-3.5 w-3.5 shrink-0" />
                Duplicate
              </LayerActionButton>
              <LayerActionButton onClick={() => onDelete(layer.id)} disabled={disabled} destructive>
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                Delete
              </LayerActionButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What has been changed about this layer, or nothing at all.
 *
 * Empty for a layer sitting exactly as it was generated, which is most of them --
 * that is what lets the row show a marker only when there is something to mark,
 * instead of a summary that reads the same on every untouched layer.
 */
function adjustmentSummary(
  opacity: number,
  feather: number,
  maskEnabled: boolean,
  inverted: boolean,
  moved: boolean,
  transformed: boolean,
) {
  const notes: string[] = [];
  if (opacity !== 100) notes.push(`${opacity}% opacity`);
  if (feather) notes.push(`${feather}px feather`);
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

function MaskThumbnail({ drawing, feather, dimmed }: { drawing: MaskDrawing; feather: number; dimmed: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rendered = renderMaskThumbnailCanvas(drawing, 128, feather);
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(rendered, 0, 0);
  }, [drawing, feather]);

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
  compact,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  title: string;
  destructive?: boolean;
  compact?: boolean;
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
        "flex shrink-0 items-center justify-center rounded text-stone-500 transition disabled:cursor-not-allowed disabled:opacity-45",
        compact ? "h-[17px] w-6" : "h-7 w-7",
        destructive ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-stone-100 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function LayerSlider({
  label,
  icon,
  value,
  maximum,
  suffix,
  disabled,
  ariaLabel,
  onChange,
}: {
  label: string;
  icon?: React.ReactNode;
  value: number;
  maximum: number;
  suffix: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[4.25rem_minmax(0,1fr)_3.25rem] items-center gap-2 text-[11px] font-semibold text-stone-600">
      <span className="flex items-center gap-1">
        {icon}
        {label}
      </span>
      <input
        type="range"
        min={0}
        max={maximum}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 accent-accent disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={ariaLabel}
      />
      <span className="text-right tabular-nums text-stone-800">
        {value}
        {suffix}
      </span>
    </label>
  );
}

function LayerActionButton({
  onClick,
  disabled,
  destructive,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-8 items-center justify-center gap-1.5 rounded-md border bg-white px-2 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40",
        destructive
          ? "border-red-200 text-red-600 hover:bg-red-50"
          : "border-stone-300 text-stone-600 hover:bg-stone-100 hover:text-ink",
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
