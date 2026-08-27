import type { StillImageEditBaseLayer, StillImageEditCrop } from "./stillImageCategories.js";

export type FinalizeStillImageEditRequest = {
  projectId: string;
  targetFolderId: string | null;
  documentId: string;
  originalSourceUrl: string;
  prompt: string;
  saveNumber: string;
  layers: StillImageEditBaseLayer[];
};

/** Parse the small, local-only request that turns an editor session into one result. */
export function parseFinalizeStillImageEditRequest(value: unknown): FinalizeStillImageEditRequest {
  const body = record(value, "Final composite request");
  const rawLayers = Array.isArray(body.layers) ? body.layers : [];
  if (!rawLayers.length) throw new Error("Generate at least one visible edit layer before finishing.");
  if (rawLayers.length > 100) throw new Error("A composite cannot contain more than 100 layers.");

  return {
    projectId: boundedString(body.projectId, "Project", 160),
    targetFolderId: optionalString(body.targetFolderId, "Target folder", 160),
    documentId: boundedString(body.documentId, "Edit document", 160),
    originalSourceUrl: boundedString(body.originalSourceUrl, "Original image", 8_192),
    prompt: optionalString(body.prompt, "Prompt", 12_000) ?? "",
    saveNumber: normalizeSaveNumber(body.saveNumber),
    layers: rawLayers.map(parseLayer),
  };
}

function parseLayer(value: unknown, index: number): StillImageEditBaseLayer {
  const layer = record(value, `Layer ${index + 1}`);
  const crop = parseCrop(layer.crop, index);
  return {
    layerId: boundedString(layer.layerId, `Layer ${index + 1} id`, 160),
    crop,
    generatedCropUrl: boundedString(layer.generatedCropUrl, `Layer ${index + 1} result`, 8_192),
    maskSourceUrl: boundedString(layer.maskSourceUrl, `Layer ${index + 1} mask`, 8_192),
    ...parsePlacement(layer, index, crop),
  };
}

/** Opacity and displacement, both optional, both defaulting to "as generated". */
function parsePlacement(layer: Record<string, unknown>, index: number, crop: StillImageEditCrop) {
  const opacity = layer.opacity === undefined ? undefined : boundedInteger(layer.opacity, `Layer ${index + 1} opacity`, 0, 100);
  let offset: { x: number; y: number } | undefined;
  if (layer.offset !== undefined) {
    const point = record(layer.offset, `Layer ${index + 1} offset`);
    offset = {
      x: boundedInteger(point.x, `Layer ${index + 1} offset x`, -crop.sourceWidth, crop.sourceWidth),
      y: boundedInteger(point.y, `Layer ${index + 1} offset y`, -crop.sourceHeight, crop.sourceHeight),
    };
  }
  return {
    ...(opacity === undefined || opacity === 100 ? {} : { opacity }),
    ...(offset === undefined || (offset.x === 0 && offset.y === 0) ? {} : { offset }),
  };
}

function parseCrop(value: unknown, index: number): StillImageEditCrop {
  const crop = record(value, `Layer ${index + 1} crop`);
  const hasRectangularDimensions = crop.width !== undefined || crop.height !== undefined;
  if (hasRectangularDimensions && (crop.width === undefined || crop.height === undefined)) {
    throw new Error(`Layer ${index + 1} crop width and height must be provided together.`);
  }
  const legacySize = hasRectangularDimensions ? undefined : integer(crop.size, "Crop size", 1);
  const width = hasRectangularDimensions ? integer(crop.width, "Crop width", 1) : (legacySize as number);
  const height = hasRectangularDimensions ? integer(crop.height, "Crop height", 1) : (legacySize as number);
  const parsed = {
    x: integer(crop.x, "Crop x", 0),
    y: integer(crop.y, "Crop y", 0),
    size: Math.max(width, height),
    width,
    height,
    sourceWidth: integer(crop.sourceWidth, "Source width", 1),
    sourceHeight: integer(crop.sourceHeight, "Source height", 1),
  };
  if (parsed.x + parsed.width > parsed.sourceWidth || parsed.y + parsed.height > parsed.sourceHeight) {
    throw new Error(`Layer ${index + 1} crop is outside the source image.`);
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} is too long.`);
  return result;
}

function optionalString(value: unknown, label: string, maximum: number) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} is too long.`);
  return result || null;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function integer(value: unknown, label: string, minimum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function normalizeSaveNumber(value: unknown) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!digits) throw new Error("Camera number is required.");
  return digits.padStart(4, "0");
}
