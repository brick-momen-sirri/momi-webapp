// The Still Images preset catalogue, as the server needs it for validation.
//
// The table itself is data/stillImagePresets.json, which the UI reads too. It used
// to be duplicated: this file held the validation table and
// src/features/still-images/stillImageCategories.ts held its own copy with labels
// attached, and the two were kept honest by asserting the same truth table on both
// sides -- widen a range in one and the server rejected a value the UI happily
// offered. There is now one table, and this file only gives it types and the rules
// that read it.
//
// The rules below are still mirrored on the UI side, because the two cannot import
// each other's code (rootDir "src" and NodeNext specifiers here, bundler resolution
// and lucide there). They are three small functions rather than a hundred-line
// table, and stillImageCategories.test.ts asserts them against their counterparts.
//
// Ports the General Enhancement controls from momi-forge (General_Enhancement_v04.py,
// graph workflow_api_flux_dev_1.19). Field names differ; the graph wiring will
// need the correspondence:
//   generalEnhance   -> general_enhance          (routing)
//   details          -> details                  -> 37.strength_model
//   generalDenoise   -> general_denoise          -> 32.denoise
//   advancedDetails  -> advance_details          (routing)
//   detailPass       -> additional_detail_pass   -> 23.denoise
//   sharpen          -> sharpen                  -> 74.blend_factor
//   bodyEnhance      -> body_enhance             (routing)
//   bodyDenoise      -> body_enhancement_denoise -> 52.denoise
//   faceDenoise      -> face_enhancement_denoise -> 54.denoise
//
// The three checkboxes are not graph booleans -- each rewires which branch feeds
// the save node, over an 8-case matrix. See GENERAL_ENHANCEMENT_WORKFLOW_README.md
// in momi-forge.
//
// forge exposes mask_b64 and has_drawn_mask, which route 13.mask between nodes 85
// and 88. Ordinary General Enhancement submissions keep the generated-mask route
// (13.mask <- 85); Enhance actions from the integrated editor activate the drawn
// route. Image Editing carries its mask as an ordinary image slot instead -- see
// applyImageEditing.

import presets from "./data/stillImagePresets.json" with { type: "json" };

export type StillImageCategoryId = "general-enhancement" | "pro-upscaler" | "reference-generator" | "qwen-edit" | "image-editing";

export type StillImageSettingValue = string | number | boolean;

export type StillImageSettingDefinition = {
  id: string;
  kind: "checkbox" | "range" | "select";
  defaultValue: StillImageSettingValue;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: readonly string[];
  visibleWhen?: { settingId: string; equals: StillImageSettingValue };
};

export type StillImageCategoryDefinition = {
  id: StillImageCategoryId;
  /** Slots for presets with a fixed input count. qwen-edit varies -- see stillImageSlotCount. */
  imageSlots: number;
  acceptsPrompt: boolean;
  settings: readonly StillImageSettingDefinition[];
};

/**
 * What a still image submission carries, and what gets persisted on the job.
 *
 * Lives here rather than in types.ts so the pure-type module stays a leaf. Only
 * ever produced by normalizeStillImageOptions -- `settings` is complete (every
 * visible setting present) and pre-validated, so consumers do not re-check it.
 */
export type StillImageOptions = {
  categoryId: StillImageCategoryId;
  /**
   * The master seed every sampler in the graph is derived from, so a run can be
   * reproduced exactly by submitting it again.
   *
   * Optional only for jobs recorded before seeds were persisted: those replay
   * with a fresh random seed, which is what they did when they were submitted.
   * normalizeStillImageOptions mints one for everything new, so any job accepted
   * from now on carries it.
   */
  seed?: number;
  settings: Record<string, StillImageSettingValue>;
  edit?: StillImageEditOptions;
};

export type StillImageEditCrop = {
  x: number;
  y: number;
  size: number;
  width?: number;
  height?: number;
  sourceWidth: number;
  sourceHeight: number;
};

