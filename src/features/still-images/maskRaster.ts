// Turning a painted mask or rectangle selection into the images the graph is sent.
//
// The Image Editing preset uploads three slots: the source the artist chose, a
// black-and-white mask, and the source with the masked region washed over. Only
// the first exists as a file; the other two are drawn here, at the source's own
// resolution, from the source-coordinate geometry in maskDrawing.ts.
//
// Both go up as PNG. The mask has to be lossless -- a JPEG's ringing along a hard
// edge would read as a gradient in ImageToMask and bleed the edit past where it
// was painted -- and the guide is the same picture the model is asked to match, so
// it is not the place to introduce artefacts either.
//
// Everything is rendered opaque. The mask is flattened onto black before it leaves
// this module because ComfyUI's LoadImage drops the alpha channel rather than
// compositing it, so a mask with transparent holes would arrive holding whatever
// happened to be under them.

import type { StillImageEditCrop } from "../../types";
import { aspectEditCrop, drawingForCrop, editCropHeight, editCropWidth, type MaskBounds } from "./imageEditLayers";
import {
  conjugateTransform,
  imagePointFromViewport,
  isIdentityTransform,
  maskBlurPixels,
  maskCropAspect,
  maskCropMargin,
  maskTransform,
  scaleTransform,
  type MaskDrawing,
  type MaskPoint,
  type MaskStroke,
  type MaskView,
} from "./maskDrawing";

/**
 * The wash colour on the guide.
 *
 * Magenta because it has to be a colour the model reads as a marker rather than as
 * part of the scene, and the reds and oranges that annotation tools usually reach
 * for are ordinary colours in the architectural renders this runs on. Kept in step
 * with the system prompt in workflow-still-images/image-editing.json, which names
 * it -- change one and the other stops describing what arrives.
 */
const GUIDE_WASH = "rgba(255, 0, 255, 0.45)";
const EDITOR_CORE = "rgba(20, 184, 166, 0.26)";
const EDITOR_FEATHER = "rgba(94, 234, 212, 0.14)";
const EDITOR_EDGE = "rgba(204, 251, 241, 0.82)";
const DEFAULT_CROP_SAMPLE_SIDE = 768;

export type MaskRenderTarget = HTMLCanvasElement;

/**
 * Painted strokes or a rectangle selection as coverage, on a transparent canvas.
 *
 * The shared step behind both outputs: the mask flattens it onto black, the guide
 * tints it. Erasers are `destination-out`, which is why this stage has to keep an
 * alpha channel even though nothing that leaves this module does.
 */
export function renderMaskAlphaCanvas(drawing: MaskDrawing): HTMLCanvasElement {
  const canvas = createCanvas(drawing.width, drawing.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  context.lineCap = "round";
  context.lineJoin = "round";
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#ffffff";

  // The free transform is set on the context rather than applied to each point,
  // so a scaled brush stroke gets a scaled pen and a rotated selection is a
  // rotated rectangle -- both of which drawing pre-transformed points with an
  // untransformed pen would get wrong.
  const transform = maskTransform(drawing);
  const transformed = !isIdentityTransform(transform);
  if (transformed) context.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);

  if (drawing.selection) {
    context.fillRect(drawing.selection.x, drawing.selection.y, drawing.selection.width, drawing.selection.height);
  }

  for (const stroke of drawing.strokes) {
    context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    paintStroke(context, stroke);
  }

  context.globalCompositeOperation = "source-over";
  if (transformed) context.setTransform(1, 0, 0, 1, 0, 0);
  // Inversion is a whole-mask operation, so it happens after every stroke has been
  // composited rather than per stroke: punching the painted shape out of a full
  // sheet is the only way overlapping brush and eraser work still add up to one
  // region once it is flipped.
  if (!drawing.inverted) return canvas;

  const complement = createCanvas(drawing.width, drawing.height);
  const complementContext = complement.getContext("2d");
  if (!complementContext) return canvas;
  complementContext.fillStyle = "#ffffff";
  complementContext.fillRect(0, 0, complement.width, complement.height);
  complementContext.globalCompositeOperation = "destination-out";
  complementContext.drawImage(canvas, 0, 0);
  complementContext.globalCompositeOperation = "source-over";
  return complement;
}

