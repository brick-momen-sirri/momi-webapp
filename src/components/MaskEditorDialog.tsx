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

import {
  Brush,
  Contrast,
  Download,
  Eraser,
  Hand,
  Lasso,
  LoaderCircle,
  Maximize2,
  Move,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  RotateCw,
  Scaling,
  Scan,
  Square,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
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
  boxCorners,
  composeTransforms,
  IDENTITY_TRANSFORM,
  invertMaskDrawing,
  invertTransform,
  isIdentityTransform,
  marqueeSelection,
  maskGeometryBounds,
  maskTransform,
  maskCropAspect,
  maskCropMargin,
  maskInverted,
  MAX_BRUSH_RADIUS,
  MAX_ZOOM,
  MIN_ZOOM,
  panMaskView,
  retargetMaskDrawing,
  setMaskCropAspect,
  setMaskCropMargin,
  setMaskRectangleSelection,
  setMaskSoftness,
  setMaskTransform,
  simplifyStrokePoints,
  transformFromHandleDrag,
  transformPoint,
  transformReadout,
  viewportPointFromImage,
  zoomMaskView,
  type BrushSizing,
  type MaskBox,
  type MaskDrawing,
  type MaskPoint,
  type MaskRectangleSelection,
  type MaskStroke,
  type MaskTool,
  type MaskTransform,
  type MaskView,
  type TransformHandle,
} from "../features/still-images/maskDrawing";
import { editCropHeight, editCropWidth } from "../features/still-images/imageEditLayers";
import type { StillImageEditTarget } from "../features/still-images/stillImageCategories";
import type { StillImageEditCrop } from "../types";
import {
  currentMaskEditCrop,
  MASK_DRAFT_COLOUR,
  MASK_DRAFT_EDGE,
  MASK_DRAFT_FEATHER_COLOUR,
  renderOverlayCanvas,
} from "../features/still-images/maskRaster";
import { cn } from "../utils/classNames";

/**
 * The selected layer, as the canvas needs to know it.
 *
 * Passed in rather than read from the form so the editor stays a controlled
 * component: it knows which half of the layer is armed and can move it, and it
 * knows nothing about how layers are stored. Absent means no layer is selected
 * and the drawing is the region for the next edit, which is the workflow the
 * editor had before layers had masks of their own.
 */
export type EditorLayerContext = {
  layerId: string;
  name: string;
  target: StillImageEditTarget;
  crop: StillImageEditCrop;
  opacity: number;
  visible: boolean;
  maskEnabled: boolean;
  maskLinked: boolean;
  offset: MaskPoint;
  onTargetChange: (target: StillImageEditTarget) => void;
  /** Committed once per gesture, in original-image pixels. */
  onMoveBy: (delta: MaskPoint) => void;
};

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
  onExportPsd?: () => void | Promise<void>;
  psdExportAvailable?: boolean;
  exportingPsd?: boolean;
  psdExportError?: string;
  layerContext?: EditorLayerContext;
};

type EditorTool = MaskTool | "rectangle" | "move" | "transform";

// Photoshop's own letters, minus the ones that would collide with the browser.
// R is kept as a second key for the marquee because that is what this editor
// shipped with and muscle memory is the whole point of copying the shortcuts.
const TOOLS: ReadonlyArray<{ tool: EditorTool; label: string; key: string; alternateKey?: string; Icon: typeof Brush }> = [
  { tool: "move", label: "Move", key: "V", Icon: Move },
  { tool: "rectangle", label: "Rectangle selection", key: "M", alternateKey: "R", Icon: Scan },
  { tool: "brush", label: "Brush", key: "B", Icon: Brush },
  { tool: "eraser", label: "Eraser", key: "E", Icon: Eraser },
  { tool: "lasso", label: "Lasso", key: "L", Icon: Lasso },
  { tool: "transform", label: "Free transform", key: "T", Icon: Scaling },
];

/** Everything that acts on the mask rather than on the layer's pixels. */
const MASK_TOOLS: ReadonlyArray<EditorTool> = ["rectangle", "brush", "eraser", "lasso", "transform"];

/** Screen pixels within which a grip is considered grabbed. */
const HANDLE_RADIUS = 11;
/** How far the rotation knob sits beyond the top edge, in screen pixels. */
const ROTATE_KNOB_OFFSET = 28;

/**
 * A marquee drag in progress.
 *
 * `current + shift` is always the pointer: Space accumulates into `shift` while
 * the rectangle is being carried, and ordinary movement writes `current` back
 * out of it. Holding that invariant is what lets Space be pressed and released
 * mid-drag without the rectangle jumping.
 */
type MarqueeDragState = {
  pointerId: number;
  origin: MaskPoint;
  current: MaskPoint;
  shift: MaskPoint;
  spaceAnchor?: MaskPoint;
  fromCentre: boolean;
  square: boolean;
};

type MoveDragState = { pointerId: number; from: MaskPoint; delta: MaskPoint };

/**
 * A free-transform drag in progress.
 *
 * The box and the transform underneath it are captured once at mouse-down, so
 * every frame of the drag is computed from the same starting state rather than
 * from the previous frame -- which is what stops a long gesture accumulating
 * drift, and what lets Alt and Shift be pressed and released part-way through.
 */
type TransformDragState = {
  pointerId: number;
  handle: TransformHandle;
  box: MaskBox;
  base: MaskTransform;
  from: MaskPoint;
};

type MaskHistory = { past: MaskDrawing[]; future: MaskDrawing[] };

