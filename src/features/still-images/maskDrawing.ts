// What the artist painted or selected, in image pixels.
//
// The Image Editing preset is the only one that sends the server something the
// artist drew rather than something they uploaded, so this module holds that
// drawing in a form the rest of the app can reason about: strokes or a rectangle
// in the source image's own coordinate space, independent of how big the editor
// happened to be showing it.
//
// Deliberately geometry only. Rasterising to a PNG needs a canvas and a decoded
// image, which is maskRaster.ts; everything here is arithmetic on plain data, so
// the stroke model, the zoom maths and the softness curve can be tested without a
// DOM. Keeping the two apart also means the region stays serialisable -- plain
// geometry is JSON, a canvas is not.

export type MaskPoint = { x: number; y: number };

/** A hard-edged edit selection in original-image pixels. */
export type MaskRectangleSelection = { x: number; y: number; width: number; height: number };

export type MaskTool = "brush" | "eraser" | "lasso";

/**
 * How the size slider is read.
 *
 * "image" measures the brush on the source, so it covers the same part of the
 * picture at any zoom and grows on screen as you zoom in. "screen" keeps it the
 * same size under the cursor and therefore covers less of the image the further
 * in you go. inpaintr.studio offers the same choice and defaults to "image",
 * which is the one that makes a stroke reproducible.
 */
export type BrushSizing = "image" | "screen";

export type EditCropAspect = "1:1" | "16:9" | "9:16";

export type MaskStroke = {
  tool: MaskTool;
  /** Image-space points. A brush stroke is a path; a lasso is a polygon. */
  points: MaskPoint[];
  /** Half the brush width, in image pixels. Unused by the lasso. */
  radius: number;
};

export type MaskDrawing = {
  /** The natural size of the image this region was created on. */
  width: number;
  height: number;
  /** 0-100. One value for the whole mask, applied when it is rasterised. */
  softness: number;
  /** Explicit feather radius for a translated/scaled derivative such as a crop. */
  blurPixels?: number;
  /** Extra context around the painted subject, as a percentage of its long side. */
  cropMargin?: number;
  /** Shape of the provider input crop. Missing on older saved edits means 1:1. */
  cropAspect?: EditCropAspect;
  /** Alternative to painted strokes. The submission rasterizer turns it into the workflow mask. */
  selection?: MaskRectangleSelection;
  /**
   * Swap covered for uncovered when this is rasterised.
   *
   * Held as a flag rather than by rewriting the strokes so that inverting is
   * reversible and costs nothing: the strokes an artist painted are still the
   * strokes they painted, and a second invert returns exactly the original mask
   * instead of an approximation of it.
   */
  inverted?: boolean;
  /**
   * A free transform applied to the whole mask when it is rasterised.
   *
   * Absent means the mask sits exactly where it was painted, which is what every
   * mask starts as and what almost all of them stay.
   */
  transform?: MaskTransform;
  strokes: MaskStroke[];
};

/**
 * A 2D affine transform on the mask, in the order canvas's own transform takes it.
 *
 * Six numbers rather than a scale-and-angle pair, because a free transform has to
 * survive being composed with the next one: rotate, scale unevenly, rotate again
 * and the result is a shear that no scale-plus-angle model can hold. Storing the
 * matrix means the second gesture lands where the artist put it instead of being
 * quietly rounded to something representable.
 *
 * Held beside the strokes rather than baked into them, for the same reason as
 * inversion: the points stay the points the artist painted, so a transform can be
 * adjusted or reset without the mask degrading each time it is touched.
 */
export type MaskTransform = { a: number; b: number; c: number; d: number; e: number; f: number };

export const IDENTITY_TRANSFORM: MaskTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Below this a scale handle would collapse the mask into a line it cannot come back from. */
export const MIN_TRANSFORM_SCALE = 0.02;

export const DEFAULT_MASK_SOFTNESS = 35;
export const DEFAULT_EDIT_CROP_MARGIN = 0;
export const DEFAULT_EDIT_CROP_ASPECT: EditCropAspect = "1:1";
export const MIN_BRUSH_RADIUS = 1;
export const MAX_BRUSH_RADIUS = 2000;

