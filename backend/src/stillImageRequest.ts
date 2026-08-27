// Validation for the Still Images half of a job submission.
//
// A still image request arrives as workflowOptions.stillImage: a preset id plus a
// bag of slider/checkbox/select values. None of it is trustworthy -- the settings
// end up as ComfyUI node parameters, so an out-of-range denoise or an unknown key
// is a graph that either fails late or renders something nobody asked for.
//
// normalizeStillImageOptions is a normalizer, not just a checker: it returns the
// settings the graph should actually be driven with. Values that are out of range,
// the wrong kind, or unknown are rejected outright; settings the UI has hidden are
// dropped; settings the caller omitted are filled from the catalogue default. What
// comes back is complete and safe to persist as-is.

import {
  acceptsStillImagePrompt,
  getStillImageCategory,
  isStillImageCategoryId,
  stillImageRequestSlotCount,
  visibleStillImageSettings,
  type StillImageOptions,
  type StillImageEditOptions,
  type StillImageSettingDefinition,
  type StillImageSettingValue,
} from "./stillImageCategories.js";
import { isStillImageSeed, randomStillImageSeed, STILL_IMAGE_MAX_SEED } from "./stillImageSeed.js";

export type { StillImageOptions };

/**
 * @param mintSeed Draws the master seed when the caller did not name one.
 *   Injected so tests can assert on a fixed seed instead of racing randomness.
 */
export function normalizeStillImageOptions(value: unknown, mintSeed: () => number = randomStillImageSeed): StillImageOptions {
  const options = plainRecord(value, "stillImage options");

  if (!isStillImageCategoryId(options.categoryId)) {
    throw new Error("stillImage categoryId is not a known still image preset.");
  }
  const category = getStillImageCategory(options.categoryId);

  // A caller-supplied seed is how "run that again" works: the client sends back
  // the seed off an earlier job. Anything else mints one, so every job accepted
  // from here on is reproducible whether or not the artist thought about it.
  if (options.seed !== undefined && !isStillImageSeed(options.seed)) {
    throw new Error(`stillImage seed must be a whole number between 0 and ${STILL_IMAGE_MAX_SEED}.`);
  }
  const seed = options.seed === undefined ? mintSeed() : (options.seed as number);

  const provided = options.settings == null ? {} : plainRecord(options.settings, "stillImage settings");
  const definitions = new Map(category.settings.map((setting) => [setting.id, setting]));

  const unknown = Object.keys(provided).find((key) => !definitions.has(key));
  if (unknown) {
    throw new Error(`Unsupported ${category.id} setting: ${unknown}.`);
  }

  // Resolve every known setting first, then decide visibility from the resolved
  // map. Visibility depends on sibling values, so a partial map would hide a
  // setting purely because the caller left its controlling checkbox out.
  const resolved: Record<string, StillImageSettingValue> = {};
  for (const setting of category.settings) {
    resolved[setting.id] =
      provided[setting.id] === undefined ? setting.defaultValue : validatedSetting(setting, provided[setting.id], category.id);
  }

  const settings: Record<string, StillImageSettingValue> = {};
  for (const setting of visibleStillImageSettings(category, resolved)) {
    settings[setting.id] = resolved[setting.id];
  }

  const edit = options.edit === undefined ? undefined : normalizedImageEdit(options.edit);
  if (edit && category.id !== "image-editing" && category.id !== "general-enhancement") {
    throw new Error("stillImage edit metadata is only supported by the Image Editing and General Enhancement presets.");
  }
  if (edit?.mode === "inpaint" && category.id !== "image-editing") {
    throw new Error("Inpaint edit metadata must use the image-editing preset.");
  }
  if (edit?.mode === "enhance" && category.id !== "general-enhancement") {
    throw new Error("Enhance edit metadata must use the general-enhancement preset.");
  }
  if (edit?.mode === "enhance" && edit.referenceSourceUrls.length) {
    throw new Error("The General Enhancement workflow does not yet support reference images.");
  }

  return edit ? { categoryId: category.id, seed, settings, edit } : { categoryId: category.id, seed, settings };
}

/**
 * Check the request's media and prompt against the preset's own rules.
 *
 * Separate from normalizeStillImageOptions because the slot count depends on the
 * settings: how many images Qwen Edit takes is only knowable once its mode and
 * imageCount are resolved.
 */
