// The Still Images preset catalogue, as the server needs it for validation.
//
// MUST stay in step with src/features/still-images/stillImageCategories.ts. That
// file owns the UI: labels, hints, icons, instruction copy. This one owns only
// what a request can be judged against -- setting ids, kinds, defaults, ranges,
// option values, visibility rules, and how many image slots a preset takes.
//
// The two files are deliberately not shared through a package: backend/ compiles
// with rootDir "src" and cannot reach into the app tree, and the frontend copy
// pulls in lucide icons the server has no use for. Following the precedent set by
// creditEstimator.ts and saveNumber.ts/jobFilters.ts, the pair is kept honest by
// asserting the same truth table on both sides -- see stillImageCategories.test.ts
// and its counterpart in src/features/still-images/. A drift in a range bound or
// an option value fails one of them.

export type StillImageCategoryId = "general-enhancement" | "pro-upscaler" | "reference-generator" | "qwen-edit";

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
  settings: Record<string, StillImageSettingValue>;
};

export const STILL_IMAGE_CATEGORY_IDS: readonly StillImageCategoryId[] = [
  "general-enhancement",
  "pro-upscaler",
  "reference-generator",
  "qwen-edit",
];

export const STILL_IMAGE_CATEGORIES: readonly StillImageCategoryDefinition[] = [
  {
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
    // Deliberately not ported: the mask editor. forge exposes mask_b64 and
    // has_drawn_mask, which route 13.mask between nodes 85 and 88. This UI has no
    // mask surface, so the wiring must always take the generated-mask route
    // (13.mask <- 85), the same as forge's has_drawn_mask = false.
    id: "general-enhancement",
    imageSlots: 1,
    acceptsPrompt: true,
    settings: [
      { id: "generalEnhance", kind: "checkbox", defaultValue: true },
      { id: "details", kind: "range", defaultValue: 1, minimum: 0, maximum: 2, step: 0.05 },
      {
        id: "generalDenoise",
        kind: "range",
        defaultValue: 0.1,
        minimum: 0,
        maximum: 0.45,
        step: 0.01,
        visibleWhen: { settingId: "generalEnhance", equals: true },
      },
      { id: "advancedDetails", kind: "checkbox", defaultValue: false },
      {
        id: "detailPass",
        kind: "range",
        defaultValue: 0.35,
        minimum: 0,
        maximum: 0.7,
        step: 0.01,
        visibleWhen: { settingId: "advancedDetails", equals: true },
      },
      {
        id: "sharpen",
        kind: "range",
        defaultValue: 0.4,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        visibleWhen: { settingId: "advancedDetails", equals: true },
      },
      { id: "bodyEnhance", kind: "checkbox", defaultValue: false },
      {
        id: "bodyDenoise",
        kind: "range",
        defaultValue: 0.2,
        minimum: 0,
        maximum: 0.3,
        step: 0.01,
        visibleWhen: { settingId: "bodyEnhance", equals: true },
      },
      {
        id: "faceDenoise",
        kind: "range",
        defaultValue: 0.2,
        minimum: 0,
        maximum: 0.3,
        step: 0.01,
        visibleWhen: { settingId: "bodyEnhance", equals: true },
      },
    ],
  },
  {
    id: "pro-upscaler",
    imageSlots: 1,
    acceptsPrompt: false,
    settings: [
      { id: "engine", kind: "select", defaultValue: "normal", options: ["normal", "super-fast"] },
      { id: "upscale", kind: "select", defaultValue: "x2", options: ["x2", "x4"] },
      { id: "enhancement", kind: "checkbox", defaultValue: true },
      {
        id: "creativity",
        kind: "range",
        defaultValue: 30,
        minimum: 10,
        maximum: 40,
        step: 5,
        visibleWhen: { settingId: "enhancement", equals: true },
      },
    ],
  },
  {
    id: "reference-generator",
    imageSlots: 2,
    acceptsPrompt: false,
    settings: [
      { id: "colorStrength", kind: "range", defaultValue: 0.9, minimum: 0, maximum: 1, step: 0.01 },
      { id: "creativity", kind: "range", defaultValue: 0.5, minimum: 0, maximum: 1, step: 0.01 },
      { id: "structureStrength", kind: "range", defaultValue: 0.8, minimum: 0, maximum: 1, step: 0.01 },
      { id: "enhancement", kind: "checkbox", defaultValue: true },
      {
        id: "colorMatch",
        kind: "checkbox",
        defaultValue: false,
        visibleWhen: { settingId: "enhancement", equals: true },
      },
    ],
  },
  {
    id: "qwen-edit",
    imageSlots: 1,
    acceptsPrompt: true,
    settings: [
      {
        id: "mode",
        kind: "select",
        defaultValue: "edit",
        options: ["edit", "reference-transfer", "consistency", "raw-enhancement"],
      },
      {
        id: "imageCount",
        kind: "select",
        defaultValue: "1",
        options: ["1", "2", "3"],
        visibleWhen: { settingId: "mode", equals: "edit" },
      },
    ],
  },
];

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
  if (category.id !== "qwen-edit") return category.imageSlots;

  const mode = String(settings.mode ?? "edit");
  if (mode === "reference-transfer") return 2;
  if (mode === "consistency" || mode === "raw-enhancement") return 1;
  return Math.max(1, Math.min(3, Number(settings.imageCount) || 1));
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
