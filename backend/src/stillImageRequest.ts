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
  stillImageSlotCount,
  visibleStillImageSettings,
  type StillImageOptions,
  type StillImageSettingDefinition,
  type StillImageSettingValue,
} from "./stillImageCategories.js";

export type { StillImageOptions };

export function normalizeStillImageOptions(value: unknown): StillImageOptions {
  const options = plainRecord(value, "stillImage options");

  if (!isStillImageCategoryId(options.categoryId)) {
    throw new Error("stillImage categoryId is not a known still image preset.");
  }
  const category = getStillImageCategory(options.categoryId);

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

  return { categoryId: category.id, settings };
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

  const expectedSlots = stillImageSlotCount(category, options.settings);
  const images = request.inputImages ?? [];
  if (images.length !== expectedSlots) {
    throw new Error(
      `This still image preset needs exactly ${expectedSlots} input image${expectedSlots === 1 ? "" : "s"}; received ${images.length}.`,
    );
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
