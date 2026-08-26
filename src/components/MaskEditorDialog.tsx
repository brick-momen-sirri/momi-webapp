// Painting the region an Image Editing job may change.
//
// A full-screen overlay rather than a panel control. The mask decides what the
// model is allowed to touch, and judging that needs the picture at a size worth
// looking at -- the settings rail is 320px wide, which is enough for a thumbnail
// and a button and nothing else.
//
// The canvas is drawn by hand rather than through an <img> and CSS transforms. Pan
// and zoom have to agree exactly with where a stroke lands, and one transform that
// both the painting and the display read is how that stays true; two -- a CSS one
// for the image and a maths one for the strokes -- drift the moment either changes
// by a rounding step.

import { Brush, Eraser, Hand, Lasso, LoaderCircle, Maximize2, RotateCcw, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  appendMaskStroke,
  brushRadiusInImagePixels,
  brushRadiusOnScreen,
  brushSettingsFromDrag,
  clamp,
  clearMaskStrokes,
  fitMaskView,
  hasPaintedRegion,
  MAX_BRUSH_RADIUS,
  MAX_ZOOM,
  MIN_ZOOM,
  panMaskView,
  retargetMaskDrawing,
  setMaskSoftness,
  simplifyStrokePoints,
  undoMaskStroke,
  zoomMaskView,
  type BrushSizing,
  type MaskDrawing,
  type MaskPoint,
  type MaskStroke,
  type MaskTool,
  type MaskView,
} from "../features/still-images/maskDrawing";
import {
  currentMaskEditCrop,
  MASK_DRAFT_COLOUR,
  MASK_DRAFT_EDGE,
  MASK_DRAFT_FEATHER_COLOUR,
  renderOverlayCanvas,
} from "../features/still-images/maskRaster";
import { cn } from "../utils/classNames";

type MaskEditorDialogProps = {
  /** Already decoded/composited by the caller, so the editor cannot open blank. */
  image: CanvasImageSource;
  /** Original-image dimensions; the preview source may be intentionally smaller. */
  imageWidth: number;
  imageHeight: number;
  imageName: string;
  drawing: MaskDrawing | undefined;
  onApply: (drawing: MaskDrawing) => void;
  onClose: () => void;
  onDraftChange?: (drawing: MaskDrawing) => void;
  onFinish?: (drawing: MaskDrawing) => void;
  leftPanel?: ReactNode;
  floatingPanel?: ReactNode;
  doneLabel?: string;
  closeLabel?: string;
  finishing?: boolean;
  readOnly?: boolean;
  processing?: boolean;
  processingLabel?: string;
};

const TOOLS: ReadonlyArray<{ tool: MaskTool; label: string; key: string; Icon: typeof Brush }> = [
  { tool: "brush", label: "Brush", key: "B", Icon: Brush },
  { tool: "eraser", label: "Eraser", key: "E", Icon: Eraser },
  { tool: "lasso", label: "Lasso", key: "L", Icon: Lasso },
];

type BrushAdjustment = {
  pointerId: number;
  start: MaskPoint;
  radius: number;
  softness: number;
};