/** Steps kept in each direction. Fifty is more than a session of masking needs. */
const HISTORY_DEPTH = 49;

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
  onExportPsd,
  psdExportAvailable = false,
  exportingPsd = false,
  psdExportError,
  layerContext,
}: MaskEditorDialogProps) {
  const naturalWidth = imageWidth;
  const naturalHeight = imageHeight;

  // Pointer samples stay local while a stroke is in flight. Completed strokes are
  // published to the session so the prompt panel and selected layer stay live;
  // Close therefore preserves work, while Done also finalizes the composite.
  const [draft, setDraft] = useState<MaskDrawing>(() => retargetMaskDrawing(drawing, naturalWidth, naturalHeight));
  // Undo and redo are the editor's own, not the session's: they wind the drawing
  // on the canvas back and forth, which is the only thing a stroke changed.
  const [history, setHistory] = useState<MaskHistory>({ past: [], future: [] });
  const [chosenTool, setChosenTool] = useState<EditorTool>("rectangle");
  const [sizing, setSizing] = useState<BrushSizing>("image");
  const [sliderRadius, setSliderRadius] = useState(() => Math.max(8, Math.round(Math.min(naturalWidth, naturalHeight) / 24)));
  const [view, setView] = useState<MaskView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [stroke, setStroke] = useState<MaskStroke | undefined>(undefined);
  const [panning, setPanning] = useState(false);
  const [cursor, setCursor] = useState<MaskPoint | undefined>(undefined);
  const [adjustingBrush, setAdjustingBrush] = useState(false);
  const [selectionPreview, setSelectionPreview] = useState<MaskRectangleSelection | undefined>(undefined);
  // Moving is previewed as an outline and committed on release. Recompositing a
  // multi-layer 4K document on every pointer sample is not a frame budget, and a
  // ghost that tracks the cursor exactly is honest about where it will land.
  const [moveDelta, setMoveDelta] = useState<MaskPoint | undefined>(undefined);
  // The delta the live transform gesture is adding, in image coordinates. The
  // committed transform is already baked into the overlay, so this is applied as
  // a matrix over that cached bitmap rather than by rebuilding it each frame.
  const [transformPreview, setTransformPreview] = useState<MaskTransform | undefined>(undefined);
  const [hoveredHandle, setHoveredHandle] = useState<TransformHandle | undefined>(undefined);

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
  const selectionDrag = useRef<MarqueeDragState | undefined>(undefined);
  const moveDrag = useRef<MoveDragState | undefined>(undefined);
  const transformDrag = useRef<TransformDragState | undefined>(undefined);
  const pointerImage = useRef<MaskPoint | undefined>(undefined);
  const layerContextRef = useRef(layerContext);
  // Mirrors of the two pieces of state undo has to read and write together.
  const draftRef = useRef(draft);
  const historyRef = useRef(history);
  const fitted = useRef(false);
  const draftChangeRef = useRef(onDraftChange);
  const publishedDraftRef = useRef<MaskDrawing | undefined>(drawing);
  const applyingExternalDraftRef = useRef(false);

  useEffect(() => {
    draftChangeRef.current = onDraftChange;
    layerContextRef.current = layerContext;
  }, [layerContext, onDraftChange]);

  // Every other writer of the draft -- strokes in flight, an external reset, a
  // softness drag -- goes through setDraft, so the mirror is refreshed from the
  // committed value rather than at each call site.
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // What every tool acts on. With no layer selected the drawing is the region for
  // the next edit, which behaves exactly like a mask and is labelled as itself.
  const target: StillImageEditTarget = layerContext?.target ?? "mask";
  const editingRegion = !layerContext;

  /**
   * Record a change to the drawing, with a step on the undo stack.
   *
   * Driven from mirrors rather than from state updaters, because the drawing and
   * its history have to move together and a setState inside another setState's
   * updater is a side effect in a place React is allowed to run twice. Writing
   * the mirrors first also means two undos in the same keypress burst both land
   * instead of the second reading the first one's stale state.
   *
   * Continuous gestures -- a softness drag, a slider -- bypass this and set the
   * draft directly, so one drag is one undo step rather than four hundred.
   */
  const pushHistory = useCallback((next: { past: MaskDrawing[]; future: MaskDrawing[] }) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const applyDraft = useCallback((next: MaskDrawing) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const commitDraft = useCallback(
    (change: (current: MaskDrawing) => MaskDrawing) => {
      const current = draftRef.current;
      const next = change(current);
      if (next === current) return;
      pushHistory({ past: [...historyRef.current.past.slice(-HISTORY_DEPTH), current], future: [] });
      applyDraft(next);
    },
    [applyDraft, pushHistory],
  );

  const undo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (!past.length) return;
    pushHistory({ past: past.slice(0, -1), future: [draftRef.current, ...future.slice(0, HISTORY_DEPTH)] });
    applyDraft(past[past.length - 1]);
  }, [applyDraft, pushHistory]);

  const redo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (!future.length) return;
    pushHistory({ past: [...past.slice(-HISTORY_DEPTH), draftRef.current], future: future.slice(1) });
    applyDraft(future[0]);
  }, [applyDraft, pushHistory]);

  /**
   * Choose a tool, and keep the armed half of the layer honest about it.
   *
   * Painting cannot change generated pixels here -- the model owns those -- so
   * reaching for a brush while the content is armed means the mask. Switching the
   * target rather than refusing the stroke keeps the gesture working, and the ring
   * in the Layers panel moves at the same moment so it is never a silent change.
   */
  const selectTool = useCallback((option: EditorTool) => {
    const context = layerContextRef.current;
    if (option === "move" && !context) return;
    if (option !== "move" && context?.target === "content") context.onTargetChange("mask");
    setChosenTool(option);
  }, []);

  /**
   * The tool actually in force.
   *
   * Derived rather than corrected after the fact, so the toolbar can never show
   * one tool for a render while a different one is armed. Arming the pixels puts
   * Move up because nothing else here can change generated pixels, and with no
   * layer selected there is nothing to move.
   */
  const tool: EditorTool =
    target === "content" && MASK_TOOLS.includes(chosenTool)
      ? "move"
      : !layerContext && chosenTool === "move"
        ? "rectangle"
        : chosenTool;

  // Most drawing changes originate here and arrive back as the same object, so
  // they need no synchronisation. Completion is different: the form clears its
  // draft from outside this mounted dialog after saving the generated layer.
  // Adopt that empty drawing without publishing it back and resurrecting a mask.
  useEffect(() => {
    if (publishedDraftRef.current === drawing) return;
    const next = retargetMaskDrawing(drawing, naturalWidth, naturalHeight);
    applyingExternalDraftRef.current = true;
    publishedDraftRef.current = next;
    setDraft(next);
    draftRef.current = next;
    historyRef.current = { past: [], future: [] };
    setHistory(historyRef.current);
    setStroke(undefined);
    setCursor(undefined);
    setAdjustingBrush(false);
    brushAdjustment.current = undefined;
    selectionDrag.current = undefined;
    moveDrag.current = undefined;
    transformDrag.current = undefined;
    setSelectionPreview(undefined);
    setMoveDelta(undefined);
    setTransformPreview(undefined);
    setHoveredHandle(undefined);
  }, [drawing, naturalHeight, naturalWidth]);

  // Drafts are published only after React commits them. Pointer samples remain in
  // the editor, while completed strokes make the prompt panel and layer state live.
  useEffect(() => {
    if (applyingExternalDraftRef.current) {
      applyingExternalDraftRef.current = false;
      return;
    }
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
  const overlay = useMemo(() => renderOverlayCanvas(draft.selection ? { ...draft, selection: undefined } : draft), [draft]);
  // Include the stroke still under the pointer so both the red wash and the edit
  // box react during the drag, not one frame after release.
  const liveDrawing = useMemo(() => {
    if (selectionPreview) return setMaskRectangleSelection(draft, selectionPreview);
    return stroke ? appendMaskStroke(draft, { ...stroke, points: simplifyStrokePoints(stroke.points, stroke.radius) }) : draft;
  }, [draft, selectionPreview, stroke]);
  const editRegion = useMemo(() => {
    if (!hasPaintedRegion(liveDrawing)) return {};
    try {
      const crop = currentMaskEditCrop(liveDrawing);
      return crop ? { crop } : {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The edit region cannot be calculated." };
    }
  }, [liveDrawing]);

  // A chained mask is dragged by either half of the layer; an unchained one only
  // moves when it is the half that is armed. The ghost has to say which.
  // Depended on by the canvas effect instead of the whole context: the parent
  // rebuilds that object on every keystroke in the prompt, and redrawing a 4K
  // composite each time is not something a text field should cost.
  const layerCrop = layerContext?.crop;
  const maskFollowsMove = !(target === "content" && layerContext && !layerContext.maskLinked);
  const contentFollowsMove = !(target === "mask" && layerContext && !layerContext.maskLinked);

  /**
   * The free transform's bounding box, in screen pixels.
   *
   * The mask's own upright box, carried through the committed transform and then
   * through whatever the current drag is adding, so the box rotates and stretches
   * with the mask instead of being an upright rectangle drawn around it.
   */
  const transformBox = useMemo(() => {
    if (tool !== "transform") return undefined;
    const box = maskGeometryBounds(draft);
    if (!box) return undefined;
    const committed = maskTransform(draft);
    const applied = transformPreview ? composeTransforms(transformPreview, committed) : committed;
    const corners = boxCorners(box).map((corner) => viewportPointFromImage(view, transformPoint(applied, corner)));
    return { box, corners, handles: handlePositions(corners) };
  }, [draft, tool, transformPreview, view]);

  const transformBoxRef = useRef(transformBox);
  useEffect(() => {
    transformBoxRef.current = transformBox;
  }, [transformBox]);

  // Alt and Shift change what a transform drag means without the pointer moving,
  // so their state has to be readable from the key handlers too.
  const modifiers = useRef({ alt: false, shift: false });

  /** What this gesture has changed, as the box reports it while it is dragged. */
  const transformSummary = useMemo(() => {
    if (!transformPreview) return undefined;
    const { scaleX, scaleY, degrees } = transformReadout(transformPreview);
    const angle = Math.round(degrees);
    return `${Math.round(scaleX * 100)}% x ${Math.round(scaleY * 100)}%   ${angle >= 0 ? "+" : "-"}${Math.abs(angle)} deg`;
  }, [transformPreview]);

  const applyTransformDrag = useCallback((drag: TransformDragState, to: MaskPoint) => {
    const next = transformFromHandleDrag({
      handle: drag.handle,
      box: drag.box,
      base: drag.base,
      from: drag.from,
      to,
      fromCentre: modifiers.current.alt,
      proportional: modifiers.current.shift,
    });
    const inverse = invertTransform(drag.base);
    setTransformPreview(inverse ? composeTransforms(next, inverse) : IDENTITY_TRANSFORM);
    return next;
  }, []);

  const cancelGesture = useCallback(() => {
    const active = Boolean(transformDrag.current || moveDrag.current || selectionDrag.current || stroke);
    transformDrag.current = undefined;
    moveDrag.current = undefined;
    selectionDrag.current = undefined;
    setTransformPreview(undefined);
    setMoveDelta(undefined);
    setSelectionPreview(undefined);
    setStroke(undefined);
    return active;
  }, [stroke]);

  const marqueePreview = useCallback(
    (drag: MarqueeDragState) =>
      marqueeSelection(
        { origin: drag.origin, current: drag.current, shift: drag.shift, fromCentre: drag.fromCentre, square: drag.square },
        naturalWidth,
        naturalHeight,
      ),
    [naturalHeight, naturalWidth],
  );

  const nudgeLayer = useCallback((deltaX: number, deltaY: number) => {
    layerContextRef.current?.onMoveBy({ x: deltaX, y: deltaY });
  }, []);

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
    const ghostX = maskFollowsMove ? (moveDelta?.x ?? 0) * view.scale : 0;
    const ghostY = maskFollowsMove ? (moveDelta?.y ?? 0) * view.scale : 0;
    if (selectionPreview) {
      // The marquee being dragged replaces the mask, so the old wash is not drawn.
    } else if (transformPreview) {
      // Same cached overlay, through the gesture's matrix. Rebuilding the ink at
      // image resolution on every pointer sample is the thing this avoids.
      context.save();
      context.translate(view.offsetX, view.offsetY);
      context.scale(view.scale, view.scale);
      context.transform(
        transformPreview.a,
        transformPreview.b,
        transformPreview.c,
        transformPreview.d,
        transformPreview.e,
        transformPreview.f,
      );
      context.drawImage(overlay, 0, 0, naturalWidth, naturalHeight);
      context.restore();
    } else {
      context.drawImage(overlay, view.offsetX + ghostX, view.offsetY + ghostY, width, height);
    }

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
    const settled = !moveDelta && !transformPreview;
    if (editRegion.crop && settled) paintEditRegion(context, editRegion.crop, view, naturalWidth, naturalHeight, processing);
    if (liveDrawing.selection && settled) {
      paintRectangleSelection(context, liveDrawing.selection, maskTransform(liveDrawing), view, processing);
    }
    if (moveDelta && layerCrop) paintMoveGhost(context, layerCrop, view, moveDelta, contentFollowsMove, target);
    if (transformBox && !readOnly) {
      paintTransformBox(context, transformBox.corners, transformBox.handles, hoveredHandle, transformSummary);
    }
    if (!readOnly && cursor && (tool === "brush" || tool === "eraser") && !panning)
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
    contentFollowsMove,
    cursor,
    draft.softness,
    editRegion,
    hoveredHandle,
    image,
    layerCrop,
    liveDrawing,
    maskFollowsMove,
    moveDelta,
    naturalHeight,
    naturalWidth,
    overlay,
    panning,
    processing,
    readOnly,
    sizing,
    sliderRadius,
    selectionPreview,
    stroke,
    target,
    tool,
    transformBox,
    transformPreview,
    transformSummary,
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
    const processingOverlay = draft.selection ? renderOverlayCanvas(draft) : overlay;
    context.drawImage(processingOverlay, view.offsetX, view.offsetY, naturalWidth * view.scale, naturalHeight * view.scale);
  }, [draft, naturalHeight, naturalWidth, overlay, processing, view, viewport]);

  const commitStroke = useCallback(
    (finished: MaskStroke) => {
      commitDraft((current) =>
        appendMaskStroke(current, { ...finished, points: simplifyStrokePoints(finished.points, finished.radius) }),
      );
    },
    [commitDraft],
  );

  // Photoshop's shortcuts, restricted to the ones this editor can honour without
  // fighting the browser. Anything the browser owns outright -- Ctrl+N, Ctrl+W,
  // Ctrl+T -- is deliberately absent rather than intercepted.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const typing =
        event.target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA"].includes(event.target.tagName) || event.target.isContentEditable);
      if (typing) return;

      if (event.key === " ") {
        spaceHeld.current = true;
        // Space over a marquee in flight carries the rectangle instead of panning:
        // it is the same gesture Photoshop uses to reposition a selection you are
        // still drawing.
        const carrying = selectionDrag.current;
        if (carrying && !carrying.spaceAnchor && pointerImage.current) carrying.spaceAnchor = pointerImage.current;
        // Otherwise the page scrolls under the overlay while the artist pans.
        event.preventDefault();
        return;
      }

      // Alt and Shift change what a marquee or a transform already in flight
      // means, so they have to redraw it even though the pointer has not moved.
      if (event.key === "Alt" || event.key === "Shift") {
        if (event.key === "Alt") modifiers.current.alt = true;
        else modifiers.current.shift = true;
        const drag = selectionDrag.current;
        const transforming = transformDrag.current;
        if (!drag && !transforming) return;
        event.preventDefault();
        if (drag) {
          if (event.key === "Alt") drag.fromCentre = true;
          else drag.square = true;
          setSelectionPreview(marqueePreview(drag));
        }
        if (transforming && pointerImage.current) applyTransformDrag(transforming, pointerImage.current);
        return;
      }

      if (readOnly) {
        if (event.key === "Escape") event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        // A gesture in flight is what Escape is for; only an idle editor closes.
        if (cancelGesture()) return event.preventDefault();
        return onClose();
      }

      const accelerator = event.ctrlKey || event.metaKey;
      if (accelerator && event.key.toLowerCase() === "z") {
        event.preventDefault();
        return event.shiftKey ? redo() : undo();
      }
      if (accelerator && event.key.toLowerCase() === "y") {
        event.preventDefault();
        return redo();
      }
      if (accelerator && event.key.toLowerCase() === "d") {
        // Deselect drops the rectangle and leaves painted strokes alone, which is
        // what Ctrl+D does everywhere else.
        event.preventDefault();
        return commitDraft((current) => (current.selection ? setMaskRectangleSelection(current, undefined) : current));
      }
      if (accelerator && event.key.toLowerCase() === "i") {
        event.preventDefault();
        return commitDraft(invertMaskDrawing);
      }
      if (accelerator) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        return commitDraft(clearMaskStrokes);
      }
      if (event.key === "[") return setSliderRadius((value) => clamp(Math.round(value * 0.8), 1, maximumSliderRadius));
      if (event.key === "]") return setSliderRadius((value) => clamp(Math.round(value * 1.25) + 1, 1, maximumSliderRadius));

      if (event.key.startsWith("Arrow") && layerContextRef.current) {
        const step = event.shiftKey ? 10 : 1;
        event.preventDefault();
        if (event.key === "ArrowLeft") return nudgeLayer(-step, 0);
        if (event.key === "ArrowRight") return nudgeLayer(step, 0);
        if (event.key === "ArrowUp") return nudgeLayer(0, -step);
        if (event.key === "ArrowDown") return nudgeLayer(0, step);
      }

      const pressed = event.key.toLowerCase();
      const match = TOOLS.find((entry) => entry.key.toLowerCase() === pressed || entry.alternateKey?.toLowerCase() === pressed);
      if (match) selectTool(match.tool);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") {
        spaceHeld.current = false;
        if (selectionDrag.current) selectionDrag.current.spaceAnchor = undefined;
        return;
      }
      if (event.key === "Alt" || event.key === "Shift") {
        if (event.key === "Alt") modifiers.current.alt = false;
        else modifiers.current.shift = false;
        const drag = selectionDrag.current;
        const transforming = transformDrag.current;
        if (drag) {
          if (event.key === "Alt") drag.fromCentre = false;
          else drag.square = false;
          setSelectionPreview(marqueePreview(drag));
        }
        if (transforming && pointerImage.current) applyTransformDrag(transforming, pointerImage.current);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    applyTransformDrag,
    cancelGesture,
    commitDraft,
    marqueePreview,
    maximumSliderRadius,
    nudgeLayer,
    onClose,
    readOnly,
    redo,
    selectTool,
    undo,
  ]);

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

    if (event.button === 2 && event.altKey && (tool === "brush" || tool === "eraser")) {
      event.preventDefault();
      capture();
      const at = viewportPoint(event);
      brushAdjustment.current = {
        pointerId: event.pointerId,
        start: at,
        radius: sliderRadius,
        softness: draft.softness,
      };
      pushHistory({ past: [...historyRef.current.past.slice(-HISTORY_DEPTH), draft], future: [] });
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
    if (tool === "transform") {
      // Only the grips are live. Dragging the middle of the box would be a move,
      // and Move is its own tool with its own rules about the layer's chain.
      const box = transformBoxRef.current;
      const handle = box ? handleAt(box.handles, viewportPoint(event)) : undefined;
      if (!box || !handle) return;
      modifiers.current = { alt: event.altKey, shift: event.shiftKey };
      transformDrag.current = {
        pointerId: event.pointerId,
        handle,
        box: box.box,
        base: maskTransform(draft),
        from: imagePoint(event),
      };
      setTransformPreview(IDENTITY_TRANSFORM);
      return;
    }
    if (tool === "move") {
      if (!layerContextRef.current) return;
      moveDrag.current = { pointerId: event.pointerId, from: imagePoint(event), delta: { x: 0, y: 0 } };
      setMoveDelta({ x: 0, y: 0 });
      return;
    }
    if (tool === "rectangle") {
      const at = imagePoint(event);
      selectionDrag.current = {
        pointerId: event.pointerId,
        origin: at,
        current: at,
        shift: { x: 0, y: 0 },
        fromCentre: event.altKey,
        square: event.shiftKey,
      };
      pointerImage.current = at;
      setSelectionPreview(undefined);
      return;
    }
    setStroke({
      tool,
      radius: brushRadiusInImagePixels(sliderRadius, sizing, view.scale),
      points: [imagePoint(event)],
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const at = viewportPoint(event);

    if (readOnly && !panning) return;

    const transforming = transformDrag.current;
    if (transforming?.pointerId === event.pointerId) {
      const point = imagePoint(event);
      pointerImage.current = point;
      modifiers.current = { alt: event.altKey, shift: event.shiftKey };
      applyTransformDrag(transforming, point);
      setCursor(at);
      return;
    }

    if (tool === "transform") {
      const box = transformBoxRef.current;
      setHoveredHandle(box ? handleAt(box.handles, at) : undefined);
    }

    const selecting = selectionDrag.current;
    if (selecting?.pointerId === event.pointerId) {
      const point = imagePoint(event);
      pointerImage.current = point;
      selecting.fromCentre = event.altKey;
      selecting.square = event.shiftKey;
      if (spaceHeld.current) {
        // Carry the whole rectangle. `current` is left where it was so the size
        // cannot change, and the shift keeps `current + shift` on the pointer.
        const anchor = selecting.spaceAnchor ?? point;
        selecting.shift = { x: selecting.shift.x + (point.x - anchor.x), y: selecting.shift.y + (point.y - anchor.y) };
        selecting.spaceAnchor = point;
      } else {
        selecting.spaceAnchor = undefined;
        selecting.current = { x: point.x - selecting.shift.x, y: point.y - selecting.shift.y };
      }
      setSelectionPreview(marqueePreview(selecting));
      setCursor(at);
      return;
    }

    const moving = moveDrag.current;
    if (moving?.pointerId === event.pointerId) {
      const point = imagePoint(event);
      moving.delta = { x: point.x - moving.from.x, y: point.y - moving.from.y };
      setMoveDelta(moving.delta);
      setCursor(at);
      return;
    }

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
      // One step for the whole gesture: pushed when it began, not per sample.
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
    const selecting = selectionDrag.current;
    if (selecting?.pointerId === event.pointerId) {
      const point = imagePoint(event);
      if (!spaceHeld.current) selecting.current = { x: point.x - selecting.shift.x, y: point.y - selecting.shift.y };
      selecting.fromCentre = event.altKey;
      selecting.square = event.shiftKey;
      const selection = marqueePreview(selecting);
      selectionDrag.current = undefined;
      setSelectionPreview(undefined);
      if (selection) commitDraft((current) => setMaskRectangleSelection(current, selection));
      return;
    }

    const transforming = transformDrag.current;
    if (transforming?.pointerId === event.pointerId) {
      const next = applyTransformDrag(transforming, imagePoint(event));
      transformDrag.current = undefined;
      setTransformPreview(undefined);
      // One undo step and one rebuild of the mask ink for the whole gesture.
      commitDraft((current) => setMaskTransform(current, next));
      return;
    }

    const moving = moveDrag.current;
    if (moving?.pointerId === event.pointerId) {
      // Measured from where the pointer was released, not from the last move
      // sample: the two are usually the same pixel, and when they are not it is
      // the release that the artist meant.
      const point = imagePoint(event);
      const delta = { x: Math.round(point.x - moving.from.x), y: Math.round(point.y - moving.from.y) };
      moveDrag.current = undefined;
      setMoveDelta(undefined);
      // One undoable move per gesture, and one recomposite, rather than one of
      // each per pointer sample.
      if (delta.x || delta.y) layerContextRef.current?.onMoveBy(delta);
      return;
    }
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
    cancelGesture();
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
  const hasRegion = hasPaintedRegion(draft);
  const committedTransformLabel = transformLabel(maskTransform(draft));

  return createPortal(
    <div
      className="fixed inset-0 isolate flex flex-col bg-stone-100"
      style={{ zIndex: 2_147_483_647 }}
      role="dialog"
      aria-modal="true"
      aria-busy={processing}
      aria-label={`Choose the region to edit on ${imageName}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 text-stone-900 shadow-sm">
        <div className="mr-2 min-w-0">
          <p className="text-sm font-bold">Current Composite &amp; Mask / Selection</p>
          <p className="max-w-48 truncate text-[11px] text-stone-500">{imageName}</p>
        </div>

        {layerContext ? (
          <div
            className="flex items-center rounded-md border border-stone-200 bg-stone-50 p-0.5"
            role="group"
            aria-label="Editing target"
          >
            {(["content", "mask"] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={readOnly}
                aria-pressed={target === option}
                title={
                  option === "content"
                    ? "Act on the generated pixels of this layer"
                    : "Act on this layer's mask -- what it reveals"
                }
                onClick={() => layerContext.onTargetChange(option)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded px-2 text-[11px] font-semibold capitalize transition disabled:cursor-not-allowed disabled:opacity-45",
                  target === option ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-900",
                )}
              >
                {option === "content" ? <Move className="h-3.5 w-3.5" /> : <Brush className="h-3.5 w-3.5" />}
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {tool === "transform" ? (
          <p className="text-xs text-stone-500">
            {transformBox
              ? "Drag a grip to scale, the knob to rotate. Alt from the centre, Shift proportional or 15° steps."
              : "Paint or select something first — there is nothing to transform yet."}
          </p>
        ) : tool === "move" ? (
          <p className="text-xs text-stone-500">
            Drag to reposition{" "}
            {contentFollowsMove && maskFollowsMove ? "the layer and its mask" : contentFollowsMove ? "the layer" : "the mask"}.
            Arrow keys nudge; Shift + arrow moves 10px.
          </p>
        ) : tool === "rectangle" ? (
          <p className="text-xs text-stone-500">Drag a box. Alt draws from the centre, Space repositions it.</p>
        ) : tool === "lasso" ? (
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

        {tool === "brush" || tool === "eraser" || tool === "lasso" ? (
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
        ) : null}

        {tool === "brush" || tool === "eraser" ? (
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
        ) : null}

        <div
          className="flex items-center rounded-md border border-stone-200 bg-stone-50 p-0.5"
          role="group"
          aria-label="Crop aspect ratio"
        >
          <button
            type="button"
            disabled={readOnly}
            aria-label="1:1 crop"
            aria-pressed={maskCropAspect(draft) === "1:1"}
            title="Square crop"
            onClick={() => setDraft((current) => setMaskCropAspect(current, "1:1"))}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded px-2 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45",
              maskCropAspect(draft) === "1:1" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-900",
            )}
          >
            <Square className="h-3.5 w-3.5" />
            1:1
          </button>
          <button
            type="button"
            disabled={readOnly}
            aria-label="Adaptive 16:9 or 9:16 crop"
            aria-pressed={maskCropAspect(draft) !== "1:1"}
            title="Adaptive landscape or portrait crop"
            onClick={() => setDraft((current) => setMaskCropAspect(current, "16:9"))}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded px-2 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45",
              maskCropAspect(draft) !== "1:1" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-900",
            )}
          >
            {maskCropAspect(draft) === "9:16" ? (
              <RectangleVertical className="h-3.5 w-3.5" />
            ) : (
              <RectangleHorizontal className="h-3.5 w-3.5" />
            )}
            {maskCropAspect(draft) === "9:16" ? "9:16" : "16:9"} Auto
          </button>
        </div>

        <label className="flex items-center gap-2 text-xs font-medium text-stone-600">
          Margin
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={maskCropMargin(draft)}
            disabled={readOnly}
            onChange={(event) => setDraft((current) => setMaskCropMargin(current, Number(event.target.value)))}
            className="w-24 accent-accent"
            aria-label="Crop margin"
          />
          <span className="w-9 tabular-nums text-stone-800">{maskCropMargin(draft)}%</span>
        </label>

        <div className="ml-auto flex items-center gap-1.5">
          {psdExportError ? (
            <span className="max-w-52 truncate text-xs font-semibold text-red-600" role="alert" title={psdExportError}>
              {psdExportError}
            </span>
          ) : null}
          <ToolbarButton onClick={undo} disabled={readOnly || !history.past.length} title="Undo (Ctrl+Z)" label="Undo">
            <RotateCcw className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={redo} disabled={readOnly || !history.future.length} title="Redo (Ctrl+Shift+Z)" label="Redo">
            <RotateCw className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => commitDraft(invertMaskDrawing)}
            disabled={readOnly}
            pressed={maskInverted(draft)}
            title={`Invert ${editingRegion ? "the selected region" : "this mask"} (Ctrl+I)`}
            label="Invert mask"
          >
            <Contrast className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => commitDraft(clearMaskStrokes)}
            disabled={readOnly || !hasRegion}
            title={`Clear ${editingRegion ? "the selected region" : "this mask"} (Del)`}
            label="Clear region"
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
          {onExportPsd ? (
            <button
              type="button"
              onClick={() => void onExportPsd()}
              disabled={readOnly || exportingPsd || !psdExportAvailable}
              title={
                psdExportAvailable
                  ? "Download the original, edit layers, and masks as a Photoshop file"
                  : "Generate an edit layer first"
              }
              className="flex h-9 items-center gap-2 rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-600 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {exportingPsd ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exportingPsd ? "Exporting…" : "Export PSD"}
            </button>
          ) : null}
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
          data-selection-x={liveDrawing.selection?.x}
          data-selection-y={liveDrawing.selection?.y}
          data-selection-width={liveDrawing.selection?.width}
          data-selection-height={liveDrawing.selection?.height}
          data-tool={tool}
          data-transform-handle={hoveredHandle}
          data-edit-target={layerContext ? target : "region"}
          data-move-x={moveDelta ? Math.round(moveDelta.x) : undefined}
          data-move-y={moveDelta ? Math.round(moveDelta.y) : undefined}
          className={cn(
            "relative min-w-0 flex-1 touch-none overflow-hidden bg-stone-200",
            panning
              ? "cursor-grabbing"
              : readOnly
                ? "cursor-default"
                : tool === "transform"
                  ? undefined
                  : tool === "move"
                    ? "cursor-move"
                    : tool === "lasso" || tool === "rectangle"
                      ? "cursor-crosshair"
                      : "cursor-none",
          )}
          style={
            tool === "transform" && !panning && !readOnly
              ? { cursor: hoveredHandle ? HANDLE_CURSORS[hoveredHandle] : "default" }
              : undefined
          }
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
                width: editCropWidth(editRegion.crop) * view.scale,
                height: editCropHeight(editRegion.crop) * view.scale,
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
            aria-label="Region tools"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {TOOLS.map(({ tool: option, label, key, Icon }) => {
              // Nothing to move until a layer is selected, and a Move tool that
              // silently does nothing is worse than one that is visibly off.
              const unavailable = option === "move" && !layerContext;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => selectTool(option)}
                  disabled={readOnly || unavailable}
                  aria-label={label}
                  aria-pressed={tool === option}
                  title={unavailable ? `${label} (${key}) -- select a layer first` : `${label} (${key})`}
                  className={cn(
                    "flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition",
                    tool === option
                      ? "bg-stone-950 text-white shadow-sm"
                      : "text-stone-500 hover:bg-stone-100 hover:text-stone-900",
                    (readOnly || unavailable) && "cursor-not-allowed opacity-40",
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </button>
              );
            })}
          </div>
          {/*
            The one place that always answers "what am I about to change?".
            Everything on it is the live state, not a label chosen at open time.
          */}
          <div
            className="pointer-events-none absolute left-4 top-4 z-20 flex max-w-[min(30rem,60%)] flex-wrap items-center gap-1.5 rounded-lg border border-stone-200/80 bg-white/95 px-2.5 py-1.5 text-[11px] font-semibold text-stone-600 shadow-lg backdrop-blur"
            role="group"
            aria-label="What the tools will change"
            data-testid="mask-editor-context"
          >
            <span className="truncate text-stone-900">{layerContext ? layerContext.name : "New edit"}</span>
            <span className="text-stone-300">/</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                editingRegion
                  ? "bg-cyan-100 text-cyan-900"
                  : target === "mask"
                    ? "bg-violet-100 text-violet-900"
                    : "bg-amber-100 text-amber-900",
              )}
            >
              {editingRegion ? "Edit region" : target === "mask" ? "Layer mask" : "Layer content"}
            </span>
            <span className="text-stone-300">/</span>
            <span className="capitalize">{TOOLS.find((entry) => entry.tool === tool)?.label ?? tool}</span>
            {layerContext ? (
              <>
                <span className="text-stone-300">/</span>
                <span className="tabular-nums">{layerContext.opacity}%</span>
                {!layerContext.visible ? <span className="text-stone-400">hidden</span> : null}
                {!layerContext.maskEnabled ? <span className="text-amber-700">mask off</span> : null}
                {!layerContext.maskLinked ? <span className="text-amber-700">unlinked</span> : null}
                {layerContext.offset.x || layerContext.offset.y ? (
                  <span className="tabular-nums text-stone-500">
                    moved {formatOffset(layerContext.offset.x)}, {formatOffset(layerContext.offset.y)}
                  </span>
                ) : null}
              </>
            ) : null}
            {maskInverted(draft) ? <span className="text-violet-700">inverted</span> : null}
            {!isIdentityTransform(maskTransform(draft)) ? (
              <span className="tabular-nums text-violet-700">{committedTransformLabel}</span>
            ) : null}
            {liveDrawing.selection ? (
              <span className="tabular-nums text-stone-500">
                sel {liveDrawing.selection.width} x {liveDrawing.selection.height}
              </span>
            ) : null}
            {moveDelta ? (
              <span className="tabular-nums text-amber-700">
                move {formatOffset(moveDelta.x)}, {formatOffset(moveDelta.y)}
              </span>
            ) : null}
          </div>

          {floatingPanel ? <div className="absolute bottom-4 right-4 z-20">{floatingPanel}</div> : null}
        </div>
      </div>

      <footer className="flex items-center gap-4 border-t border-stone-200 bg-white px-4 py-2 text-xs text-stone-500">
        <span className="flex items-center gap-1.5">
          <Hand className="h-3.5 w-3.5" />
          Space or middle-drag to pan, scroll to zoom
        </span>
        {tool === "brush" || tool === "eraser" ? (
          <>
            <span>[ and ] resize the brush</span>
            <span>
              <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
                Alt + right-drag
              </kbd>{" "}
              size ↔ · softness ↕
            </span>
          </>
        ) : tool === "rectangle" ? (
          <span>
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Alt
            </kbd>{" "}
            from centre ·{" "}
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Shift
            </kbd>{" "}
            square ·{" "}
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Space
            </kbd>{" "}
            reposition ·{" "}
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Ctrl+D
            </kbd>{" "}
            deselect
          </span>
        ) : tool === "move" ? (
          <span>Release to apply the move · arrow keys nudge · the outline shows where it lands</span>
        ) : tool === "transform" ? (
          <span>
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Alt
            </kbd>{" "}
            from centre ·{" "}
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Shift
            </kbd>{" "}
            proportional / 15° ·{" "}
            <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-700">
              Esc
            </kbd>{" "}
            cancels the drag · non-destructive, reset it any time
          </span>
        ) : null}
        {editRegion.crop ? (
          <span className="font-semibold tabular-nums text-stone-700">
            Edit region: {editCropWidth(editRegion.crop)} × {editCropHeight(editRegion.crop)}px ({maskCropAspect(draft)})
          </span>
        ) : editRegion.error ? (
          <span className="font-semibold text-red-600">{editRegion.error}</span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {naturalWidth} x {naturalHeight} ·{" "}
          {draft.selection ? "rectangle selection" : `${strokeCount} stroke${strokeCount === 1 ? "" : "s"}`}
        </span>
      </footer>
    </div>,
    document.body,
  );
}

function ToolbarButton({
  onClick,
  disabled,
  pressed,
  title,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
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
      aria-pressed={pressed}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40",
        pressed
          ? "border-violet-400 bg-violet-100 text-violet-800"
          : "border-stone-200 bg-white text-stone-600 hover:bg-stone-100 hover:text-stone-900",
      )}
    >
      {children}
    </button>
  );
}

/** "120% · 15°", or just the part that is not the default. */
function transformLabel(transform: MaskTransform) {
  const { scaleX, scaleY, degrees } = transformReadout(transform);
  const scale =
    Math.abs(scaleX - scaleY) < 0.005
      ? `${Math.round(scaleX * 100)}%`
      : `${Math.round(scaleX * 100)}%×${Math.round(scaleY * 100)}%`;
  const angle = Math.round(degrees);
  return angle ? `${scale} · ${angle}°` : scale;
}

function formatOffset(value: number) {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}px`;
}

/**
 * Where a move will land, without recompositing to show it.
 *
 * The layer's own crop, outlined at its destination with a faint trace left at
 * its origin, plus the distance travelled. That is enough to place a layer
 * precisely, and it costs two stroked rectangles instead of a full-resolution
 * rebuild of the document on every pointer sample.
 */
function paintMoveGhost(
  context: CanvasRenderingContext2D,
  crop: StillImageEditCrop,
  view: MaskView,
  delta: MaskPoint,
  contentMoves: boolean,
  target: StillImageEditTarget,
) {
  const width = editCropWidth(crop) * view.scale;
  const height = editCropHeight(crop) * view.scale;
  const originLeft = crop.x * view.scale + view.offsetX;
  const originTop = crop.y * view.scale + view.offsetY;
  const left = originLeft + (contentMoves ? delta.x * view.scale : 0);
  const top = originTop + (contentMoves ? delta.y * view.scale : 0);

  context.save();
  context.strokeStyle = "rgba(120, 113, 108, 0.55)";
  context.lineWidth = 1;
  context.setLineDash([4, 4]);
  context.strokeRect(originLeft, originTop, width, height);
  context.setLineDash([]);

  context.strokeStyle = "rgba(0, 0, 0, 0.7)";
  context.lineWidth = 3.5;
  context.strokeRect(left, top, width, height);
  context.strokeStyle = "rgba(251, 191, 36, 1)";
  context.lineWidth = 1.5;
  context.strokeRect(left, top, width, height);

  paintCanvasLabel(
    context,
    left + 8,
    top > 34 ? top - 30 : top + 8,
    `MOVING ${target === "mask" ? "MASK" : "LAYER"}  ${formatOffset(delta.x)}, ${formatOffset(delta.y)}`,
  );
  context.restore();
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

/**
 * A Photoshop-style marquee for the hard rectangular edit selection.
 *
 * Drawn as a quad rather than a rectangle, because a transformed selection is no
 * longer upright: the four corners are carried through the mask's own transform
 * so the marquee sits on the pixels it actually covers.
 */
function paintRectangleSelection(
  context: CanvasRenderingContext2D,
  selection: MaskRectangleSelection,
  transform: MaskTransform,
  view: MaskView,
  processing = false,
) {
  const corners = boxCorners({
    left: selection.x,
    top: selection.y,
    right: selection.x + selection.width,
    bottom: selection.y + selection.height,
  }).map((corner) => viewportPointFromImage(view, transformPoint(transform, corner)));
  const colour = processing ? "rgba(103, 232, 249, 1)" : "rgba(34, 211, 238, 1)";

  context.save();
  tracePath(context, corners, true);
  context.fillStyle = processing ? "rgba(34, 211, 238, 0.16)" : "rgba(34, 211, 238, 0.09)";
  context.fill();
  context.strokeStyle = "rgba(0, 0, 0, 0.82)";
  context.lineWidth = 3.5;
  context.stroke();
  context.strokeStyle = colour;
  context.lineWidth = 1.5;
  context.setLineDash([7, 5]);
  context.stroke();
  context.setLineDash([]);

  const handle = 6;
  context.fillStyle = "white";
  context.strokeStyle = "rgba(8, 145, 178, 1)";
  context.lineWidth = 1;
  for (const corner of corners) {
    context.fillRect(corner.x - handle / 2, corner.y - handle / 2, handle, handle);
    context.strokeRect(corner.x - handle / 2, corner.y - handle / 2, handle, handle);
  }

  paintCanvasLabel(context, corners[0].x + 8, corners[0].y + 8, `SELECTION  ${selection.width} × ${selection.height} px`);
  context.restore();
}

type HandlePositions = Record<TransformHandle, MaskPoint>;

/**
 * Where the eight grips and the rotation knob sit, in screen pixels.
 *
 * The knob is pushed out along the top edge's outward normal rather than
 * straight up the screen, so a box turned on its side still has its knob clear
 * of the shape instead of buried inside it.
 */
function handlePositions(corners: MaskPoint[]): HandlePositions {
  const [nw, ne, se, sw] = corners;
  const n = midpoint(nw, ne);
  const centre = midpoint(nw, se);
  const away = awayFrom(centre, n);
  return {
    nw,
    ne,
    se,
    sw,
    n,
    e: midpoint(ne, se),
    s: midpoint(se, sw),
    w: midpoint(sw, nw),
    rotate: { x: n.x + away.x * ROTATE_KNOB_OFFSET, y: n.y + away.y * ROTATE_KNOB_OFFSET },
  };
}

function handleAt(handles: HandlePositions, at: MaskPoint): TransformHandle | undefined {
  let closest: TransformHandle | undefined;
  let closestDistance = HANDLE_RADIUS;
  for (const name of Object.keys(handles) as TransformHandle[]) {
    const point = handles[name];
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance <= closestDistance) {
      closestDistance = distance;
      closest = name;
    }
  }
  return closest;
}

const HANDLE_CURSORS: Record<TransformHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  rotate: "grab",
};

/** The free-transform box: the quad, its grips, and what the drag has done so far. */
function paintTransformBox(
  context: CanvasRenderingContext2D,
  corners: MaskPoint[],
  handles: HandlePositions,
  hovered: TransformHandle | undefined,
  summary: string | undefined,
) {
  context.save();
  tracePath(context, corners, true);
  context.strokeStyle = "rgba(0, 0, 0, 0.7)";
  context.lineWidth = 3;
  context.stroke();
  context.strokeStyle = "rgba(167, 139, 250, 1)";
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.stroke();
  context.setLineDash([]);

  // A stem to the knob, so it reads as part of the box rather than a stray dot.
  const top = handles.n;
  context.beginPath();
  context.moveTo(top.x, top.y);
  context.lineTo(handles.rotate.x, handles.rotate.y);
  context.strokeStyle = "rgba(0, 0, 0, 0.55)";
  context.lineWidth = 3;
  context.stroke();
  context.strokeStyle = "rgba(167, 139, 250, 1)";
  context.lineWidth = 1.5;
  context.stroke();

  for (const name of Object.keys(handles) as TransformHandle[]) {
    const point = handles[name];
    const active = name === hovered;
    context.fillStyle = active ? "rgba(167, 139, 250, 1)" : "white";
    context.strokeStyle = "rgba(76, 29, 149, 0.95)";
    context.lineWidth = 1.25;
    if (name === "rotate") {
      context.beginPath();
      context.arc(point.x, point.y, active ? 7 : 6, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      continue;
    }
    const size = active ? 10 : 8;
    context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    context.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
  }

  if (summary) {
    const anchor = handles.s;
    paintCanvasLabel(context, anchor.x - 60, anchor.y + 14, summary);
  }
  context.restore();
}

function midpoint(from: MaskPoint, to: MaskPoint): MaskPoint {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/** A unit vector from one point to another, with a sane answer when they coincide. */
function awayFrom(from: MaskPoint, to: MaskPoint): MaskPoint {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const length = Math.hypot(x, y);
  return length < 0.001 ? { x: 0, y: -1 } : { x: x / length, y: y / length };
}

/** Shade everything outside the exact crop sent to the editing model. */
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
  const width = editCropWidth(crop) * view.scale;
  const height = editCropHeight(crop) * view.scale;
  const right = left + width;
  const bottom = top + height;

  context.save();
  context.fillStyle = "rgba(17, 24, 39, 0.30)";
  context.fillRect(imageLeft, imageTop, displayedWidth, Math.max(0, top - imageTop));
  context.fillRect(imageLeft, bottom, displayedWidth, Math.max(0, imageTop + displayedHeight - bottom));
  context.fillRect(imageLeft, top, Math.max(0, left - imageLeft), height);
  context.fillRect(right, top, Math.max(0, imageLeft + displayedWidth - right), height);

  // A dark keyline keeps the white boundary legible over bright skies and snow.
  context.strokeStyle = "rgba(0, 0, 0, 0.72)";
  context.lineWidth = 4;
  context.strokeRect(left, top, width, height);
  context.strokeStyle = processing ? "rgba(103, 232, 249, 0.98)" : "rgba(255, 255, 255, 0.98)";
  context.lineWidth = 1.5;
  context.strokeRect(left, top, width, height);

  const corner = Math.min(22, Math.max(7, Math.min(width, height) * 0.08));
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
    `${processing ? "PROCESSING" : "EDIT REGION"}  ${editCropWidth(crop)} × ${editCropHeight(crop)} px`,
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