function paintStroke(context: CanvasRenderingContext2D, stroke: MaskStroke) {
  if (!stroke.points.length) return;

  if (stroke.tool === "lasso") {
    // Closed automatically: the artist releases wherever they release, and an open
    // polygon would leak the fill across the whole image.
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.fill();
    return;
  }

  // A tap is a dab, not a zero-length line, which most canvas implementations
  // decline to draw at all.
  // Erasers extend slightly past their nominal edge. Re-compositing two identical
  // antialiased paths with destination-out otherwise leaves a faint alpha fringe,
  // which is visually gone but would keep the old coverage bound alive.
  const eraserEdge = stroke.tool === "eraser" ? 1.5 : 0;
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(stroke.points[0].x, stroke.points[0].y, stroke.radius + eraserEdge, 0, Math.PI * 2);
    context.fill();
    return;
  }

  context.lineWidth = stroke.radius * 2 + eraserEdge * 2;
  context.beginPath();
  context.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
}

/** White where the edit may go, black where the source must survive. */
export function renderMaskCanvas(drawing: MaskDrawing): HTMLCanvasElement {
  const ink = renderCompositeMaskAlphaCanvas(drawing);
  const canvas = createCanvas(drawing.width, drawing.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  context.fillStyle = "#000000";
  context.fillRect(0, 0, drawing.width, drawing.height);
  context.drawImage(ink, 0, 0);
  return canvas;
}

/**
 * The mask alpha used by every live composite.
 *
 * Brush softness belongs to the drawing; layer feather belongs to the layer.
 * Applying them as two non-destructive passes preserves that distinction while
 * still producing the exact alpha channel Canvas needs for destination-in.
 */
export function renderCompositeMaskAlphaCanvas(drawing: MaskDrawing, layerFeatherPixels = 0): HTMLCanvasElement {
  const ink = renderMaskAlphaCanvas(drawing);
  const brushSoftness = blurPixels(drawing);
  const softened = brushSoftness > 0 ? featherMaskAlphaCanvas(ink, brushSoftness) : ink;
  return layerFeatherPixels > 0 ? featherMaskAlphaCanvas(softened, layerFeatherPixels) : softened;
}

/** Blur an alpha mask without flattening or changing its source pixels. */
export function featherMaskAlphaCanvas(mask: CanvasImageSource, featherPixels: number) {
  const sourceWidth = "width" in mask ? Number(mask.width) : 0;
  const sourceHeight = "height" in mask ? Number(mask.height) : 0;
  const canvas = createCanvas(sourceWidth, sourceHeight);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const feather = Math.max(0, Number.isFinite(featherPixels) ? featherPixels : 0);
  context.filter = feather > 0 ? `blur(${feather}px)` : "none";
  context.drawImage(mask, 0, 0, canvas.width, canvas.height);
  context.filter = "none";
  return canvas;
}

/**
 * A small black-and-white preview of a mask, for the Layers panel.
 *
 * Photoshop shows the mask beside the layer's pixels precisely because a mask is
 * hard to reason about from a checkbox. Drawn at thumbnail scale rather than full
 * size and then shrunk by CSS: this is re-rendered on every stroke of the
 * selected layer, and a 6000px mask per keystroke is not a thumbnail budget.
 */
export function renderMaskThumbnailCanvas(drawing: MaskDrawing, maximumSide = 128, layerFeatherPixels = 0): HTMLCanvasElement {
  const scale = Math.min(1, maximumSide / Math.max(1, drawing.width, drawing.height));
  const scaled = scaledDrawing(drawing, scale);
  const alpha = renderCompositeMaskAlphaCanvas(scaled, layerFeatherPixels * scale);
  const canvas = createCanvas(alpha.width, alpha.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(alpha, 0, 0);
  return canvas;
}

/** Convert an opaque black/white saved mask into an alpha canvas for local compositing. */
export function maskImageToAlphaCanvas(mask: CanvasImageSource, width: number, height: number) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.drawImage(mask, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const luminance = Math.round(pixels.data[index] * 0.2126 + pixels.data[index + 1] * 0.7152 + pixels.data[index + 2] * 0.0722);
    pixels.data[index] = 255;
    pixels.data[index + 1] = 255;
    pixels.data[index + 2] = 255;
    pixels.data[index + 3] = luminance;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/** The source with the chosen region washed over, for the model to read. */
export function renderGuideCanvas(source: CanvasImageSource, drawing: MaskDrawing): HTMLCanvasElement {
  const ink = renderMaskAlphaCanvas(drawing);
  const canvas = createCanvas(drawing.width, drawing.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  context.drawImage(source, 0, 0, drawing.width, drawing.height);
  context.drawImage(tintCanvas(ink, GUIDE_WASH), 0, 0);
  return canvas;
}

/**
 * The same wash, as a canvas the editor can draw through its own transform.
 *
 * Separate from renderGuideCanvas because the editor needs the wash without the
 * source under it: it draws the image itself, at whatever pan and zoom is current,
 * and layers this on top. Returning the canvas rather than painting into the
 * editor's context is what lets the editor memoise it -- rebuilding a 4K ink layer
 * on every animation frame of a drag is the difference between a smooth stroke and
 * a stuttering one.
 */
export function renderOverlayCanvas(drawing: MaskDrawing): HTMLCanvasElement {
  // The editor stretches this overlay through the same image transform, so it
  // does not need one backing pixel per original pixel. Capping the preview keeps
  // a 10K source from allocating a second 400 MB canvas during ordinary painting.
  const scale = Math.min(1, 2048 / Math.max(1, drawing.width, drawing.height));
  const scaled = scaledDrawing(drawing, scale);
  const ink = renderMaskAlphaCanvas(scaled);
  const feather = createCanvas(ink.width, ink.height);
  const featherContext = feather.getContext("2d");
  if (featherContext) {
    featherContext.filter = blurFilter(scaled);
    featherContext.drawImage(ink, 0, 0);
    featherContext.filter = "none";
  }

  const overlay = createCanvas(ink.width, ink.height);
  const context = overlay.getContext("2d");
  if (!context) return overlay;
  context.drawImage(tintCanvas(feather, EDITOR_FEATHER), 0, 0);
  context.drawImage(tintCanvas(ink, EDITOR_CORE), 0, 0);
  context.drawImage(outlineCanvas(ink, EDITOR_EDGE), 0, 0);
  return overlay;
}

/**
 * A restrained Photoshop-style mask view for an existing generated layer.
 *
 * The composite itself already shows what the mask reveals, so painting another
 * coloured sheet over it obscures the very edge the artist is trying to refine.
 * A neutral keyline plus a whisper of the feather keeps the mask discoverable
 * without changing the apparent colour of the result beneath it.
 */
export function renderMaskEditOverlayCanvas(drawing: MaskDrawing): HTMLCanvasElement {
  const scale = Math.min(1, 2048 / Math.max(1, drawing.width, drawing.height));
  const scaled = scaledDrawing(drawing, scale);
  const alpha = renderCompositeMaskAlphaCanvas(scaled);
  const overlay = createCanvas(alpha.width, alpha.height);
  const context = overlay.getContext("2d");
  if (!context) return overlay;

  context.globalAlpha = 0.08;
  context.drawImage(tintCanvas(alpha, "rgba(255, 255, 255, 0.72)"), 0, 0);
  context.globalAlpha = 1;
  context.drawImage(outlineCanvas(alpha, "rgba(0, 0, 0, 0.88)", 2), 0, 0);
  context.drawImage(outlineCanvas(alpha, "rgba(255, 255, 255, 0.96)"), 0, 0);
  return overlay;
}

/** The wash colour, for the in-progress stroke the editor draws itself. */
export const MASK_DRAFT_COLOUR = EDITOR_CORE;
export const MASK_DRAFT_FEATHER_COLOUR = EDITOR_FEATHER;
export const MASK_DRAFT_EDGE = EDITOR_EDGE;

/**
 * Bounds of the mask after every brush, lasso and eraser has been composited.
 *
 * The editor and submission use the same bounded raster resolution. Expanding
 * the detected pixel cells back into source coordinates makes the result
 * conservative by at most one sample pixel while keeping live erasing responsive
 * on very large source images.
 */
export function maskCoverageBounds(drawing: MaskDrawing, maximumSide = DEFAULT_CROP_SAMPLE_SIDE): MaskBounds | undefined {
  // A rectangle is already exact source-pixel geometry; sampling it would expand
  // its edges by up to one low-resolution sample cell and weaken precise stitching.
  if (drawing.selection) {
    return {
      left: drawing.selection.x,
      top: drawing.selection.y,
      right: drawing.selection.x + drawing.selection.width,
      bottom: drawing.selection.y + drawing.selection.height,
    };
  }
  const scale = Math.min(1, Math.max(1, maximumSide) / Math.max(1, drawing.width, drawing.height));
  const sample = renderMaskAlphaCanvas(scaledDrawing({ ...drawing, softness: 0 }, scale));
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;

  try {
    const { data } = context.getImageData(0, 0, sample.width, sample.height);
    return maskBoundsFromPixels(data, sample.width, sample.height, scale, drawing.width, drawing.height);
  } catch {
    return undefined;
  }
}

/** The selected-aspect crop around what is covered now, not historical strokes. */
export function currentMaskEditCrop(
  drawing: MaskDrawing,
  paddingRatio = maskCropMargin(drawing) / 100,
  maximumSide = DEFAULT_CROP_SAMPLE_SIDE,
) {
  const bounds = maskCoverageBounds(drawing, maximumSide);
  return bounds ? aspectEditCrop(drawing, maskCropAspect(drawing), paddingRatio, bounds) : undefined;
}

export function maskBoundsFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
  sourceWidth: number,
  sourceHeight: number,
): MaskBounds | undefined {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return undefined;

  const safeScale = scale > 0 ? scale : 1;
  return {
    left: Math.max(0, Math.floor(left / safeScale)),
    top: Math.max(0, Math.floor(top / safeScale)),
    right: Math.min(sourceWidth, Math.ceil((right + 1) / safeScale)),
    bottom: Math.min(sourceHeight, Math.ceil((bottom + 1) / safeScale)),
  };
}

export type EditCompositeLayerSource = {
  image: CanvasImageSource;
  crop: StillImageEditCrop;
  drawing?: MaskDrawing;
  /** Frozen crop-local mask asset used when reproducing an older layer base. */
  mask?: CanvasImageSource;
  /** 0-100, Photoshop's layer opacity. Applied to the masked layer as a whole. */
  opacity?: number;
  /** Non-destructive content displacement, in original-image pixels. */
  offset?: MaskPoint;
  /** Mask displacement. Equal to offset while the mask is linked to its layer. */
  maskOffset?: MaskPoint;
  /** A disabled mask reveals the layer's whole crop, exactly as in Photoshop. */
  maskEnabled?: boolean;
  /** Non-destructive layer-mask feather in original-image pixels. */
  maskFeather?: number;
};

const NO_OFFSET: MaskPoint = { x: 0, y: 0 };

/** Photoshop layer opacity as a canvas alpha, with the 100% default. */
function layerAlpha(layer: EditCompositeLayerSource) {
  const opacity = layer.opacity === undefined ? 100 : layer.opacity;
  return Math.min(1, Math.max(0, opacity / 100));
}

/**
 * Build only the crop sent to the provider, directly from original pixels.
 *
 * Existing layers are pasted into this small canvas in order. No full-resolution
 * composite canvas is allocated, which keeps a 10K original from being duplicated
 * merely to edit a few hundred pixels around a mask.
 */
export function renderEditCropCanvas(
  source: CanvasImageSource,
  crop: StillImageEditCrop,
  layers: EditCompositeLayerSource[] = [],
): HTMLCanvasElement {
  const cropWidth = editCropWidth(crop);
  const cropHeight = editCropHeight(crop);
  const canvas = createCanvas(cropWidth, cropHeight);
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  context.drawImage(source, crop.x, crop.y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  for (const layer of layers) {
    const alpha = layerAlpha(layer);
    if (alpha <= 0) continue;
    const layerWidth = editCropWidth(layer.crop);
    const layerHeight = editCropHeight(layer.crop);
    const offset = layer.offset ?? NO_OFFSET;
    // An unlinked mask keeps its own position; a linked one rides the content.
    const maskOffset = layer.maskOffset ?? offset;
    const pixels = createCanvas(cropWidth, cropHeight);
    const layerContext = pixels.getContext("2d");
    if (!layerContext) continue;
    layerContext.drawImage(
      layer.image,
      layer.crop.x + offset.x - crop.x,
      layer.crop.y + offset.y - crop.y,
      layerWidth,
      layerHeight,
    );
    if (layer.maskEnabled !== false) {
      layerContext.globalCompositeOperation = "destination-in";
      if (layer.drawing) {
        // Already in this crop's coordinates, so only the mask's own displacement
        // is left to apply.
        layerContext.drawImage(
          renderCompositeMaskAlphaCanvas(drawingForCrop(layer.drawing, crop), layer.maskFeather),
          maskOffset.x,
          maskOffset.y,
        );
      } else if (layer.mask) {
        const alphaMask = featherMaskAlphaCanvas(layer.mask, layer.maskFeather ?? 0);
        layerContext.drawImage(
          alphaMask,
          layer.crop.x + maskOffset.x - crop.x,
          layer.crop.y + maskOffset.y - crop.y,
          layerWidth,
          layerHeight,
        );
      } else {
        continue;
      }
      layerContext.globalCompositeOperation = "source-over";
    }
    context.globalAlpha = alpha;
    context.drawImage(pixels, 0, 0);
    context.globalAlpha = 1;
  }

  return canvas;
}

/** A bounded editor/thumbnail preview of the same ordered layer composite. */
export function renderEditCompositePreview(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  layers: EditCompositeLayerSource[] = [],
  maximumSide = 1600,
): HTMLCanvasElement {
  const scale = Math.min(1, maximumSide / Math.max(1, sourceWidth, sourceHeight));
  const canvas = createCanvas(sourceWidth * scale, sourceHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  for (const layer of layers) {
    const alpha = layerAlpha(layer);
    if (alpha <= 0) continue;
    const offset = layer.offset ?? NO_OFFSET;
    const maskOffset = layer.maskOffset ?? offset;
    const width = Math.max(1, Math.round(editCropWidth(layer.crop) * scale));
    const height = Math.max(1, Math.round(editCropHeight(layer.crop) * scale));
    const left = Math.round((layer.crop.x + offset.x) * scale);
    const top = Math.round((layer.crop.y + offset.y) * scale);
    const maskLeft = Math.round((layer.crop.x + maskOffset.x) * scale);
    const maskTop = Math.round((layer.crop.y + maskOffset.y) * scale);
    const pixels = createCanvas(canvas.width, canvas.height);
    const layerContext = pixels.getContext("2d");
    if (!layerContext) continue;
    layerContext.drawImage(layer.image, left, top, width, height);
    if (layer.maskEnabled !== false) {
      layerContext.globalCompositeOperation = "destination-in";
      if (layer.drawing) {
        const cropDrawing = scaledDrawing(drawingForCrop(layer.drawing, layer.crop), scale);
        layerContext.drawImage(
          renderCompositeMaskAlphaCanvas(cropDrawing, (layer.maskFeather ?? 0) * scale),
          maskLeft,
          maskTop,
          width,
          height,
        );
      } else if (layer.mask) {
        const alphaMask = featherMaskAlphaCanvas(layer.mask, (layer.maskFeather ?? 0) * scale);
        layerContext.drawImage(alphaMask, maskLeft, maskTop, width, height);
      } else {
        continue;
      }
      layerContext.globalCompositeOperation = "source-over";
    }
    context.globalAlpha = alpha;
    context.drawImage(pixels, 0, 0);
    context.globalAlpha = 1;
  }

  return canvas;
}

/**
 * Does the flattened mask actually cover anything?
 *
 * hasPaintedRegion answers the structural question -- is there a non-eraser stroke
 * -- but an artist who paints and then erases the same area has strokes and no
 * coverage, and sending that would hand the model a mask it can put nothing
 * through. Sampled on a small copy: this runs on every stroke, and reading the
 * pixels of a 6000px mask to answer a yes/no question is not worth a frame.
 */
export function maskHasCoverage(drawing: MaskDrawing, sampleSize = 128) {
  return Boolean(maskCoverageBounds(drawing, sampleSize));
}

function scaledDrawing(drawing: MaskDrawing, scale: number): MaskDrawing {
  if (scale >= 1) return drawing;
  return {
    ...drawing,
    width: Math.max(1, Math.round(drawing.width * scale)),
    height: Math.max(1, Math.round(drawing.height * scale)),
    blurPixels: drawing.blurPixels === undefined ? undefined : drawing.blurPixels * scale,
    // Every point below is rewritten into smaller coordinates, so the transform
    // has to be re-expressed in them or it would be applied twice over.
    transform: drawing.transform
      ? conjugateTransform(drawing.transform, scaleTransform({ x: 0, y: 0 }, scale, scale))
      : undefined,
    selection: drawing.selection
      ? {
          x: drawing.selection.x * scale,
          y: drawing.selection.y * scale,
          width: drawing.selection.width * scale,
          height: drawing.selection.height * scale,
        }
      : undefined,
    strokes: drawing.strokes.map((stroke) => ({
      ...stroke,
      radius: stroke.radius * scale,
      points: stroke.points.map((point) => ({ x: point.x * scale, y: point.y * scale })),
    })),
  };
}

function tintCanvas(ink: HTMLCanvasElement, colour: string) {
  const canvas = createCanvas(ink.width, ink.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.drawImage(ink, 0, 0);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = colour;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function outlineCanvas(ink: HTMLCanvasElement, colour: string, radius = 1) {
  const canvas = createCanvas(ink.width, ink.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const tinted = tintCanvas(ink, colour);

  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (!x && !y) continue;
      context.drawImage(tinted, x, y);
    }
  }
  context.globalCompositeOperation = "destination-out";
  context.drawImage(ink, 0, 0);
  context.globalCompositeOperation = "source-over";
  return canvas;
}

function blurPixels(drawing: MaskDrawing) {
  // Rectangle selection is an exact hard-edged edit boundary. Brush softness is
  // deliberately ignored so the returned result cannot bleed past that box.
  if (drawing.selection) return 0;
  const blur = drawing.blurPixels ?? maskBlurPixels(drawing.softness, drawing.width, drawing.height);
  return Math.max(0, blur);
}

function blurFilter(drawing: MaskDrawing) {
  const blur = blurPixels(drawing);
  return blur > 0 ? `blur(${blur}px)` : "none";
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export async function canvasToPngFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`Could not read the ${name} back off the canvas.`);
  return new File([blob], name, { type: "image/png" });
}

/**
 * Decode an image URL to something a canvas can draw, at its natural size.
 *
 * crossOrigin is set so a source served from the backend can still be read back
 * out of the canvas -- without it the mask coverage check would hit a tainted
 * canvas on every saved image.
 */
export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not open that image."));
    image.src = url;
  });
}

/** Where a pointer event landed, in image pixels. */
export function pointerImagePoint(event: { clientX: number; clientY: number }, element: HTMLElement, view: MaskView) {
  const bounds = element.getBoundingClientRect();
  return imagePointFromViewport(view, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
}