export function MaskEditorDialog({
  image,
  imageWidth,
  imageHeight,
  imageName,
  drawing,
  onApply,
  onClose,
  onDraftChange,
  onFinish,
  leftPanel,
  floatingPanel,
  doneLabel = "Done",
  closeLabel = "Cancel",
  finishing = false,
  readOnly = false,
  processing = false,
  processingLabel = "Processing selected region",
}: MaskEditorDialogProps) {
  const naturalWidth = imageWidth;
  const naturalHeight = imageHeight;

  // Pointer samples stay local while a stroke is in flight. Completed strokes are
  // published to the session so the prompt panel and selected layer stay live;
  // Close therefore preserves work, while Done also finalizes the composite.
  const [draft, setDraft] = useState<MaskDrawing>(() => retargetMaskDrawing(drawing, naturalWidth, naturalHeight));
  const [tool, setTool] = useState<MaskTool>("brush");
  const [sizing, setSizing] = useState<BrushSizing>("image");
  const [sliderRadius, setSliderRadius] = useState(() => Math.max(8, Math.round(Math.min(naturalWidth, naturalHeight) / 24)));
  const [view, setView] = useState<MaskView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [stroke, setStroke] = useState<MaskStroke | undefined>(undefined);
  const [panning, setPanning] = useState(false);
  const [cursor, setCursor] = useState<MaskPoint | undefined>(undefined);
  const [adjustingBrush, setAdjustingBrush] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  // Refs rather than state: the pointer handlers need current values without being
  // torn down and re-registered on every stroke point, and the fit latch must not
  // cause a render of its own.
  const spaceHeld = useRef(false);
  const panFrom = useRef<MaskPoint | undefined>(undefined);
  const brushAdjustment = useRef<BrushAdjustment | undefined>(undefined);
  const fitted = useRef(false);
  const draftChangeRef = useRef(onDraftChange);
  const publishedDraftRef = useRef<MaskDrawing | undefined>(drawing);

  useEffect(() => {
    draftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  // Drafts are published only after React commits them. Pointer samples remain in
  // the editor, while completed strokes make the prompt panel and layer state live.
  useEffect(() => {
    if (publishedDraftRef.current === draft) return;
    publishedDraftRef.current = draft;
    draftChangeRef.current?.(draft);
  }, [draft]);

  const maximumSliderRadius = Math.min(MAX_BRUSH_RADIUS, Math.max(64, Math.round(Math.min(naturalWidth, naturalHeight) / 2)));

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Committed strokes only. The one being drawn is painted straight onto the
  // viewport, so a drag never rebuilds this -- at 4K that is the whole frame budget.
  const overlay = useMemo(() => renderOverlayCanvas(draft), [draft]);
  // Include the stroke still under the pointer so both the red wash and the edit
  // box react during the drag, not one frame after release.
  const liveDrawing = useMemo(
    () => (stroke ? appendMaskStroke(draft, { ...stroke, points: simplifyStrokePoints(stroke.points, stroke.radius) }) : draft),
    [draft, stroke],
  );
  const editRegion = useMemo(() => {
    if (!hasPaintedRegion(liveDrawing)) return {};
    try {
      const crop = currentMaskEditCrop(liveDrawing);
      return crop ? { crop } : {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The edit region cannot be calculated." };
    }
  }, [liveDrawing]);

  const fit = useCallback(() => {
    if (!viewport.width || !viewport.height) return;
    setView(fitMaskView({ width: naturalWidth, height: naturalHeight }, viewport));
  }, [naturalHeight, naturalWidth, viewport]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function apply(size: { width: number; height: number }) {
      setViewport(size);
      // The opening fit, and only that one. Re-fitting on every resize would throw
      // away a zoom the artist set the moment the window moved or a scrollbar
      // appeared -- which is what the button is for.
      if (!fitted.current && size.width > 0 && size.height > 0) {
        fitted.current = true;
        setView(fitMaskView({ width: naturalWidth, height: naturalHeight }, size));
      }
    }

    // Measured directly as well as observed. A ResizeObserver normally delivers an
    // entry when it starts observing, but that delivery rides the rendering
    // lifecycle and does not happen in a document that is not being painted -- and
    // this is the only thing that gives the canvas a size, so if it is skipped the
    // editor opens blank with no second chance. Deferred by a tick rather than read
    // in the effect body so the observer wins when it does fire first.
    const initial = setTimeout(() => {
      const bounds = container.getBoundingClientRect();
      apply({ width: bounds.width, height: bounds.height });
    }, 0);

    const observer = new ResizeObserver(([entry]) => {
      apply({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container);

    return () => {
      clearTimeout(initial);
      observer.disconnect();
    };
  }, [naturalHeight, naturalWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport.width || !viewport.height) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewport.width * ratio);
    canvas.height = Math.round(viewport.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, viewport.width, viewport.height);

    const width = naturalWidth * view.scale;
    const height = naturalHeight * view.scale;
    // Nearest-neighbour past 1:1, so zooming in to clean up an edge shows the
    // pixels being painted rather than an interpolation of them.
    context.imageSmoothingEnabled = view.scale < 1;
    context.drawImage(image, view.offsetX, view.offsetY, width, height);
    context.drawImage(overlay, view.offsetX, view.offsetY, width, height);

    if (stroke) {
      paintDraftStroke(context, stroke, view, draft.softness);
      if (stroke.tool === "eraser") {
        // The eraser removes the red overlay and the already-composited source in
        // one operation. Put the source back behind that transparent path so the
        // artist sees the mask disappear live instead of seeing a clear hole.
        context.save();
        context.globalCompositeOperation = "destination-over";
        context.drawImage(image, view.offsetX, view.offsetY, width, height);
        context.restore();
      }
    }
    if (editRegion.crop) paintEditRegion(context, editRegion.crop, view, naturalWidth, naturalHeight, processing);
    if (!readOnly && cursor && tool !== "lasso" && !panning)
      paintBrushCursor(
        context,
        cursor,
        brushRadiusOnScreen(sliderRadius, sizing, view.scale),
        draft.softness,
        sliderRadius,
        tool,
        adjustingBrush,
      );
  }, [
    adjustingBrush,
    cursor,
    draft.softness,
    editRegion,
    image,
    naturalHeight,
    naturalWidth,
    overlay,
    panning,
    processing,
    readOnly,
    sizing,
    sliderRadius,
    stroke,
    tool,
    view,
    viewport,
  ]);

  // A second transparent canvas lets CSS animate the exact mask shape without
  // rebuilding the 4K source/composite on every animation frame.
  useEffect(() => {
    const canvas = processingCanvasRef.current;
    if (!canvas || !viewport.width || !viewport.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewport.width * ratio);
    canvas.height = Math.round(viewport.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, viewport.width, viewport.height);
    if (!processing) return;
    context.globalAlpha = 0.78;
    context.drawImage(overlay, view.offsetX, view.offsetY, naturalWidth * view.scale, naturalHeight * view.scale);
  }, [naturalHeight, naturalWidth, overlay, processing, view, viewport]);

  const commitStroke = useCallback((finished: MaskStroke) => {
    setDraft((current) =>
      appendMaskStroke(current, { ...finished, points: simplifyStrokePoints(finished.points, finished.radius) }),
    );
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName);
      if (typing) return;

      if (event.key === " ") {
        spaceHeld.current = true;
        // Otherwise the page scrolls under the overlay while the artist pans.
        event.preventDefault();
        return;
      }
      if (readOnly) {
        if (event.key === "Escape") event.preventDefault();
        return;
      }
      if (event.key === "Escape") return onClose();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        return setDraft(undoMaskStroke);
      }
      if (event.key === "Delete" || event.key === "Backspace") return setDraft(clearMaskStrokes);
      if (event.key === "[") return setSliderRadius((value) => clamp(Math.round(value * 0.8), 1, maximumSliderRadius));
      if (event.key === "]") return setSliderRadius((value) => clamp(Math.round(value * 1.25) + 1, 1, maximumSliderRadius));

      const match = TOOLS.find((entry) => entry.key.toLowerCase() === event.key.toLowerCase());
      if (match) setTool(match.tool);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") spaceHeld.current = false;
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [maximumSliderRadius, onClose, readOnly]);

  function viewportPoint(event: { clientX: number; clientY: number }): MaskPoint {
    const bounds = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  }

  function imagePoint(event: { clientX: number; clientY: number }): MaskPoint {
    const point = viewportPoint(event);
    return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const capture = () => event.currentTarget.setPointerCapture?.(event.pointerId);

    if (readOnly && event.button !== 1 && !spaceHeld.current) return;

    if (event.button === 2 && event.altKey && tool !== "lasso") {
      event.preventDefault();
      capture();
      const at = viewportPoint(event);
      brushAdjustment.current = {
        pointerId: event.pointerId,
        start: at,
        radius: sliderRadius,
        softness: draft.softness,
      };
      setCursor(at);
      setAdjustingBrush(true);
      return;
    }

    // Middle button and space are the two pan gestures every editor has; either
    // beats making the artist pick a tool to move the picture.
    if (event.button === 1 || spaceHeld.current) {
      capture();
      setPanning(true);
      panFrom.current = viewportPoint(event);
      return;
    }
    if (event.button !== 0) return;

    event.preventDefault();
    capture();
    setStroke({
      tool,
      radius: brushRadiusInImagePixels(sliderRadius, sizing, view.scale),
      points: [imagePoint(event)],
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const at = viewportPoint(event);

    if (readOnly && !panning) return;

    const adjustment = brushAdjustment.current;
    if (adjustment?.pointerId === event.pointerId) {
      // The physical pointer supplies only deltas during adjustment. The preview
      // stays anchored where the gesture began, so the circle grows and feathers
      // around the subject instead of wandering away from it.
      setCursor(adjustment.start);
      const next = brushSettingsFromDrag(
        adjustment.radius,
        adjustment.softness,
        at.x - adjustment.start.x,
        at.y - adjustment.start.y,
        maximumSliderRadius,
      );
      setSliderRadius(next.radius);
      setDraft((current) => setMaskSoftness(current, next.softness));
      return;
    }

    setCursor(at);

    if (panning) {
      const from = panFrom.current;
      if (from) setView((current) => panMaskView(current, at.x - from.x, at.y - from.y));
      panFrom.current = at;
      return;
    }

    if (!stroke) return;
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length ? coalesced : [event.nativeEvent];
    const points = samples.map(imagePoint);
    setStroke((current) => (current ? { ...current, points: [...current.points, ...points] } : current));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (brushAdjustment.current?.pointerId === event.pointerId) {
      brushAdjustment.current = undefined;
      setAdjustingBrush(false);
      setCursor(viewportPoint(event));
      return;
    }
    setPanning(false);
    panFrom.current = undefined;
    if (stroke) commitStroke(stroke);
    setStroke(undefined);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    brushAdjustment.current = undefined;
    panFrom.current = undefined;
    setAdjustingBrush(false);
    setPanning(false);
    setStroke(undefined);
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const anchor = viewportPoint(event);
    // Multiplicative, so a notch in and a notch out land back where they started.
    const factor = Math.exp(-event.deltaY * 0.0015);
    setView((current) => zoomMaskView(current, anchor, current.scale * factor));
  }

  function zoomBy(factor: number) {
    const anchor = { x: viewport.width / 2, y: viewport.height / 2 };
    setView((current) => zoomMaskView(current, anchor, current.scale * factor));
  }

  const strokeCount = draft.strokes.length;

  return createPortal(
    <div
      className="fixed inset-0 isolate flex flex-col bg-stone-100"
      style={{ zIndex: 2_147_483_647 }}
      role="dialog"
      aria-modal="true"
      aria-busy={processing}
      aria-label={`Paint the region to edit on ${imageName}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 text-stone-900 shadow-sm">
        <div className="mr-2 min-w-0">
          <p className="text-sm font-bold">Current Composite &amp; Mask</p>
          <p className="max-w-48 truncate text-[11px] text-stone-500">{imageName}</p>
        </div>

        {tool === "lasso" ? (
          <p className="text-xs text-stone-500">Draw around the area and release to close the shape.</p>
        ) : (
          <label className="flex items-center gap-2 text-xs font-medium text-stone-600">
            Size
            <input
              type="range"
              min={1}
              max={maximumSliderRadius}
              value={sliderRadius}
              disabled={readOnly}
              onChange={(event) => setSliderRadius(Number(event.target.value))}
              className="w-36 accent-accent"
              aria-label="Brush size"
            />
            <span className="w-12 tabular-nums text-stone-800">{sliderRadius}px</span>
          </label>
        )}

        <label className="flex items-center gap-2 text-xs font-medium text-stone-600">
          Soft
          <input
            type="range"
            min={0}
            max={100}
            value={draft.softness}
            disabled={readOnly}
            onChange={(event) => setDraft((current) => setMaskSoftness(current, Number(event.target.value)))}
            className="w-28 accent-accent"
            aria-label="Mask softness"
          />
          <span className="w-10 tabular-nums text-stone-800">{draft.softness}%</span>
        </label>

        <label
          className="flex items-center gap-1.5 text-xs text-stone-500"
          title="Whether the size above is measured on the image or on your screen"
        >
          <input
            type="checkbox"
            checked={sizing === "screen"}
            disabled={readOnly}
            onChange={(event) => setSizing(event.target.checked ? "screen" : "image")}
            className="accent-accent"
          />
          Fixed on screen
        </label>

        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarButton
            onClick={() => setDraft(undoMaskStroke)}
            disabled={readOnly || !strokeCount}
            title="Undo (Ctrl+Z)"
            label="Undo"
          >
            <RotateCcw className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => setDraft(clearMaskStrokes)}
            disabled={readOnly || !strokeCount}
            title="Clear mask (Del)"
            label="Clear mask"
          >
            <Trash2 className="h-4 w-4" />
          </ToolbarButton>
          <span className="mx-1 h-6 w-px bg-stone-200" />
          <ToolbarButton onClick={() => zoomBy(1 / 1.25)} disabled={view.scale <= MIN_ZOOM} title="Zoom out" label="Zoom out">
            <ZoomOut className="h-4 w-4" />
          </ToolbarButton>
          <span className="w-14 text-center text-xs tabular-nums text-stone-600">{Math.round(view.scale * 100)}%</span>
          <ToolbarButton onClick={() => zoomBy(1.25)} disabled={view.scale >= MAX_ZOOM} title="Zoom in" label="Zoom in">
            <ZoomIn className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={fit} title="Fit to screen" label="Fit to screen">
            <Maximize2 className="h-4 w-4" />
          </ToolbarButton>
          <span className="mx-1 h-6 w-px bg-stone-200" />
          <button
            type="button"
            onClick={onClose}
            disabled={readOnly}
            className="flex h-9 items-center gap-2 rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-600 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <X className="h-4 w-4" />
            {closeLabel}
          </button>
          <button
            type="button"
            onClick={() => (onFinish ? onFinish(draft) : onApply(draft))}
            disabled={finishing || readOnly}
            className="flex h-9 items-center rounded-md bg-accent px-4 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-50"
          >
            {finishing ? "Finishing…" : doneLabel}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {leftPanel ? (
          <aside className="z-20 w-72 shrink-0 overflow-y-auto border-r border-stone-200 bg-stone-50 p-3">{leftPanel}</aside>
        ) : null}
        <div
          ref={containerRef}
          data-testid="mask-editor-viewport"
          data-adjusting-brush={adjustingBrush || undefined}
          data-processing={processing || undefined}
          data-brush-preview-x={cursor?.x}
          data-brush-preview-y={cursor?.y}
          className={cn(
            "relative min-w-0 flex-1 touch-none overflow-hidden bg-stone-200",
            panning ? "cursor-grabbing" : readOnly ? "cursor-default" : tool === "lasso" ? "cursor-crosshair" : "cursor-none",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={() => {
            if (!brushAdjustment.current && !stroke) setCursor(undefined);
          }}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
        >
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ width: viewport.width, height: viewport.height }}
          />
          <canvas
            ref={processingCanvasRef}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 h-full w-full opacity-0 transition-opacity duration-500",
              processing && "opacity-70 motion-safe:animate-pulse",
            )}
            style={{ width: viewport.width, height: viewport.height }}
          />

          {processing && editRegion.crop ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-[5] border-2 border-cyan-300/90 motion-safe:animate-pulse"
              style={{
                left: editRegion.crop.x * view.scale + view.offsetX,
                top: editRegion.crop.y * view.scale + view.offsetY,
                width: editRegion.crop.size * view.scale,
                height: editRegion.crop.size * view.scale,
                boxShadow: "0 0 18px rgba(34, 211, 238, 0.5), inset 0 0 18px rgba(34, 211, 238, 0.14)",
              }}
            />
          ) : null}

          {processing ? (
            <div
              className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-200/80 bg-stone-950/80 px-4 py-2 text-xs font-semibold text-white shadow-xl backdrop-blur"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" />
              {processingLabel}
            </div>
          ) : null}

          <div
            className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-full border border-stone-200/80 bg-white p-1.5 shadow-xl shadow-stone-900/15"
            aria-label="Mask tools"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {TOOLS.map(({ tool: option, label, key, Icon }) => (
              <button
                key={option}
                type="button"
                onClick={() => setTool(option)}
                disabled={readOnly}
                aria-label={label}
                aria-pressed={tool === option}
                title={`${label} (${key})`}
                className={cn(
                  "flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition",
                  tool === option
                    ? "bg-stone-950 text-white shadow-sm"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-900",
                  readOnly && "cursor-not-allowed opacity-40",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
              </button>
            ))}
          </div>
          {floatingPanel ? <div className="absolute bottom-4 right-4 z-20">{floatingPanel}</div> : null}
        </div>
      </div>

      <footer className="flex items-center gap-4 border-t border-stone-200 bg-white px-4 py-2 text-xs text-stone-500">
        <span className="flex items-center gap-1.5">
          <Hand className="h-3.5 w-3.5" />
          Space or middle-drag to pan, scroll to zoom
        </span>
        <span>[ and ] resize the brush</span>
        <span>
          <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
            Alt + right-drag
          </kbd>{" "}
          size ↔ · softness ↕
        </span>
        {editRegion.crop ? (
          <span className="font-semibold tabular-nums text-stone-700">
            Edit region: {editRegion.crop.size} × {editRegion.crop.size}px
          </span>
        ) : editRegion.error ? (
          <span className="font-semibold text-red-600">{editRegion.error}</span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {naturalWidth} x {naturalHeight} - {strokeCount} stroke{strokeCount === 1 ? "" : "s"}
        </span>
      </footer>
    </div>,
    document.body,
  );
}

function ToolbarButton({
  onClick,
  disabled,
  title,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * The stroke under the pointer, drawn straight onto the viewport.
 *
 * Not part of the drawing until the pointer is released, so it is painted here in
 * screen pixels rather than by rebuilding the image-sized overlay on every move.
 * The eraser is an outline instead of a wash: it takes coverage away, and washing
 * red over what is about to be cleared reads as the opposite of what happens.
 */
function paintDraftStroke(context: CanvasRenderingContext2D, stroke: MaskStroke, view: MaskView, softness: number) {
  const points = stroke.points.map((point) => ({
    x: point.x * view.scale + view.offsetX,
    y: point.y * view.scale + view.offsetY,
  }));
  if (!points.length) return;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  if (stroke.tool === "lasso") {
    context.fillStyle = MASK_DRAFT_COLOUR;
    context.strokeStyle = MASK_DRAFT_EDGE;
    context.lineWidth = 1.5;
    context.setLineDash([6, 4]);
    tracePath(context, points, true);
    context.fill();
    context.stroke();
    context.restore();
    return;
  }

  const width = Math.max(1, stroke.radius * 2 * view.scale);
  if (stroke.tool === "eraser") {
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.lineWidth = width;
    context.globalCompositeOperation = "destination-out";
  } else {
    paintBrushPass(context, points, width + 2, MASK_DRAFT_EDGE);
    paintBrushPass(context, points, width, MASK_DRAFT_FEATHER_COLOUR);
    const hardWidth = Math.max(1, width * (1 - (clamp(softness, 0, 100) / 100) * 0.55));
    paintBrushPass(context, points, hardWidth, MASK_DRAFT_COLOUR);
    context.restore();
    return;
  }

  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
  } else {
    tracePath(context, points, false);
    context.stroke();
  }
  context.restore();
}

function paintBrushPass(context: CanvasRenderingContext2D, points: MaskPoint[], width: number, colour: string) {
  context.strokeStyle = colour;
  context.fillStyle = colour;
  context.lineWidth = width;
  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    tracePath(context, points, false);
    context.stroke();
  }
}

function tracePath(context: CanvasRenderingContext2D, points: MaskPoint[], close: boolean) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (close) context.closePath();
}

/** Shade everything outside the exact square sent to the editing model. */
function paintEditRegion(
  context: CanvasRenderingContext2D,
  crop: NonNullable<ReturnType<typeof currentMaskEditCrop>>,
  view: MaskView,
  imageWidth: number,
  imageHeight: number,
  processing = false,
) {
  const imageLeft = view.offsetX;
  const imageTop = view.offsetY;
  const displayedWidth = imageWidth * view.scale;
  const displayedHeight = imageHeight * view.scale;
  const left = crop.x * view.scale + imageLeft;
  const top = crop.y * view.scale + imageTop;
  const size = crop.size * view.scale;
  const right = left + size;
  const bottom = top + size;

  context.save();
  context.fillStyle = "rgba(17, 24, 39, 0.30)";
  context.fillRect(imageLeft, imageTop, displayedWidth, Math.max(0, top - imageTop));
  context.fillRect(imageLeft, bottom, displayedWidth, Math.max(0, imageTop + displayedHeight - bottom));
  context.fillRect(imageLeft, top, Math.max(0, left - imageLeft), size);
  context.fillRect(right, top, Math.max(0, imageLeft + displayedWidth - right), size);

  // A dark keyline keeps the white boundary legible over bright skies and snow.
  context.strokeStyle = "rgba(0, 0, 0, 0.72)";
  context.lineWidth = 4;
  context.strokeRect(left, top, size, size);
  context.strokeStyle = processing ? "rgba(103, 232, 249, 0.98)" : "rgba(255, 255, 255, 0.98)";
  context.lineWidth = 1.5;
  context.strokeRect(left, top, size, size);

  const corner = Math.min(22, Math.max(7, size * 0.08));
  context.strokeStyle = processing ? "rgba(165, 243, 252, 1)" : "rgba(255, 255, 255, 1)";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(left, top + corner);
  context.lineTo(left, top);
  context.lineTo(left + corner, top);
  context.moveTo(right - corner, top);
  context.lineTo(right, top);
  context.lineTo(right, top + corner);
  context.moveTo(right, bottom - corner);
  context.lineTo(right, bottom);
  context.lineTo(right - corner, bottom);
  context.moveTo(left + corner, bottom);
  context.lineTo(left, bottom);
  context.lineTo(left, bottom - corner);
  context.stroke();

  paintCanvasLabel(
    context,
    left + 8,
    top > 34 ? top - 30 : top + 8,
    `${processing ? "PROCESSING" : "EDIT REGION"}  ${crop.size} × ${crop.size} px`,
  );
  context.restore();
}

/** The ring showing what the next stroke will cover, including its soft edge. */
function paintBrushCursor(
  context: CanvasRenderingContext2D,
  at: MaskPoint,
  radius: number,
  softness: number,
  radiusLabel: number,
  tool: MaskTool,
  adjusting: boolean,
) {
  const outerRadius = Math.max(1, radius);
  const hardRadius = Math.max(1, outerRadius * (1 - (clamp(softness, 0, 100) / 100) * 0.82));

  context.save();
  context.beginPath();
  context.arc(at.x, at.y, outerRadius, 0, Math.PI * 2);
  context.strokeStyle = "rgba(0, 0, 0, 0.78)";
  context.lineWidth = 3.5;
  context.stroke();
  context.strokeStyle = "rgba(255, 255, 255, 0.98)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(at.x, at.y, outerRadius, 0, Math.PI * 2);
  context.stroke();

  if (softness > 0 && hardRadius < outerRadius - 2) {
    context.beginPath();
    context.arc(at.x, at.y, hardRadius, 0, Math.PI * 2);
    context.setLineDash([3, 3]);
    context.strokeStyle = "rgba(255, 255, 255, 0.72)";
    context.lineWidth = 1;
    context.stroke();
    context.setLineDash([]);
  }

  context.strokeStyle = tool === "eraser" ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.82)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(at.x - 4, at.y);
  context.lineTo(at.x + 4, at.y);
  context.moveTo(at.x, at.y - 4);
  context.lineTo(at.x, at.y + 4);
  context.stroke();

  if (adjusting) {
    paintCanvasLabel(context, at.x + 18, at.y + 18, `SIZE  ${radiusLabel}px   ·   SOFT  ${softness}%`);
  }
  context.restore();
}

function paintCanvasLabel(context: CanvasRenderingContext2D, x: number, y: number, text: string) {
  context.save();
  context.font = "600 11px ui-sans-serif, system-ui, sans-serif";
  context.textBaseline = "top";
  const width = context.measureText(text).width + 18;
  const height = 26;
  context.fillStyle = "rgba(17, 24, 39, 0.88)";
  roundedRectangle(context, x, y, width, height, 6);
  context.fill();
  context.fillStyle = "rgba(255, 255, 255, 0.98)";
  context.fillText(text, x + 9, y + 7);
  context.restore();
}

function roundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}