export type StillImageEditMask = {
  width: number;
  height: number;
  softness: number;
  cropMargin?: number;
  cropAspect?: "1:1" | "16:9" | "9:16";
  selection?: { x: number; y: number; width: number; height: number };
  /** The mask covers everything the strokes do not. Round-tripped, never applied here. */
  inverted?: boolean;
  /** A free transform on the mask, as canvas takes it. Round-tripped, never applied here. */
  transform?: { a: number; b: number; c: number; d: number; e: number; f: number };
  strokes: Array<{
    tool: "brush" | "eraser" | "lasso";
    radius: number;
    points: Array<{ x: number; y: number }>;
  }>;
};

export type StillImageEditBaseLayer = {
  layerId: string;
  crop: StillImageEditCrop;
  generatedCropUrl: string;
  maskSourceUrl: string;
  /** Photoshop layer opacity, 0-100. Absent means fully opaque. */
  opacity?: number;
  /** Non-destructive user-mask feather in source-image pixels. */
  maskFeather?: number;
  /** Where the layer's pixels now sit relative to the crop they were generated in. */
  offset?: { x: number; y: number };
};

export type StillImageEditMode = "inpaint" | "enhance";

export type StillImageEditOptions = {
  layerId: string;
  operation: "create" | "regenerate";
  mode: StillImageEditMode;
  documentId: string;
  crop: StillImageEditCrop;
  mask: StillImageEditMask;
  originalSourceUrl: string;
  maskSourceUrl: string;
  baseLayerIds: string[];
  baseLayers: StillImageEditBaseLayer[];
  referenceSourceUrls: string[];
  generatedCropUrl?: string;
};

export const STILL_IMAGE_CATEGORY_IDS: readonly StillImageCategoryId[] = [
  "general-enhancement",
  "pro-upscaler",
  "reference-generator",
  "qwen-edit",
  "image-editing",
];

/**
 * The catalogue, as read from the shared table.
 *
 * Asserted rather than parsed: this file ships with the JSON and tsc emits the two
 * together, so a shape mismatch is a broken build, not untrusted input. What the
 * cast cannot check -- that every id is a known preset, every kind is a real kind,
 * and every default falls inside its own bounds -- assertCatalogueShape does, once,
 * at load. A malformed table would otherwise surface as a graph parameter that is
 * quietly the wrong type.
 */
export const STILL_IMAGE_CATEGORIES: readonly StillImageCategoryDefinition[] = assertCatalogueShape(
  presets.presets as unknown as StillImageCategoryDefinition[],
);

function assertCatalogueShape(categories: StillImageCategoryDefinition[]) {
  const seen = new Set<string>();
  for (const category of categories) {
    if (!isStillImageCategoryId(category.id)) {
      throw new Error(`stillImagePresets.json names an unknown preset: ${String(category.id)}`);
    }
    if (seen.has(category.id)) throw new Error(`stillImagePresets.json lists ${category.id} twice.`);
    seen.add(category.id);
    if (!Number.isInteger(category.imageSlots) || category.imageSlots < 1) {
      throw new Error(`stillImagePresets.json gives ${category.id} an impossible imageSlots.`);
    }
    for (const setting of category.settings) {
      assertSettingShape(category.id, setting);
    }
  }
  const missing = STILL_IMAGE_CATEGORY_IDS.filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`stillImagePresets.json is missing presets: ${missing.join(", ")}`);
  return categories;
}

function assertSettingShape(categoryId: string, setting: StillImageSettingDefinition) {
  const label = `${categoryId} setting ${setting.id}`;
  if (setting.kind === "select") {
    if (!setting.options?.length) throw new Error(`${label} is a select with no options.`);
    if (!setting.options.includes(String(setting.defaultValue))) {
      throw new Error(`${label} defaults to a value that is not one of its options.`);
    }
    return;
  }
  if (setting.kind === "checkbox") {
    if (typeof setting.defaultValue !== "boolean") throw new Error(`${label} is a checkbox with a non-boolean default.`);
    return;
  }
  // Range. The bounds are what protect the graph from a value it cannot use, so a
  // default outside them would be a preset that fails the moment it is submitted
  // untouched.
  const { defaultValue, minimum, maximum } = setting;
  if (typeof defaultValue !== "number" || minimum === undefined || maximum === undefined) {
    throw new Error(`${label} is a range without a numeric default and bounds.`);
  }
  if (minimum > maximum) throw new Error(`${label} has a minimum above its maximum.`);
  if (defaultValue < minimum || defaultValue > maximum) {
    throw new Error(`${label} defaults to ${defaultValue}, outside its own ${minimum}..${maximum} bounds.`);
  }
}