export function createMaskDrawing(width: number, height: number, softness = DEFAULT_MASK_SOFTNESS): MaskDrawing {
  return {
    width,
    height,
    softness,
    cropMargin: DEFAULT_EDIT_CROP_MARGIN,
    cropAspect: DEFAULT_EDIT_CROP_ASPECT,
    strokes: [],
  };
}

/**
 * Start the drawing again against a different image.
 *
 * Strokes are in the old image's pixels, so they mean nothing on a new one -- a
 * region painted on a 4K render would land in the corner of a 1K one. Replacing
 * the source therefore drops them rather than trying to rescale: a mask that
 * silently moved is worse than one the artist is asked to paint again. The
 * softness is a preference, not part of the drawing, so it carries over.
 */
export function retargetMaskDrawing(drawing: MaskDrawing | undefined, width: number, height: number): MaskDrawing {
  if (drawing && drawing.width === width && drawing.height === height) return drawing;
  return {
    ...createMaskDrawing(width, height, drawing?.softness ?? DEFAULT_MASK_SOFTNESS),
    cropMargin: maskCropMargin(drawing),
    cropAspect: maskCropAspect(drawing),
  };
}

export function appendMaskStroke(drawing: MaskDrawing, stroke: MaskStroke): MaskDrawing {
  if (!stroke.points.length) return drawing;
  return { ...drawing, selection: undefined, strokes: [...drawing.strokes, stroke] };
}

export function undoMaskStroke(drawing: MaskDrawing): MaskDrawing {
  if (!drawing.strokes.length) return drawing.selection ? { ...drawing, selection: undefined } : drawing;
  return { ...drawing, strokes: drawing.strokes.slice(0, -1) };
}

export function clearMaskStrokes(drawing: MaskDrawing): MaskDrawing {
  if (!drawing.strokes.length && !drawing.selection) return drawing;
  return { ...drawing, selection: undefined, strokes: [] };
}

export function setMaskSoftness(drawing: MaskDrawing, softness: number): MaskDrawing {
  return { ...drawing, softness: clamp(Math.round(softness), 0, 100) };
}

export function maskCropMargin(drawing: MaskDrawing | undefined) {
  return clamp(Math.round(drawing?.cropMargin ?? DEFAULT_EDIT_CROP_MARGIN), 0, 100);
}

export function setMaskCropMargin(drawing: MaskDrawing, margin: number): MaskDrawing {
  return { ...drawing, cropMargin: clamp(Math.round(margin), 0, 100) };
}

export function maskCropAspect(drawing: MaskDrawing | undefined): EditCropAspect {
  return drawing?.cropAspect === "16:9" || drawing?.cropAspect === "9:16" ? drawing.cropAspect : DEFAULT_EDIT_CROP_ASPECT;
}

export function setMaskCropAspect(drawing: MaskDrawing, aspect: EditCropAspect): MaskDrawing {
  if (aspect === "1:1" || !drawing.selection) return { ...drawing, cropAspect: aspect };
  return { ...drawing, cropAspect: adaptiveSelectionAspect(drawing.selection) };
}