export function assertStillImageInputs(
  options: StillImageOptions,
  request: { prompt?: string; inputImages?: string[]; startFrame?: string; endFrame?: string; inputVideo?: string },
) {
  const category = getStillImageCategory(options.categoryId);

  const expectedSlots = stillImageRequestSlotCount(options);
  const images = request.inputImages ?? [];
  if (images.length !== expectedSlots) {
    throw new Error(
      `This still image preset needs exactly ${expectedSlots} input image${expectedSlots === 1 ? "" : "s"}; received ${images.length}.`,
    );
  }
  if (options.edit && options.edit.maskSourceUrl !== images[1]) {
    throw new Error("The edit mask metadata must reference input image slot 2.");
  }
  if (options.edit) {
    const referenceStart = options.edit.mode === "enhance" ? 2 : 3;
    const requestReferences = images.slice(referenceStart);
    if (
      requestReferences.length !== options.edit.referenceSourceUrls.length ||
      requestReferences.some((value, index) => value !== options.edit?.referenceSourceUrls[index])
    ) {
      throw new Error("The edit reference metadata must match the additional input image slots in order.");
    }
  }

  if (!acceptsStillImagePrompt(category, options.settings) && request.prompt?.trim()) {
    throw new Error("This still image preset does not take a prompt.");
  }

  // Frames and video belong to the Animation pipeline. Accepting them here would
  // mean carrying media into a graph with no input for it.
  if (request.startFrame || request.endFrame) {
    throw new Error("Still image presets do not take start or end frames.");
  }
  if (request.inputVideo) {
    throw new Error("Still image presets do not take an input video.");
  }
}

