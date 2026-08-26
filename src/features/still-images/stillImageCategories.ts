// The Still Images preset catalogue, as the UI needs it.
//
// The table is backend/src/data/stillImagePresets.json, which the server validates
// against. It used to be duplicated here with labels attached, and the two copies
// were kept honest by asserting the same truth table on both sides -- widen a range
// in one and the server rejected a value this UI happily offered. This file now
// reads the same data and adds only what the server has no use for: labels, hints,
// icons, instruction copy and option wording.
//
// Read from backend/src rather than a neutral shared folder because backend/
// compiles with rootDir "src" and cannot reach outside it, while this side is
// bundler-resolved and can read anything inside the repo. Data only -- the two
// still cannot import each other's code, which is why the slot and prompt rules at
// the bottom are mirrored (and asserted against their counterparts in
// backend/src/stillImageCategories.test.ts).

import { Brush, ImageIcon, Images, ScanSearch, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import presets from "../../../backend/src/data/stillImagePresets.json";
import type {
  JobStatus,
  StillImageEditBaseLayer,
  StillImageEditCrop,
  StillImageEditMode,
  StillImageEditReference,
  UploadedImage,
} from "../../types";
import type { MaskDrawing } from "./maskDrawing";

export type StillImageCategoryId = "general-enhancement" | "pro-upscaler" | "reference-generator" | "qwen-edit" | "image-editing";

export type StillImageSettingValue = string | number | boolean;

export type StillImageSettingDefinition = {
  id: string;
  label: string;
  kind: "checkbox" | "range" | "select";
  defaultValue: StillImageSettingValue;
  hint?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: ReadonlyArray<{ label: string; value: string }>;
  visibleWhen?: { settingId: string; equals: StillImageSettingValue };
};

export type StillImageCategoryDefinition = {
  id: StillImageCategoryId;
  label: string;
  shortDescription: string;
  instructions: string;
  icon: LucideIcon;
  imageSlots: number;
  prompt?: {
    label: string;
    placeholder: string;
    hint: string;
  };
  settings: ReadonlyArray<StillImageSettingDefinition>;
};

export type StillImageModeGuidance = {
  title: string;
  description: string;
};

export type StillImageCategoryState = {
  images: UploadedImage[];
  prompt: string;
  /**
   * The master seed to render with, as typed. Empty means "draw a new one",
   * which is what every run did before seeds were exposed; a value here is
   * usually one restored from an earlier result to reproduce it.
   *
   * Kept as a string rather than a number so the field can be empty and so a
   * half-typed value does not have to round-trip through NaN.
   */
  seed: string;
  /**
   * The painted region, for the preset that has one.
   *
   * Held beside the images rather than inside them because it is not an upload:
   * the mask and the marked guide are drawn from it at submit time and take slots
   * 2 and 3, so what is stored here is the drawing, not its rendering. Undefined
   * for every other preset, and never persisted -- the strokes are in the source
   * image's pixels, and that image does not survive a reload either.
   */
  mask?: MaskDrawing;
  /**
   * Non-destructive Image Editing passes, ordered from bottom to top.
   *
   * A layer keeps geometry in original-image pixels. Provider/result URLs are
   * refreshed from the matching job when the workspace renders, so a long job
   * does not require copying the global job store into this form state.
   */
  editLayers?: StillImageEditLayer[];
  /** Undefined means a new edit above every existing layer. */
  activeEditLayerId?: string;
  /** One continuous editor session for this uploaded original. */
  editDocumentId?: string;
  editMode?: StillImageEditMode;
  editReferences?: UploadedImage[];
  /** Durable URL captured by the first submitted layer and reused at finalization. */
  editOriginalSourceUrl?: string;
  settings: Record<string, StillImageSettingValue>;
};

export type StillImageEditLayer = {
  id: string;
  name: string;
  mask: MaskDrawing;
  crop: StillImageEditCrop;
  prompt: string;
  mode: StillImageEditMode;
  references: StillImageEditReference[];
  documentId: string;
  originalSourceUrl?: string;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  visible: boolean;
  order: number;
  /** Changes when the mask or generated take changes, invalidating local composites. */
  revision: number;
  status: JobStatus;
  errorMessage?: string;
  resultUrl?: string;
  /** Durable backend value, safe to persist in another job's metadata. */
  generatedCropSourceUrl?: string;
  /** Browser-readable version of generatedCropSourceUrl. */
  generatedCropUrl?: string;
  maskSourceUrl?: string;
  /** Immutable crop/mask assets that formed this layer's generation input. */
  baseLayers?: StillImageEditBaseLayer[];
  /** Compact identity for the exact frozen base above. */
  baseRevisionId?: string;
  generation?: {
    jobId: string;
    workflow: "image-editing" | "general-enhancement";
    workflowPath?: string;
    modelId?: string;
    seed?: number;
    settings: Record<string, StillImageSettingValue>;
  };
};

export type StillImagesState = Record<StillImageCategoryId, StillImageCategoryState>;

/** How a setting is worded. Purely presentational; the server never sees any of it. */
type SettingPresentation = {
  label: string;
  hint?: string;
  /** Wording for each option value in the shared table, keyed by that value. */
  optionLabels?: Record<string, string>;
};

type CategoryPresentation = {
  label: string;
  shortDescription: string;
  instructions: string;
  icon: LucideIcon;
  prompt?: StillImageCategoryDefinition["prompt"];
  settings: Record<string, SettingPresentation>;
};

const PRESENTATION: Record<StillImageCategoryId, CategoryPresentation> = {
  "general-enhancement": {
    label: "General Enhancement",
    shortDescription: "Refine detail, clarity, faces, and overall image quality.",
    instructions: "Upload one image, optionally describe the desired finish, then adjust enhancement strength.",
    icon: Sparkles,
    prompt: {
      label: "Enhancement prompt",
      placeholder: "Describe the details or finish you want to preserve or enhance...",
      hint: "Optional. Guides the enhancement passes; leave empty to let the captioner describe the image on its own.",
    },
    settings: {
      generalEnhance: { label: "Enable general enhancement" },
      details: { label: "Details" },
      generalDenoise: { label: "General enhance" },
      advancedDetails: { label: "Advanced details" },
      detailPass: { label: "Additional detail pass" },
      sharpen: { label: "Sharpen" },
      bodyEnhance: { label: "Enable body enhancement" },
      bodyDenoise: { label: "Body enhancement", hint: "Strength of the body and person detail pass." },
      faceDenoise: { label: "Face enhancement", hint: "Strength of the face detail pass." },
    },
  },
  "pro-upscaler": {
    label: "Pro Upscaler",
    shortDescription: "Increase resolution with optional detail enhancement.",
    instructions: "Upload one source image and choose the upscale and enhancement preferences.",
    icon: ScanSearch,
    settings: {
      engine: { label: "Engine", optionLabels: { normal: "Normal", "super-fast": "Super Fast" } },
      upscale: { label: "Upscale value", optionLabels: { x2: "2x", x4: "4x" } },
      enhancement: { label: "Enable enhancement" },
      creativity: { label: "Creativity" },
    },
  },
  "reference-generator": {
    label: "Reference Generator",
    shortDescription: "Transfer visual qualities from a reference image.",
    instructions: "Upload a main image and a reference image, then balance color, creativity, and structure.",
    icon: Images,
    settings: {
      colorStrength: { label: "Color strength" },
      creativity: { label: "Creativity" },
      structureStrength: { label: "Structure strength" },
      enhancement: { label: "Enable enhancement" },
      colorMatch: { label: "Color match" },
    },
  },
  "image-editing": {
    label: "Image Editing",
    shortDescription: "Paint over a region and describe what should be there.",
    instructions: "Upload an image, paint the area to change, then describe the result you want in it.",
    icon: Brush,
    prompt: {
      label: "Edit prompt",
      placeholder: "Describe what should be in the painted area...",
      hint: "Say what the region should become, not what to do to it. Everything outside it is kept from the original.",
    },
    settings: {
      resolution: { label: "Output resolution", optionLabels: { "1K": "1K", "2K": "2K", "4K": "4K" } },
      thinking: {
        label: "Reasoning",
        hint: "Thorough plans the edit before drawing it. Slower, and better on instructions with more than one part.",
        optionLabels: { MINIMAL: "Fast", HIGH: "Thorough" },
      },
      markRegion: {
        label: "Show the model where",
        hint: "Sends a second copy of the image with the region washed over. Turn off if the wash is tinting results.",
      },
      preserveUnmasked: {
        label: "Pre-blend returned crop",
        hint: "Also blends the crop on the worker. The backend always applies the editable mask when rebuilding the full image, so pixels outside it remain protected.",
      },
      variations: { label: "Variations", hint: "How many to run. Each is its own job, with its own seed." },
    },
  },
  "qwen-edit": {
    label: "Qwen Edit",
    shortDescription: "Apply prompt-guided edits using up to three images.",
    instructions: "Choose the number of input images, upload them, and describe the intended edit.",
    icon: ImageIcon,
    prompt: {
      label: "Edit prompt",
      placeholder: "Describe the edit or target result...",
      hint: "Use natural instruction language. Ignored by Raw Enhancement, which drives itself from the captioner.",
    },
    settings: {
      mode: {
        label: "Mode",
        optionLabels: {
          edit: "Edit",
          "reference-transfer": "Reference Transfer",
          consistency: "Consistency",
          "raw-enhancement": "Raw Enhancement",
        },
      },
      imageCount: { label: "Image count", optionLabels: { "1": "1 image", "2": "2 images", "3": "3 images" } },
    },
  },
};

/** The shape of one entry in the shared table, which carries no wording. */
type SharedSetting = {
  id: string;
  kind: StillImageSettingDefinition["kind"];
  defaultValue: StillImageSettingValue;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: string[];
  visibleWhen?: { settingId: string; equals: StillImageSettingValue };
};

type SharedCategory = {
  id: string;
  imageSlots: number;
  acceptsPrompt: boolean;
  settings: SharedSetting[];
};

export const STILL_IMAGE_CATEGORIES: ReadonlyArray<StillImageCategoryDefinition> = (
  presets.presets as unknown as SharedCategory[]
).map(buildCategory);

/**
 * One preset, as the shared table plus this file's wording.
 *
 * Throws rather than falling back to the raw id. A setting the artist sees labelled
 * "faceDenoise", or a mode option reading "raw-enhancement", is a bug that ships
 * silently -- and the catalogue is a module constant, so this fires the moment
 * anything imports it, including every test in this directory.
 */
function buildCategory(shared: SharedCategory): StillImageCategoryDefinition {
  const presentation = PRESENTATION[shared.id as StillImageCategoryId];
  if (!presentation) {
    throw new Error(`stillImagePresets.json has a preset with no UI wording: ${shared.id}`);
  }

  return {
    id: shared.id as StillImageCategoryId,
    label: presentation.label,
    shortDescription: presentation.shortDescription,
    instructions: presentation.instructions,
    icon: presentation.icon,
    imageSlots: shared.imageSlots,
    // Only where the preset actually takes one: the field is drawn from this, and
    // the server rejects a prompt on a preset whose acceptsPrompt is false.
    prompt: shared.acceptsPrompt ? presentation.prompt : undefined,
    settings: shared.settings.map((setting) => buildSetting(shared.id, setting, presentation)),
  };
}

function buildSetting(
  categoryId: string,
  shared: SharedSetting,
  presentation: CategoryPresentation,
): StillImageSettingDefinition {
  const wording = presentation.settings[shared.id];
  if (!wording) throw new Error(`stillImagePresets.json setting ${categoryId}.${shared.id} has no UI wording.`);

  return {
    id: shared.id,
    label: wording.label,
    hint: wording.hint,
    kind: shared.kind,
    defaultValue: shared.defaultValue,
    minimum: shared.minimum,
    maximum: shared.maximum,
    step: shared.step,
    options: shared.options?.map((value) => {
      const label = wording.optionLabels?.[value];
      if (!label) throw new Error(`stillImagePresets.json option ${categoryId}.${shared.id}.${value} has no UI wording.`);
      return { label, value };
    }),
    visibleWhen: shared.visibleWhen,
  };
}

const QWEN_MODE_GUIDANCE: Record<string, StillImageModeGuidance> = {
  edit: {
    title: "Edit Mode",
    description:
      "General-purpose editing for adding, removing, or changing elements with one to three images. Natural instructions work best.",
  },
  "reference-transfer": {
    title: "Reference Transfer",
    description: "Uses two fixed inputs: the main image first and the lighting or mood reference second. No prompt is needed.",
  },
  consistency: {
    title: "Consistency",
    description:
      "Uses one image for controlled color, lighting, detail, cleanup, or style changes while preserving the original structure.",
  },
  "raw-enhancement": {
    title: "Raw Enhancement",
    description: "Uses one image to improve raw architectural renders with more realistic color, detail, and finish.",
  },
};

export function getStillImageCategory(categoryId: StillImageCategoryId) {
  return STILL_IMAGE_CATEGORIES.find((category) => category.id === categoryId) ?? STILL_IMAGE_CATEGORIES[0];
}

export function createInitialStillImagesState(): StillImagesState {
  return {
    "general-enhancement": createInitialCategoryState(getStillImageCategory("general-enhancement")),
    "pro-upscaler": createInitialCategoryState(getStillImageCategory("pro-upscaler")),
    "reference-generator": createInitialCategoryState(getStillImageCategory("reference-generator")),
    "qwen-edit": createInitialCategoryState(getStillImageCategory("qwen-edit")),
    "image-editing": createInitialCategoryState(getStillImageCategory("image-editing")),
  };
}

function createInitialCategoryState(category: StillImageCategoryDefinition): StillImageCategoryState {
  return {
    images: [],
    prompt: "",
    seed: "",
    editLayers: [],
    ...(category.id === "image-editing" ? { editMode: "inpaint" as const, editReferences: [] } : {}),
    settings: Object.fromEntries(category.settings.map((setting) => [setting.id, setting.defaultValue])),
  };
}

export function stillImageSlotCount(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
  // Source, painted mask, and -- unless the wash has been turned off -- the marked
  // guide. Only the first is an upload; see maskRaster.ts for the other two.
  if (category.id === "image-editing") return state.settings.markRegion === false ? 2 : 3;
  if (category.id === "qwen-edit") {
    const mode = String(state.settings.mode || "edit");
    if (mode === "reference-transfer") return 2;
    if (mode === "consistency" || mode === "raw-enhancement") return 1;
    return Math.max(1, Math.min(3, Number(state.settings.imageCount) || 1));
  }
  return category.imageSlots;
}

export function stillImageSlotLabels(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
  if (category.id === "image-editing") return ["Source image", "Edit mask", "Marked guide"];
  if (category.id === "reference-generator") return ["Main image", "Reference image"];
  if (category.id !== "qwen-edit") return ["Input image"];

  const mode = String(state.settings.mode || "edit");
  if (mode === "reference-transfer") return ["Main image", "Reference image"];
  if (mode === "consistency") return ["Consistency image"];
  if (mode === "raw-enhancement") return ["Raw render"];
  return Array.from({ length: stillImageSlotCount(category, state) }, (_, index) => `Image ${index + 1}`);
}

export function shouldShowStillImagePrompt(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
  if (!category.prompt) return false;
  return category.id !== "qwen-edit" || state.settings.mode !== "reference-transfer";
}

export function stillImageModeGuidance(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
  if (category.id !== "qwen-edit") return undefined;
  return QWEN_MODE_GUIDANCE[String(state.settings.mode || "edit")] ?? QWEN_MODE_GUIDANCE.edit;
}

export function visibleStillImageSettings(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
  return category.settings.filter((setting) => {
    if (!setting.visibleWhen) return true;
    return state.settings[setting.visibleWhen.settingId] === setting.visibleWhen.equals;
  });
}
