import type { Job, StillImageEditBaseLayer, StillImageEditCrop } from "../../types";
import { resolveMediaUrl } from "../../services/api/mediaAccess";
import {
  boxCorners,
  conjugateTransform,
  maskBlurPixels,
  maskGeometryBounds,
  maskInverted,
  maskTransform,
  transformPoint,
  translateMaskDrawing,
  translationTransform,
  type EditCropAspect,
  type MaskDrawing,
  type MaskPoint,
} from "./maskDrawing";
import type { StillImageCategoryState, StillImageEditLayer } from "./stillImageCategories";

export const EDIT_CROP_PADDING_RATIO = 0.5;

export type MaskBounds = { left: number; top: number; right: number; bottom: number };

/** A lightweight layer source; either editable vector mask data or a frozen mask asset. */
export type EditLayerCompositeDescriptor = {
  layerId: string;
  crop: StillImageEditCrop;
  generatedCropSourceUrl: string;
  generatedCropUrl?: string;
  mask?: MaskDrawing;
  maskSourceUrl?: string;
  revision?: number;
  /** 0-100. Applied when the layer is composited, never baked into its pixels. */
  opacity?: number;
  /** Content displacement in original-image pixels. */
  offset?: MaskPoint;
  /** Mask displacement. Equal to offset while the mask is linked. */
  maskOffset?: MaskPoint;
  /** False keeps the mask but stops it hiding anything. */
  maskEnabled?: boolean;
  /** Non-destructive mask feather in original-image pixels. */
  maskFeather?: number;
};

export const NO_LAYER_OFFSET: MaskPoint = { x: 0, y: 0 };
export const MAX_LAYER_MASK_FEATHER = 1_000;

export function layerOpacity(layer: { opacity?: number }) {
  const opacity = layer.opacity === undefined ? 100 : layer.opacity;
  return Math.min(100, Math.max(0, Math.round(opacity)));
}

export function layerOffset(layer: { offset?: MaskPoint }): MaskPoint {
  return layer.offset ?? NO_LAYER_OFFSET;
}

export function layerMaskEnabled(layer: { maskEnabled?: boolean }) {
  return layer.maskEnabled !== false;
}

export function layerMaskFeather(layer: { maskFeather?: number }) {
  return Math.min(MAX_LAYER_MASK_FEATHER, Math.max(0, Math.round(layer.maskFeather ?? 0)));
}

export function layerMaskLinked(layer: { maskLinked?: boolean }) {
  return layer.maskLinked !== false;
}

/**
 * The mask exactly as it will be rasterised, for the paths that upload one.
 *
 * The wire format carries a layer's opacity and its position but has no field
 * for a switched-off or unchained mask, so both are resolved into ordinary mask
 * geometry here: disabled becomes a mask that hides nothing, and an unchained
 * mask is written at its own position relative to the moved content. Doing it in
 * one place is what keeps the uploaded PNG, the provider crop and the final
 * composite describing the same picture.
 */
export function descriptorMaskDrawing(layer: EditLayerCompositeDescriptor): MaskDrawing | undefined {
  if (!layer.mask) return undefined;
  // Reveal the whole crop: an inverted mask with nothing painted is white.
  if (layer.maskEnabled === false) {
    return { ...layer.mask, selection: undefined, strokes: [], softness: 0, inverted: true };
  }
  const offset = layer.offset ?? NO_LAYER_OFFSET;
  const maskOffset = layer.maskOffset ?? offset;
  return translateMaskDrawing(layer.mask, maskOffset.x - offset.x, maskOffset.y - offset.y);
}

/**
 * A square crop around the supplied current mask coverage, in source pixels.
 *
 * The geometry-only positive-stroke bound remains a fallback for callers that do
 * not have a raster available. The editor and submission path supply coverageBounds
 * from the composited mask, so erased pixels cannot keep an obsolete crop alive.
 */
export function squareEditCrop(
  drawing: MaskDrawing,
  paddingRatio = EDIT_CROP_PADDING_RATIO,
  coverageBounds?: MaskBounds,
): StillImageEditCrop {
  return aspectEditCrop(drawing, "1:1", paddingRatio, coverageBounds);
}