function validatedSetting(setting: StillImageSettingDefinition, value: unknown, categoryId: string): StillImageSettingValue {
  const label = `${categoryId} setting ${setting.id}`;

  if (setting.kind === "checkbox") {
    if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
    return value;
  }

  if (setting.kind === "select") {
    const options = setting.options ?? [];
    if (typeof value !== "string" || !options.includes(value)) {
      throw new Error(`${label} must be one of: ${options.join(", ")}.`);
    }
    return value;
  }

  // Range. `step` is a UI affordance for the slider, not a constraint worth
  // enforcing -- rejecting 0.39999999999999997 for missing the 0.01 grid would
  // fail honest requests over float noise. The bounds are what protect the graph.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  const minimum = setting.minimum ?? Number.NEGATIVE_INFINITY;
  const maximum = setting.maximum ?? Number.POSITIVE_INFINITY;
  if (value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function plainRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizedImageEdit(value: unknown): StillImageEditOptions {
  const edit = plainRecord(value, "stillImage edit metadata");
  const layerId = boundedIdentifier(edit.layerId, "stillImage edit layerId");
  if (edit.operation !== "create" && edit.operation !== "regenerate") {
    throw new Error("stillImage edit operation must be create or regenerate.");
  }
  const mode = edit.mode === undefined ? "inpaint" : edit.mode;
  if (mode !== "inpaint" && mode !== "enhance") {
    throw new Error("stillImage edit mode must be inpaint or enhance.");
  }
  const documentId =
    edit.documentId === undefined ? `legacy_${layerId}` : boundedIdentifier(edit.documentId, "stillImage edit documentId");
  const crop = normalizedCrop(edit.crop, "stillImage edit crop");
  const mask = normalizedMask(edit.mask, crop);
  const originalSourceUrl = mediaReference(edit.originalSourceUrl, "stillImage edit originalSourceUrl");
  const maskSourceUrl = mediaReference(edit.maskSourceUrl, "stillImage edit maskSourceUrl");
  const baseLayerIds = identifierArray(edit.baseLayerIds, "stillImage edit baseLayerIds");
  const rawReferences = edit.referenceSourceUrls === undefined ? [] : edit.referenceSourceUrls;
  if (!Array.isArray(rawReferences) || rawReferences.length > 3) {
    throw new Error("stillImage edit referenceSourceUrls must be an array with at most 3 entries.");
  }
  const referenceSourceUrls = rawReferences.map((entry, index) =>
    mediaReference(entry, `stillImage edit referenceSourceUrls[${index}]`),
  );
  const rawBaseLayers = edit.baseLayers === undefined ? [] : edit.baseLayers;
  if (!Array.isArray(rawBaseLayers) || rawBaseLayers.length > 100) {
    throw new Error("stillImage edit baseLayers must be an array with at most 100 entries.");
  }
  const baseLayers = rawBaseLayers.map((entry, index) => {
    const layer = plainRecord(entry, `stillImage edit baseLayers[${index}]`);
    const baseCrop = normalizedCrop(layer.crop, `stillImage edit baseLayers[${index}].crop`);
    if (baseCrop.sourceWidth !== crop.sourceWidth || baseCrop.sourceHeight !== crop.sourceHeight) {
      throw new Error(`stillImage edit baseLayers[${index}].crop must use the original image dimensions.`);
    }
    return {
      layerId: boundedIdentifier(layer.layerId, `stillImage edit baseLayers[${index}].layerId`),
      crop: baseCrop,
      generatedCropUrl: mediaReference(layer.generatedCropUrl, `stillImage edit baseLayers[${index}].generatedCropUrl`),
      maskSourceUrl: mediaReference(layer.maskSourceUrl, `stillImage edit baseLayers[${index}].maskSourceUrl`),
      ...normalizedLayerPlacement(layer, `stillImage edit baseLayers[${index}]`, baseCrop),
    };
  });
  if (
    baseLayerIds.length !== baseLayers.length ||
    baseLayerIds.some((layerId, index) => layerId !== baseLayers[index]?.layerId)
  ) {
    throw new Error("stillImage edit baseLayerIds must match baseLayers in layer order.");
  }

  return {
    layerId,
    operation: edit.operation as StillImageEditOptions["operation"],
    mode: mode as StillImageEditOptions["mode"],
    documentId,
    crop,
    mask,
    originalSourceUrl,
    maskSourceUrl,
    baseLayerIds,
    baseLayers,
    referenceSourceUrls,
    // generatedCropUrl is backend-owned and is deliberately stripped from input.
  };
}

function normalizedCrop(value: unknown, label: string) {
  const crop = plainRecord(value, label);
  const sourceWidth = boundedWholeNumber(crop.sourceWidth, `${label}.sourceWidth`, 1, 100_000);
  const sourceHeight = boundedWholeNumber(crop.sourceHeight, `${label}.sourceHeight`, 1, 100_000);
  const hasRectangularDimensions = crop.width !== undefined || crop.height !== undefined;
  if (hasRectangularDimensions && (crop.width === undefined || crop.height === undefined)) {
    throw new Error(`${label}.width and ${label}.height must be provided together.`);
  }
  const legacySize = hasRectangularDimensions
    ? undefined
    : boundedWholeNumber(crop.size, `${label}.size`, 1, Math.min(sourceWidth, sourceHeight));
  const width = hasRectangularDimensions
    ? boundedWholeNumber(crop.width, `${label}.width`, 1, sourceWidth)
    : (legacySize as number);
  const height = hasRectangularDimensions
    ? boundedWholeNumber(crop.height, `${label}.height`, 1, sourceHeight)
    : (legacySize as number);
  const x = boundedWholeNumber(crop.x, `${label}.x`, 0, sourceWidth - width);
  const y = boundedWholeNumber(crop.y, `${label}.y`, 0, sourceHeight - height);
  return { x, y, size: Math.max(width, height), width, height, sourceWidth, sourceHeight };
}

function normalizedMask(value: unknown, crop: ReturnType<typeof normalizedCrop>) {
  const mask = plainRecord(value, "stillImage edit mask");
  const width = boundedWholeNumber(mask.width, "stillImage edit mask.width", 1, 100_000);
  const height = boundedWholeNumber(mask.height, "stillImage edit mask.height", 1, 100_000);
  if (width !== crop.sourceWidth || height !== crop.sourceHeight) {
    throw new Error("stillImage edit mask dimensions must match the original image dimensions.");
  }
  const softness = boundedWholeNumber(mask.softness, "stillImage edit mask.softness", 0, 100);
  const cropMargin =
    mask.cropMargin === undefined ? undefined : boundedWholeNumber(mask.cropMargin, "stillImage edit mask.cropMargin", 0, 100);
  if (mask.cropAspect !== undefined && mask.cropAspect !== "1:1" && mask.cropAspect !== "16:9" && mask.cropAspect !== "9:16") {
    throw new Error("stillImage edit mask.cropAspect must be 1:1, 16:9, or 9:16.");
  }
  let selection: StillImageEditOptions["mask"]["selection"];
  if (mask.selection !== undefined) {
    const rectangle = plainRecord(mask.selection, "stillImage edit mask.selection");
    const x = boundedWholeNumber(rectangle.x, "stillImage edit mask.selection.x", 0, width - 1);
    const y = boundedWholeNumber(rectangle.y, "stillImage edit mask.selection.y", 0, height - 1);
    selection = {
      x,
      y,
      width: boundedWholeNumber(rectangle.width, "stillImage edit mask.selection.width", 1, width - x),
      height: boundedWholeNumber(rectangle.height, "stillImage edit mask.selection.height", 1, height - y),
    };
  }
  if (!Array.isArray(mask.strokes) || mask.strokes.length > 10_000) {
    throw new Error("stillImage edit mask.strokes must be an array with at most 10000 entries.");
  }
  let pointCount = 0;
  const strokes = mask.strokes.map((entry, strokeIndex) => {
    const stroke = plainRecord(entry, `stillImage edit mask.strokes[${strokeIndex}]`);
    if (stroke.tool !== "brush" && stroke.tool !== "eraser" && stroke.tool !== "lasso") {
      throw new Error(`stillImage edit mask.strokes[${strokeIndex}].tool is not supported.`);
    }
    const radius = finiteNumber(stroke.radius, `stillImage edit mask.strokes[${strokeIndex}].radius`, 0, 10_000);
    if (!Array.isArray(stroke.points)) {
      throw new Error(`stillImage edit mask.strokes[${strokeIndex}].points must be an array.`);
    }
    pointCount += stroke.points.length;
    if (pointCount > 100_000) throw new Error("stillImage edit mask contains too many points.");
    const points = stroke.points.map((entryPoint, pointIndex) => {
      const point = plainRecord(entryPoint, `stillImage edit mask point ${strokeIndex}.${pointIndex}`);
      return {
        x: finiteNumber(point.x, `stillImage edit mask point ${strokeIndex}.${pointIndex}.x`, -10_000, width + 10_000),
        y: finiteNumber(point.y, `stillImage edit mask point ${strokeIndex}.${pointIndex}.y`, -10_000, height + 10_000),
      };
    });
    return { tool: stroke.tool as StillImageEditOptions["mask"]["strokes"][number]["tool"], radius, points };
  });
  if (selection && strokes.length) {
    throw new Error("stillImage edit mask must use either a rectangle selection or painted strokes, not both.");
  }
  if (mask.inverted !== undefined && typeof mask.inverted !== "boolean") {
    throw new Error("stillImage edit mask.inverted must be a boolean.");
  }
  const transform = normalizedMaskTransform(mask.transform);
  return {
    width,
    height,
    softness,
    ...(cropMargin === undefined ? {} : { cropMargin }),
    ...(mask.cropAspect === undefined ? {} : { cropAspect: mask.cropAspect as "1:1" | "16:9" | "9:16" }),
    ...(selection === undefined ? {} : { selection }),
    ...(mask.inverted ? { inverted: true } : {}),
    ...(transform === undefined ? {} : { transform }),
    strokes,
  };
}

/**
 * The mask's free transform, carried through untouched.
 *
 * The client rasterises the mask before it uploads it, so nothing on this side
 * ever applies this -- it exists so that the layer the artist gets back is still
 * the layer they transformed. Bounded all the same: it is a matrix from a
 * request, and an infinity in it would reach a canvas eventually.
 */
function normalizedMaskTransform(value: unknown) {
  if (value === undefined) return undefined;
  const transform = plainRecord(value, "stillImage edit mask.transform");
  const scale = (key: "a" | "b" | "c" | "d") =>
    finiteNumber(transform[key], `stillImage edit mask.transform.${key}`, -1_000, 1_000);
  const offset = (key: "e" | "f") => finiteNumber(transform[key], `stillImage edit mask.transform.${key}`, -1_000_000, 1_000_000);
  return { a: scale("a"), b: scale("b"), c: scale("c"), d: scale("d"), e: offset("e"), f: offset("f") };
}

/**
 * A layer's opacity and its displacement, as the composite step needs them.
 *
 * Both are optional and both default to "exactly where and how it was
 * generated", so an older client that sends neither still composites the way it
 * always did. The displacement is bounded by the source rather than by the crop:
 * a layer may legitimately be dragged clear off the canvas, and the compositor
 * clips it rather than refusing it.
 */
function normalizedLayerPlacement(layer: Record<string, unknown>, label: string, crop: ReturnType<typeof normalizedCrop>) {
  const opacity = layer.opacity === undefined ? undefined : boundedWholeNumber(layer.opacity, `${label}.opacity`, 0, 100);
  const maskFeather =
    layer.maskFeather === undefined ? undefined : boundedWholeNumber(layer.maskFeather, `${label}.maskFeather`, 0, 1_000);
  let offset: { x: number; y: number } | undefined;
  if (layer.offset !== undefined) {
    const point = plainRecord(layer.offset, `${label}.offset`);
    offset = {
      x: boundedWholeNumber(point.x, `${label}.offset.x`, -crop.sourceWidth, crop.sourceWidth),
      y: boundedWholeNumber(point.y, `${label}.offset.y`, -crop.sourceHeight, crop.sourceHeight),
    };
  }
  return {
    ...(opacity === undefined || opacity === 100 ? {} : { opacity }),
    ...(maskFeather === undefined || maskFeather === 0 ? {} : { maskFeather }),
    ...(offset === undefined || (offset.x === 0 && offset.y === 0) ? {} : { offset }),
  };
}

function boundedIdentifier(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new Error(`${label} must be 8-200 letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function identifierArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array with at most 100 entries.`);
  return value.map((entry, index) => boundedIdentifier(entry, `${label}[${index}]`));
}

function mediaReference(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.length > 8192) throw new Error(`${label} must be a media URL.`);
  return value;
}

function boundedWholeNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}
