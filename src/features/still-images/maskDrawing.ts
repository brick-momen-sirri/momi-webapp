// What the artist painted, in image pixels.
//
// The Image Editing preset is the only one that sends the server something the
// artist drew rather than something they uploaded, so this module holds that
// drawing in a form the rest of the app can reason about: a list of strokes in the
// source image's own coordinate space, independent of how big the editor happened
// to be showing it.
//
// Deliberately geometry only. Rasterising to a PNG needs a canvas and a decoded
// image, which is maskRaster.ts; everything here is arithmetic on plain data, so
// the stroke model, the zoom maths and the softness curve can be tested without a
// DOM. Keeping the two apart also means the strokes stay serialisable -- a stroke
// list is JSON, a canvas is not.

export type MaskPoint = { x: number; y: number };

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

export type MaskStroke = {
  tool: MaskTool;
  /** Image-space points. A brush stroke is a path; a lasso is a polygon. */
  points: MaskPoint[];
  /** Half the brush width, in image pixels. Unused by the lasso. */
  radius: number;
};

export type MaskDrawing = {
  /** The natural size of the image these strokes were painted on. */
  width: number;
  height: number;
  /** 0-100. One value for the whole mask, applied when it is rasterised. */
  softness: number;
  /** Explicit feather radius for a translated/scaled derivative such as a crop. */
  blurPixels?: number;
  strokes: MaskStroke[];
};

export const DEFAULT_MASK_SOFTNESS = 35;
export const MIN_BRUSH_RADIUS = 1;
export const MAX_BRUSH_RADIUS = 2000;

export function createMaskDrawing(width: number, height: number, softness = DEFAULT_MASK_SOFTNESS): MaskDrawing {
  return { width, height, softness, strokes: [] };
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
  return createMaskDrawing(width, height, drawing?.softness ?? DEFAULT_MASK_SOFTNESS);
}

export function appendMaskStroke(drawing: MaskDrawing, stroke: MaskStroke): MaskDrawing {
  if (!stroke.points.length) return drawing;
  return { ...drawing, strokes: [...drawing.strokes, stroke] };
}

export function undoMaskStroke(drawing: MaskDrawing): MaskDrawing {
  if (!drawing.strokes.length) return drawing;
  return { ...drawing, strokes: drawing.strokes.slice(0, -1) };
}

export function clearMaskStrokes(drawing: MaskDrawing): MaskDrawing {
  if (!drawing.strokes.length) return drawing;
  return { ...drawing, strokes: [] };
}

export function setMaskSoftness(drawing: MaskDrawing, softness: number): MaskDrawing {
  return { ...drawing, softness: clamp(Math.round(softness), 0, 100) };
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
  return Boolean(drawing?.strokes.some((stroke) => stroke.tool !== "eraser" && stroke.points.length > 0));
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