/** A source-pixel crop that fully contains the current mask at the chosen aspect. */
export function aspectEditCrop(
  drawing: MaskDrawing,
  aspect: EditCropAspect,
  paddingRatio = EDIT_CROP_PADDING_RATIO,
  coverageBounds?: MaskBounds,
): StillImageEditCrop {
  const bounds = coverageBounds ?? positiveStrokeBounds(drawing);
  if (!bounds) throw new Error("Paint or select the region to edit before generating.");

  const sourceWidth = positiveInteger(drawing.width);
  const sourceHeight = positiveInteger(drawing.height);
  const [aspectWidth, aspectHeight] = aspect === "16:9" ? [16, 9] : aspect === "9:16" ? [9, 16] : [1, 1];
  const maximumUnit = Math.min(Math.floor(sourceWidth / aspectWidth), Math.floor(sourceHeight / aspectHeight));
  const maskWidth = Math.max(1, bounds.right - bounds.left);
  const maskHeight = Math.max(1, bounds.bottom - bounds.top);
  const minimumUnit = Math.ceil(Math.max(maskWidth / aspectWidth, maskHeight / aspectHeight));

  // Failing explicitly is safer than silently clipping part of what the artist
  // painted. Integer aspect units also keep a 16:9 crop exactly 16:9.
  if (maximumUnit < 1 || minimumUnit > maximumUnit) {
    if (aspect === "1:1") {
      throw new Error(
        "The selected region is too wide for a square crop on this image. Choose a smaller region or switch crop shape.",
      );
    }
    throw new Error(
      `The selected region is too wide or tall for a ${aspect} crop on this image. Choose a smaller region or switch to 1:1.`,
    );
  }

  const blur = drawing.selection ? 0 : maskBlurPixels(drawing.softness, sourceWidth, sourceHeight);
  const subjectSize = Math.max(maskWidth, maskHeight);
  const context = Math.max(subjectSize * Math.max(0, paddingRatio), blur * 2);
  const requestedUnit = Math.ceil(Math.max((maskWidth + context * 2) / aspectWidth, (maskHeight + context * 2) / aspectHeight));
  const unit = Math.min(maximumUnit, Math.max(minimumUnit, requestedUnit));
  const width = unit * aspectWidth;
  const height = unit * aspectHeight;
  const centreX = (bounds.left + bounds.right) / 2;
  const centreY = (bounds.top + bounds.bottom) / 2;
  const x = clampInteger(Math.round(centreX - width / 2), 0, sourceWidth - width);
  const y = clampInteger(Math.round(centreY - height / 2), 0, sourceHeight - height);

  return { x, y, size: Math.max(width, height), width, height, sourceWidth, sourceHeight };
}

/** Dimensions of new rectangular crops, with a square fallback for saved edits. */
export function editCropWidth(crop: StillImageEditCrop) {
  return positiveInteger(crop.width ?? crop.size);
}

export function editCropHeight(crop: StillImageEditCrop) {
  return positiveInteger(crop.height ?? crop.size);
}

/** Translate original-pixel strokes into the crop's pixel coordinate system. */
export function drawingForCrop(drawing: MaskDrawing, crop: StillImageEditCrop): MaskDrawing {
  return {
    ...drawing,
    width: editCropWidth(crop),
    height: editCropHeight(crop),
    blurPixels: maskBlurPixels(drawing.softness, drawing.width, drawing.height),
    // The points below move into the crop's coordinates, so a free transform
    // written against the original's has to move with them.
    transform: drawing.transform ? conjugateTransform(drawing.transform, translationTransform(-crop.x, -crop.y)) : undefined,
    selection: drawing.selection
      ? { ...drawing.selection, x: drawing.selection.x - crop.x, y: drawing.selection.y - crop.y }
      : undefined,
    strokes: drawing.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x - crop.x, y: point.y - crop.y })),
    })),
  };
}

/** Refresh transient layer result fields from the durable job store. */
export function layersWithJobs(state: StillImageCategoryState, jobs: Job[]): StillImageEditLayer[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return (state.editLayers ?? []).map((layer) => {
    const job = byId.get(layer.jobId);
    const edit = job?.workflowOptions?.stillImage?.edit;
    if (!job || edit?.layerId !== layer.id) return layer;
    return {
      ...layer,
      status: job.status,
      errorMessage: job.errorMessage,
      resultUrl: job.resultUrl ?? layer.resultUrl,
      generatedCropSourceUrl: edit.generatedCropUrl ?? layer.generatedCropSourceUrl,
      generatedCropUrl: edit.generatedCropUrl ? resolveMediaUrl(edit.generatedCropUrl) : layer.generatedCropUrl,
      maskSourceUrl: edit.maskSourceUrl ?? layer.maskSourceUrl,
      baseLayers: edit.baseLayers ?? layer.baseLayers,
      baseRevisionId: baseRevisionId(edit.baseLayers),
      mode: edit.mode,
      documentId: edit.documentId,
      originalSourceUrl: edit.originalSourceUrl,
      references: edit.referenceSourceUrls.map((sourceUrl, index) => ({
        id: `${edit.layerId}_ref_${index + 1}`,
        name: `Reference ${index + 1}`,
        sourceUrl,
      })),
      updatedAt: job.completedAt ?? job.startedAt ?? layer.updatedAt,
      generation: {
        jobId: job.id,
        workflow: job.workflowOptions?.stillImage?.categoryId === "general-enhancement" ? "general-enhancement" : "image-editing",
        workflowPath: job.workflowPath,
        modelId: job.modelId,
        seed: job.workflowOptions?.stillImage?.seed,
        settings: job.workflowOptions?.stillImage?.settings ?? {},
      },
    };
  });
}

