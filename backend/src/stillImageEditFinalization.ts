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
  return {
    layerId: boundedString(layer.layerId, `Layer ${index + 1} id`, 160),
    crop: parseCrop(layer.crop, index),
    generatedCropUrl: boundedString(layer.generatedCropUrl, `Layer ${index + 1} result`, 8_192),
    maskSourceUrl: boundedString(layer.maskSourceUrl, `Layer ${index + 1} mask`, 8_192),
  };
}

function parseCrop(value: unknown, index: number): StillImageEditCrop {
  const crop = record(value, `Layer ${index + 1} crop`);
  const parsed = {
    x: integer(crop.x, "Crop x", 0),
    y: integer(crop.y, "Crop y", 0),
    size: integer(crop.size, "Crop size", 1),
    sourceWidth: integer(crop.sourceWidth, "Source width", 1),
    sourceHeight: integer(crop.sourceHeight, "Source height", 1),
  };
  if (parsed.x + parsed.size > parsed.sourceWidth || parsed.y + parsed.size > parsed.sourceHeight) {
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