/** Normalize a pointer drag into an in-bounds, integer source-pixel selection. */
export function maskRectangleFromPoints(
  start: MaskPoint,
  end: MaskPoint,
  imageWidth: number,
  imageHeight: number,
): MaskRectangleSelection | undefined {
  const left = Math.floor(clamp(Math.min(start.x, end.x), 0, imageWidth));
  const top = Math.floor(clamp(Math.min(start.y, end.y), 0, imageHeight));
  const right = Math.ceil(clamp(Math.max(start.x, end.x), 0, imageWidth));
  const bottom = Math.ceil(clamp(Math.max(start.y, end.y), 0, imageHeight));
  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Rectangle selection and painted masks are intentionally mutually exclusive. */
export function setMaskRectangleSelection(drawing: MaskDrawing, selection: MaskRectangleSelection | undefined): MaskDrawing {
  return {
    ...drawing,
    selection,
    strokes: selection ? [] : drawing.strokes,
    cropAspect: selection && maskCropAspect(drawing) !== "1:1" ? adaptiveSelectionAspect(selection) : maskCropAspect(drawing),
  };
}

/**
 * Photoshop's marquee modifiers, as one pure function.
 *
 * Alt grows the rectangle outward from the mouse-down point instead of from a
 * corner, and Space lifts the whole rectangle and carries it with the pointer
 * without changing its size. Both are expressed as adjustments to the two
 * endpoints rather than as separate drag modes, which is what makes releasing
 * either modifier mid-drag resume the ordinary corner drag from wherever the
 * rectangle now sits -- the behaviour that makes the tool feel predictable.
 */
export type MarqueeDrag = {
  /** Where the drag began, in image pixels. */
  origin: MaskPoint;
  /** Where the pointer is now, in image pixels. */
  current: MaskPoint;
  /** Translation accumulated while Space was held, in image pixels. */
  shift?: MaskPoint;
  /** Alt: draw from the mouse-down point as the centre. */
  fromCentre?: boolean;
  /** Shift: constrain to a square. */
  square?: boolean;
};

export function marqueeSelection(drag: MarqueeDrag, imageWidth: number, imageHeight: number): MaskRectangleSelection | undefined {
  const shift = drag.shift ?? { x: 0, y: 0 };
  let deltaX = drag.current.x - drag.origin.x;
  let deltaY = drag.current.y - drag.origin.y;

  if (drag.square) {
    const side = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    deltaX = (deltaX < 0 ? -1 : 1) * side;
    deltaY = (deltaY < 0 ? -1 : 1) * side;
  }

  const origin = { x: drag.origin.x + shift.x, y: drag.origin.y + shift.y };
  const start = drag.fromCentre ? { x: origin.x - deltaX, y: origin.y - deltaY } : origin;
  const end = { x: origin.x + deltaX, y: origin.y + deltaY };
  return maskRectangleFromPoints(start, end, imageWidth, imageHeight);
}

/**
 * The same drawing, somewhere else on the image.
 *
 * Deliberately unclamped. A mask dragged half off the canvas and back again has
 * to come back whole, and clamping the strokes on the way out would quietly
 * flatten everything that left the frame against its edge.
 */
export function translateMaskDrawing(drawing: MaskDrawing, deltaX: number, deltaY: number): MaskDrawing {
  if (!deltaX && !deltaY) return drawing;
  // The points are what a transform is applied to, so a displacement measured on
  // the image has to be taken back through it first. Moving a mask rotated by 30
  // degrees would otherwise send it off at 30 degrees to the drag.
  const inverse = invertTransform(maskTransform(drawing));
  const local = inverse ? transformVector(inverse, { x: deltaX, y: deltaY }) : { x: deltaX, y: deltaY };
  return {
    ...drawing,
    selection: drawing.selection
      ? { ...drawing.selection, x: drawing.selection.x + local.x, y: drawing.selection.y + local.y }
      : undefined,
    strokes: drawing.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x + local.x, y: point.y + local.y })),
    })),
  };
}

// -- the free transform ------------------------------------------------------

export function maskTransform(drawing: MaskDrawing | undefined): MaskTransform {
  return drawing?.transform ?? IDENTITY_TRANSFORM;
}

export function isIdentityTransform(transform: MaskTransform) {
  const { a, b, c, d, e, f } = transform;
  return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
}

export function setMaskTransform(drawing: MaskDrawing, transform: MaskTransform): MaskDrawing {
  // Identity is stored as absence, so an untransformed mask serialises exactly as
  // it did before masks could be transformed at all.
  const next = isIdentityTransform(transform) ? undefined : transform;
  if (next === undefined && drawing.transform === undefined) return drawing;
  return { ...drawing, transform: next };
}