/** Every visible layer with a completed take, including one currently regenerating. */
export function visibleEditLayers(state: StillImageCategoryState): EditLayerCompositeDescriptor[] {
  return (
    [...(state.editLayers ?? [])]
      .sort((a, b) => a.order - b.order)
      // A regenerating/failed layer can still have its last completed crop. Keep
      // showing that take until a replacement arrives instead of flashing a hole in
      // the composite for the lifetime of the job.
      .filter((layer) => layer.visible && Boolean(layer.generatedCropSourceUrl))
      .map(editLayerDescriptor)
  );
}

/**
 * The exact base used for a generation.
 *
 * Existing layers prefer their frozen asset snapshot. New edits intentionally use
 * the current visible stack. The lower-layer fallback keeps jobs created before
 * base snapshots were introduced editable without pretending they are immutable.
 */
export function editGenerationBaseLayers(state: StillImageCategoryState): EditLayerCompositeDescriptor[] {
  const active = (state.editLayers ?? []).find((layer) => layer.id === state.activeEditLayerId);
  if (active?.baseLayers !== undefined) return active.baseLayers.map(frozenLayerDescriptor);
  return lowerVisibleEditLayers(state).flatMap((layer) => (layer.generatedCropSourceUrl ? [editLayerDescriptor(layer)] : []));
}

/** Layers that form the generation input below the selected layer. */
export function lowerVisibleEditLayers(state: StillImageCategoryState): StillImageEditLayer[] {
  const ordered = [...(state.editLayers ?? [])].sort((a, b) => a.order - b.order);
  const activeIndex = state.activeEditLayerId
    ? ordered.findIndex((layer) => layer.id === state.activeEditLayerId)
    : ordered.length;
  const ceiling = activeIndex < 0 ? ordered.length : activeIndex;
  return ordered.slice(0, ceiling).filter((layer) => layer.visible && Boolean(layer.generatedCropSourceUrl));
}

export function baseRevisionId(layers: StillImageEditBaseLayer[]) {
  return layers.length
    ? `base:${layers
        .map(
          (layer) =>
            `${layer.layerId}@${layer.generatedCropUrl}:${layer.opacity ?? 100}:${layer.maskFeather ?? 0}:${layer.offset?.x ?? 0},${layer.offset?.y ?? 0}`,
        )
        .join("|")}`
    : "base:original";
}

function editLayerDescriptor(layer: StillImageEditLayer): EditLayerCompositeDescriptor {
  const offset = layerOffset(layer);
  return {
    layerId: layer.id,
    crop: layer.crop,
    generatedCropSourceUrl: layer.generatedCropSourceUrl as string,
    generatedCropUrl: layer.generatedCropUrl,
    mask: layer.mask,
    maskSourceUrl: layer.maskSourceUrl,
    revision: layer.revision,
    opacity: layerOpacity(layer),
    offset,
    maskOffset: layerMaskLinked(layer) ? offset : NO_LAYER_OFFSET,
    maskEnabled: layerMaskEnabled(layer),
    maskFeather: layerMaskFeather(layer),
  };
}

function frozenLayerDescriptor(layer: StillImageEditBaseLayer): EditLayerCompositeDescriptor {
  return {
    layerId: layer.layerId,
    crop: layer.crop,
    generatedCropSourceUrl: layer.generatedCropUrl,
    generatedCropUrl: resolveMediaUrl(layer.generatedCropUrl),
    maskSourceUrl: layer.maskSourceUrl,
    opacity: layerOpacity(layer),
    maskFeather: layerMaskFeather(layer),
    offset: layer.offset,
  };
}

function positiveStrokeBounds(drawing: MaskDrawing): MaskBounds | undefined {
  // Inverting turns everything the artist did not paint into coverage, and the
  // only bound that is certainly right for that is the whole image. Callers that
  // can afford the raster pass supply exact coverageBounds instead.
  if (maskInverted(drawing)) return { left: 0, top: 0, right: drawing.width, bottom: drawing.height };
  const box = maskGeometryBounds(drawing);
  if (!box) return undefined;

  // A transformed mask occupies the upright box around its four carried corners.
  // Wider than the shape itself when it is rotated, which is the safe direction:
  // this is the fallback for callers with no raster, and a crop that is slightly
  // too generous still contains everything the artist painted.
  const transform = maskTransform(drawing);
  const corners = boxCorners(box).map((corner) => transformPoint(transform, corner));
  const bounds = {
    left: Math.min(...corners.map((corner) => corner.x)),
    top: Math.min(...corners.map((corner) => corner.y)),
    right: Math.max(...corners.map((corner) => corner.x)),
    bottom: Math.max(...corners.map((corner) => corner.y)),
  };
  return {
    left: clamp(bounds.left, 0, drawing.width),
    top: clamp(bounds.top, 0, drawing.height),
    right: clamp(bounds.right, 0, drawing.width),
    bottom: clamp(bounds.bottom, 0, drawing.height),
  };
}

function positiveInteger(value: number) {
  return Math.max(1, Math.round(value));
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.round(clamp(value, minimum, maximum));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