/**
 * A checkbox as the slot and prompt rules see it.
 *
 * Defaults to true on an absent value because both callers read settings whose
 * preset default is true; a bag that predates the setting must behave as the
 * preset does, not as an unchecked box.
 */
function flagSetting(settings: Record<string, StillImageSettingValue>, id: string) {
  return settings[id] !== false;
}

export function isStillImageCategoryId(value: unknown): value is StillImageCategoryId {
  return typeof value === "string" && STILL_IMAGE_CATEGORY_IDS.includes(value as StillImageCategoryId);
}

export function getStillImageCategory(categoryId: StillImageCategoryId) {
  const category = STILL_IMAGE_CATEGORIES.find((entry) => entry.id === categoryId);
  if (!category) throw new Error(`Unknown still image category: ${categoryId}`);
  return category;
}

/**
 * How many input images this preset expects.
 *
 * MUST stay in step with stillImageSlotCount in the frontend catalogue. The UI
 * decides how many upload slots to draw; this side decides how many inputImages
 * the request may carry. If they disagree, an artist fills every slot the UI
 * offers and the submission is rejected -- or worse, a third image is accepted
 * for a two-input graph and silently ignored.
 */
export function stillImageSlotCount(category: StillImageCategoryDefinition, settings: Record<string, StillImageSettingValue>) {
  // Slot 1 is the source, slot 2 the painted mask, slot 3 the same source with the
  // masked region washed over. The wash is what tells Nano Banana where to work;
  // with markRegion off it is not uploaded at all, so the request carries two.
  if (category.id === "image-editing") return flagSetting(settings, "markRegion") ? 3 : 2;
  if (category.id !== "qwen-edit") return category.imageSlots;

  const mode = String(settings.mode ?? "edit");
  if (mode === "reference-transfer") return 2;
  if (mode === "consistency" || mode === "raw-enhancement" || mode === "realistic") return 1;
  return Math.max(1, Math.min(3, Number(settings.imageCount) || 1));
}

/** Variable editor inputs layered on top of the catalogue's ordinary slot rules. */
export function stillImageRequestSlotCount(options: StillImageOptions) {
  if (!options.edit) return stillImageSlotCount(getStillImageCategory(options.categoryId), options.settings);
  const fixed = options.edit.mode === "enhance" ? 2 : 3;
  return fixed + options.edit.referenceSourceUrls.length;
}

/**
 * Does this preset take a prompt in its current configuration?
 *
 * MUST stay in step with shouldShowStillImagePrompt in the frontend catalogue.
 * Reference Transfer is the one mode that hides the prompt field, and a prompt
 * that arrives anyway would be written into a graph that has nowhere to put it.
 */
export function acceptsStillImagePrompt(
  category: StillImageCategoryDefinition,
  settings: Record<string, StillImageSettingValue>,
) {
  if (!category.acceptsPrompt) return false;
  return category.id !== "qwen-edit" || settings.mode !== "reference-transfer";
}

/**
 * The settings that apply given the current configuration.
 *
 * MUST stay in step with visibleStillImageSettings in the frontend catalogue: a
 * setting the UI has hidden is one the artist cannot see the value of, so it must
 * not reach the graph.
 */
export function visibleStillImageSettings(
  category: StillImageCategoryDefinition,
  settings: Record<string, StillImageSettingValue>,
) {
  return category.settings.filter((setting) => {
    if (!setting.visibleWhen) return true;
    return settings[setting.visibleWhen.settingId] === setting.visibleWhen.equals;
  });
}