export function resetMaskTransform(drawing: MaskDrawing): MaskDrawing {
  return setMaskTransform(drawing, IDENTITY_TRANSFORM);
}

/** `outer` applied after `inner`. */
export function composeTransforms(outer: MaskTransform, inner: MaskTransform): MaskTransform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function transformPoint(transform: MaskTransform, point: MaskPoint): MaskPoint {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  };
}

/** The linear part only, for carrying a displacement between the two spaces. */
export function transformVector(transform: MaskTransform, vector: MaskPoint): MaskPoint {
  return {
    x: transform.a * vector.x + transform.c * vector.y,
    y: transform.b * vector.x + transform.d * vector.y,
  };
}

export function invertTransform(transform: MaskTransform): MaskTransform | undefined {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!determinant || !Number.isFinite(determinant)) return undefined;
  const a = transform.d / determinant;
  const b = -transform.b / determinant;
  const c = -transform.c / determinant;
  const d = transform.a / determinant;
  return { a, b, c, d, e: -(a * transform.e + c * transform.f), f: -(b * transform.e + d * transform.f) };
}

export function translationTransform(deltaX: number, deltaY: number): MaskTransform {
  return { ...IDENTITY_TRANSFORM, e: deltaX, f: deltaY };
}

/** Scale about a pivot, expressed in whichever space the pivot is in. */
export function scaleTransform(pivot: MaskPoint, scaleX: number, scaleY: number): MaskTransform {
  return { a: scaleX, b: 0, c: 0, d: scaleY, e: pivot.x * (1 - scaleX), f: pivot.y * (1 - scaleY) };
}

export function rotationTransform(pivot: MaskPoint, radians: number): MaskTransform {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: pivot.x - cos * pivot.x + sin * pivot.y,
    f: pivot.y - sin * pivot.x - cos * pivot.y,
  };
}

/**
 * Stretch the mask along its own axes, about a pivot in the mask's own coordinates.
 *
 * Composed on the inside, which is what makes a corner handle on a rotated box
 * pull along the box rather than along the screen -- exactly what dragging a
 * rotated bounding box does everywhere else.
 */
export function scaledMaskTransform(current: MaskTransform, pivot: MaskPoint, scaleX: number, scaleY: number): MaskTransform {
  return composeTransforms(current, scaleTransform(pivot, clampScale(scaleX), clampScale(scaleY)));
}

/**
 * Turn the mask rigidly about a pivot in image pixels.
 *
 * Composed on the outside, because a rotation the artist measures on screen has
 * to stay a rotation: applied inside an uneven scale it would arrive as a shear.
 */
export function rotatedMaskTransform(current: MaskTransform, pivot: MaskPoint, radians: number): MaskTransform {
  return composeTransforms(rotationTransform(pivot, radians), current);
}

/**
 * The same transform, expressed in coordinates that have themselves been changed.
 *
 * Every derivative of a drawing -- a crop, a downscaled preview -- rewrites the
 * stroke coordinates, and a transform written against the old coordinates would
 * then be applied to the new ones. Conjugating by the same change keeps the
 * rasterised result identical, which is the only thing that has to be true.
 */
export function conjugateTransform(transform: MaskTransform, change: MaskTransform): MaskTransform {
  const inverse = invertTransform(change);
  if (!inverse) return transform;
  return composeTransforms(composeTransforms(change, transform), inverse);
}

/** Scale and angle for the readout. Exact for anything without a shear in it. */
export function transformReadout(transform: MaskTransform) {
  return {
    scaleX: Math.hypot(transform.a, transform.b),
    scaleY: Math.hypot(transform.c, transform.d),
    degrees: (Math.atan2(transform.b, transform.a) * 180) / Math.PI,
  };
}

/**
 * The box the strokes and selection occupy, before any transform.
 *
 * The free transform's bounding box is this, with its four corners carried
 * through the transform -- which is what makes the box rotate with the mask
 * instead of growing into an upright box around it.
 */
