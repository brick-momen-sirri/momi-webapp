import type { Job, StillImageEditBaseLayer, StillImageEditCrop } from "../../types";
import { resolveMediaUrl } from "../../services/api/mediaAccess";
import { maskBlurPixels, type MaskDrawing, type MaskPoint } from "./maskDrawing";
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
};

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
  const bounds = coverageBounds ?? positiveStrokeBounds(drawing);
  if (!bounds) throw new Error("Paint the region to edit before generating.");

  const sourceWidth = positiveInteger(drawing.width);
  const sourceHeight = positiveInteger(drawing.height);
  const maximumSquare = Math.min(sourceWidth, sourceHeight);
  const maskWidth = Math.max(1, bounds.right - bounds.left);
  const maskHeight = Math.max(1, bounds.bottom - bounds.top);

  // A square wholly inside a non-square source cannot contain a region wider or
  // taller than its short edge. Failing explicitly is safer than silently sending
  // only part of what the artist painted.
  if (maskWidth > maximumSquare || maskHeight > maximumSquare) {
    throw new Error("The painted region is too wide for a square crop on this image. Paint a smaller region and try again.");
  }

  const blur = maskBlurPixels(drawing.softness, sourceWidth, sourceHeight);
  const subjectSize = Math.max(maskWidth, maskHeight);
  const context = Math.max(subjectSize * Math.max(0, paddingRatio), maximumSquare * 0.04, blur * 2);
  const size = Math.min(maximumSquare, Math.max(1, Math.ceil(subjectSize + context * 2)));
  const centreX = (bounds.left + bounds.right) / 2;
  const centreY = (bounds.top + bounds.bottom) / 2;
  const x = clampInteger(Math.round(centreX - size / 2), 0, sourceWidth - size);
  const y = clampInteger(Math.round(centreY - size / 2), 0, sourceHeight - size);

  return { x, y, size, sourceWidth, sourceHeight };
}

/** Translate original-pixel strokes into the crop's pixel coordinate system. */
export function drawingForCrop(drawing: MaskDrawing, crop: StillImageEditCrop): MaskDrawing {
  return {
    ...drawing,
    width: crop.size,
    height: crop.size,
    blurPixels: maskBlurPixels(drawing.softness, drawing.width, drawing.height),
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
    ? `base:${layers.map((layer) => `${layer.layerId}@${layer.generatedCropUrl}`).join("|")}`
    : "base:original";
}

function editLayerDescriptor(layer: StillImageEditLayer): EditLayerCompositeDescriptor {
  return {
    layerId: layer.id,
    crop: layer.crop,
    generatedCropSourceUrl: layer.generatedCropSourceUrl as string,
    generatedCropUrl: layer.generatedCropUrl,
    mask: layer.mask,
    maskSourceUrl: layer.maskSourceUrl,
    revision: layer.revision,
  };
}

function frozenLayerDescriptor(layer: StillImageEditBaseLayer): EditLayerCompositeDescriptor {
  return {
    layerId: layer.layerId,
    crop: layer.crop,
    generatedCropSourceUrl: layer.generatedCropUrl,
    generatedCropUrl: resolveMediaUrl(layer.generatedCropUrl),
    maskSourceUrl: layer.maskSourceUrl,
  };
}

function positiveStrokeBounds(drawing: MaskDrawing): MaskBounds | undefined {
  let bounds: MaskBounds | undefined;
  for (const stroke of drawing.strokes) {
    if (stroke.tool === "eraser" || !stroke.points.length) continue;
    const radius = stroke.tool === "lasso" ? 0 : Math.max(0, stroke.radius);
    for (const point of stroke.points) bounds = includePoint(bounds, point, radius);
  }
  if (!bounds) return undefined;
  return {
    left: clamp(bounds.left, 0, drawing.width),
    top: clamp(bounds.top, 0, drawing.height),
    right: clamp(bounds.right, 0, drawing.width),
    bottom: clamp(bounds.bottom, 0, drawing.height),
  };
}

function includePoint(bounds: MaskBounds | undefined, point: MaskPoint, radius: number): MaskBounds {
  const next = { left: point.x - radius, top: point.y - radius, right: point.x + radius, bottom: point.y + radius };
  if (!bounds) return next;
  return {
    left: Math.min(bounds.left, next.left),
    top: Math.min(bounds.top, next.top),
    right: Math.max(bounds.right, next.right),
    bottom: Math.max(bounds.bottom, next.bottom),
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