export function maskGeometryBounds(drawing: MaskDrawing): MaskBox | undefined {
  let box: MaskBox | undefined = drawing.selection
    ? {
        left: drawing.selection.x,
        top: drawing.selection.y,
        right: drawing.selection.x + drawing.selection.width,
        bottom: drawing.selection.y + drawing.selection.height,
      }
    : undefined;

  for (const stroke of drawing.strokes) {
    if (stroke.tool === "eraser" || !stroke.points.length) continue;
    const radius = stroke.tool === "lasso" ? 0 : Math.max(0, stroke.radius);
    for (const point of stroke.points) {
      const next = { left: point.x - radius, top: point.y - radius, right: point.x + radius, bottom: point.y + radius };
      box = box
        ? {
            left: Math.min(box.left, next.left),
            top: Math.min(box.top, next.top),
            right: Math.max(box.right, next.right),
            bottom: Math.max(box.bottom, next.bottom),
          }
        : next;
    }
  }
  return box;
}

export type MaskBox = { left: number; top: number; right: number; bottom: number };

/** The four corners of a box, clockwise from the top left. */
export function boxCorners(box: MaskBox): [MaskPoint, MaskPoint, MaskPoint, MaskPoint] {
  return [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
}

/**
 * The eight scale grips and the rotation knob, named by compass point.
 *
 * "n" is the top edge, so a north grip is anchored on the bottom of the box. The
 * names are also how the drag reads which axes it may change, which is why they
 * are single letters rather than an enum of nine unrelated words.
 */
export type TransformHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

/** Shift snaps rotation to this, the interval every transform tool uses. */
export const ROTATION_SNAP = Math.PI / 12;

export type HandleDrag = {
  handle: TransformHandle;
  /** The mask's own box, in the mask's own coordinates. */
  box: MaskBox;
  /** The transform the mask already carried when the drag began. */
  base: MaskTransform;
  /** Where the drag began and where the pointer is now, both in image pixels. */
  from: MaskPoint;
  to: MaskPoint;
  /** Alt: scale about the centre rather than the opposite side. */
  fromCentre?: boolean;
  /** Shift: keep a corner drag proportional, and snap a rotation to 15 degrees. */
  proportional?: boolean;
};

/**
 * The transform a free-transform drag has produced.
 *
 * Scaling is worked out in the mask's own coordinates and rotation in the
 * image's, which is the whole reason the two compose on opposite sides: a corner
 * grip on a rotated box has to pull along the box, while the rotation the artist
 * measures on screen has to stay a rotation rather than arriving as a shear.
 *
 * Pure, and given the drag rather than the pointer history, so a gesture is a
 * function of where it started and where it is -- releasing a modifier mid-drag
 * simply recomputes it, with no state to unwind.
 */
export function transformFromHandleDrag(drag: HandleDrag): MaskTransform {
  const centre = { x: (drag.box.left + drag.box.right) / 2, y: (drag.box.top + drag.box.bottom) / 2 };

  if (drag.handle === "rotate") {
    const pivot = transformPoint(drag.base, centre);
    const startAngle = Math.atan2(drag.from.y - pivot.y, drag.from.x - pivot.x);
    const angle = Math.atan2(drag.to.y - pivot.y, drag.to.x - pivot.x) - startAngle;
    const snapped = drag.proportional ? Math.round(angle / ROTATION_SNAP) * ROTATION_SNAP : angle;
    return rotatedMaskTransform(drag.base, pivot, snapped);
  }

  const inverse = invertTransform(drag.base);
  if (!inverse) return drag.base;
  const from = transformPoint(inverse, drag.from);
  const to = transformPoint(inverse, drag.to);

  const movesX = drag.handle.includes("e") || drag.handle.includes("w");
  const movesY = drag.handle.includes("n") || drag.handle.includes("s");
  const anchor = drag.fromCentre
    ? centre
    : {
        x: drag.handle.includes("w") ? drag.box.right : drag.handle.includes("e") ? drag.box.left : centre.x,
        y: drag.handle.includes("n") ? drag.box.bottom : drag.handle.includes("s") ? drag.box.top : centre.y,
      };

  let scaleX = movesX ? handleRatio(from.x - anchor.x, to.x - anchor.x) : 1;
  let scaleY = movesY ? handleRatio(from.y - anchor.y, to.y - anchor.y) : 1;
  if (drag.proportional && movesX && movesY) {
    // The larger of the two so the shape follows the axis the artist is pushing
    // hardest, and the signs are kept so a drag through the anchor still flips.
    const uniform = Math.max(Math.abs(scaleX), Math.abs(scaleY));
    scaleX = scaleX < 0 ? -uniform : uniform;
    scaleY = scaleY < 0 ? -uniform : uniform;
  }
  return scaledMaskTransform(drag.base, anchor, scaleX, scaleY);
}

/** A grip exactly on its anchor has no length to scale, so it scales by nothing. */
function handleRatio(before: number, after: number) {
  return before === 0 ? 1 : after / before;
}

function clampScale(scale: number) {
  const magnitude = Math.max(MIN_TRANSFORM_SCALE, Math.abs(scale));
  return scale < 0 ? -magnitude : magnitude;
}

export function maskInverted(drawing: MaskDrawing | undefined) {
  return drawing?.inverted === true;
}

export function setMaskInverted(drawing: MaskDrawing, inverted: boolean): MaskDrawing {
  if (maskInverted(drawing) === inverted) return drawing;
  return { ...drawing, inverted: inverted || undefined };
}

export function invertMaskDrawing(drawing: MaskDrawing): MaskDrawing {
  return setMaskInverted(drawing, !maskInverted(drawing));
}

/** Resolve the editor's adaptive widescreen mode from the rectangle itself. */
export function adaptiveSelectionAspect(selection: MaskRectangleSelection): Exclude<EditCropAspect, "1:1"> {
  return selection.height > selection.width ? "9:16" : "16:9";
}

/**
 * Is there anything left to send?
 *
 * Erasers only take away, so a drawing whose strokes are all erasers paints
 * nothing -- which matters because the mask is what confines the edit, and an
 * empty one would let the model repaint the whole frame while the panel claimed a
 * region had been chosen. This is the cheap structural answer; the rasteriser's
 * own coverage check is the exact one, and the panel uses both.
 */
export function hasPaintedRegion(drawing: MaskDrawing | undefined) {
  // An inverted mask with nothing painted covers the whole frame rather than
  // nothing, so the structural answer flips with it.
  if (maskInverted(drawing)) return true;
  const selected = Boolean(drawing?.selection && drawing.selection.width > 0 && drawing.selection.height > 0);
  const painted = Boolean(drawing?.strokes.some((stroke) => stroke.tool !== "eraser" && stroke.points.length > 0));
  return selected || painted;
}

/**
 * The blur applied when flattening the mask, in image pixels.
 *
 * Scaled by the image rather than fixed, so 35% feathers the same fraction of a
 * 6000px render as of a 1000px one -- a constant would be invisible on the first
 * and would swallow small strokes on the second. The 3% ceiling is what keeps a
 * fully soft edge readable as an edge.
 */
export function maskBlurPixels(softness: number, width: number, height: number) {
  const shortSide = Math.max(1, Math.min(width, height));
  return Math.round((clamp(softness, 0, 100) / 100) * shortSide * 0.03);
}

/**
 * The brush radius a stroke is recorded with.
 *
 * Strokes are stored in image pixels whichever way the slider is read, so a
 * screen-sized brush has to be divided back out by the zoom at the moment it was
 * drawn. Recording screen pixels instead would make the same stroke mean different
 * things depending on how far in the artist happened to be.
 */
export function brushRadiusInImagePixels(sliderRadius: number, sizing: BrushSizing, scale: number) {
  const safeScale = scale > 0 ? scale : 1;
  const radius = sizing === "screen" ? sliderRadius / safeScale : sliderRadius;
  return clamp(radius, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
}

/** The same radius drawn back onto the screen, for the cursor ring. */
export function brushRadiusOnScreen(sliderRadius: number, sizing: BrushSizing, scale: number) {
  return sizing === "screen" ? sliderRadius : sliderRadius * (scale > 0 ? scale : 1);
}

/**
 * Photoshop-style fast brush adjustment used by Alt + right-drag.
 *
 * Size is exponential rather than a fixed number of pixels per mouse pixel: a
 * short drag stays precise with a small brush but can still resize a very large
 * one without crossing the whole display. Dragging down increases feathering;
 * dragging up makes the edge harder.
 */
export function brushSettingsFromDrag(
  startRadius: number,
  startSoftness: number,
  deltaX: number,
  deltaY: number,
  maximumRadius = MAX_BRUSH_RADIUS,
) {
  return {
    radius: clamp(Math.round(startRadius * Math.exp(deltaX / 240)), MIN_BRUSH_RADIUS, maximumRadius),
    softness: clamp(Math.round(startSoftness + deltaY / 2), 0, 100),
  };
}

// -- the view -----------------------------------------------------------------

export type MaskView = {
  /** Displayed pixels per image pixel. */
  scale: number;
  /** Where the image's top-left sits inside the viewport, in viewport pixels. */
  offsetX: number;
  offsetY: number;
};

export type Size = { width: number; height: number };

/** The zoom that shows the whole image, with a little room around it. */
export function fitMaskView(image: Size, viewport: Size, padding = 24): MaskView {
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = Math.min(usableWidth / Math.max(1, image.width), usableHeight / Math.max(1, image.height));
  return centreMaskView(image, viewport, clamp(scale, MIN_ZOOM, MAX_ZOOM));
}

export function centreMaskView(image: Size, viewport: Size, scale: number): MaskView {
  return {
    scale,
    offsetX: (viewport.width - image.width * scale) / 2,
    offsetY: (viewport.height - image.height * scale) / 2,
  };
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/**
 * Zoom about a point, keeping whatever is under it in place.
 *
 * Anchoring on the cursor is the difference between zooming in on the thing you
 * are working on and zooming in on the middle of the picture and then having to
 * find it again.
 */
export function zoomMaskView(view: MaskView, anchor: MaskPoint, nextScale: number): MaskView {
  const scale = clamp(nextScale, MIN_ZOOM, MAX_ZOOM);
  const imagePoint = imagePointFromViewport(view, anchor);
  return {
    scale,
    offsetX: anchor.x - imagePoint.x * scale,
    offsetY: anchor.y - imagePoint.y * scale,
  };
}

export function panMaskView(view: MaskView, deltaX: number, deltaY: number): MaskView {
  return { ...view, offsetX: view.offsetX + deltaX, offsetY: view.offsetY + deltaY };
}

/** Viewport pixels to image pixels. Not clamped: a stroke may start off the edge. */
export function imagePointFromViewport(view: MaskView, point: MaskPoint): MaskPoint {
  const scale = view.scale > 0 ? view.scale : 1;
  return { x: (point.x - view.offsetX) / scale, y: (point.y - view.offsetY) / scale };
}

export function viewportPointFromImage(view: MaskView, point: MaskPoint): MaskPoint {
  return { x: point.x * view.scale + view.offsetX, y: point.y * view.scale + view.offsetY };
}

/**
 * Drop points the stroke does not need.
 *
 * A pointer at 240Hz over a long drag produces thousands of points a pixel apart,
 * and they all end up in the drawing that undo, redo and every re-render walk.
 * Anything closer than a third of the brush radius cannot change the painted shape,
 * so it is dropped -- except the last point, which is where the artist let go.
 */
export function simplifyStrokePoints(points: MaskPoint[], radius: number): MaskPoint[] {
  if (points.length < 3) return points;
  const minimumStep = Math.max(0.5, radius / 3);
  const kept: MaskPoint[] = [points[0]];

  for (const point of points.slice(1, -1)) {
    const previous = kept[kept.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumStep) kept.push(point);
  }

  kept.push(points[points.length - 1]);
  return kept;
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
