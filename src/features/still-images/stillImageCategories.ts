// The Still Images preset catalogue, as the UI needs it.
//
// The validation-relevant half MUST stay in step with backend/src/stillImageCategories.ts:
// setting ids, kinds, defaults, range bounds, select option values, visibility
// rules, and the slot/prompt rules below. This file owns the presentation on top
// of that -- labels, hints, icons, instruction copy -- which the server has no
// use for.
//
// The pair cannot share a module: backend/ compiles with rootDir "src" and cannot
// reach into the app tree, and this copy pulls in lucide. Following the precedent
// of creditEstimator.ts and saveNumber.ts/jobFilters.ts, the two are kept honest
// by asserting the same truth table on both sides -- see the sibling test file and
// backend/src/stillImageCategories.test.ts. Widen a range here without widening it
// there and the server rejects a value this UI happily offers.

import { ImageIcon, Images, ScanSearch, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { UploadedImage } from "../../types";

export type StillImageCategoryId = "general-enhancement" | "pro-upscaler" | "reference-generator" | "qwen-edit";

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
  settings: Record<string, StillImageSettingValue>;
};

export type StillImagesState = Record<StillImageCategoryId, StillImageCategoryState>;

export const STILL_IMAGE_CATEGORIES: ReadonlyArray<StillImageCategoryDefinition> = [
  {
    id: "general-enhancement",
    label: "General Enhancement",
    shortDescription: "Refine detail, clarity, faces, and overall image quality.",
    instructions: "Upload one image, optionally describe the desired finish, then adjust enhancement strength.",
    icon: Sparkles,
    imageSlots: 1,
    prompt: {
      label: "Enhancement prompt",
      placeholder: "Describe the details or finish you want to preserve or enhance...",
      hint: "Optional guidance for the future enhancement workflow.",
    },
    settings: [
      { id: "generalEnhance", label: "Enable general enhancement", kind: "checkbox", defaultValue: true },
      { id: "details", label: "Details", kind: "range", defaultValue: 1, minimum: 0, maximum: 2, step: 0.05 },
      {
        id: "generalDenoise",
        label: "General enhance",
        kind: "range",
        defaultValue: 0.1,
        minimum: 0,
        maximum: 0.45,
        step: 0.01,
        visibleWhen: { settingId: "generalEnhance", equals: true },
      },
      { id: "advancedDetails", label: "Advanced details", kind: "checkbox", defaultValue: false },
      {
        id: "detailPass",
        label: "Additional detail pass",
        kind: "range",
        defaultValue: 0.35,
        minimum: 0,
        maximum: 0.7,
        step: 0.01,
        visibleWhen: { settingId: "advancedDetails", equals: true },
      },
      {
        id: "sharpen",
        label: "Sharpen",
        kind: "range",
        defaultValue: 0.4,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        visibleWhen: { settingId: "advancedDetails", equals: true },
      },
      { id: "bodyEnhance", label: "Enable body enhancement", kind: "checkbox", defaultValue: false },
      {
        id: "bodyDenoise",
        label: "Body enhancement",
        kind: "range",
        defaultValue: 0.2,
        minimum: 0,
        maximum: 0.3,
        step: 0.01,
        hint: "Strength of the body and person detail pass.",
        visibleWhen: { settingId: "bodyEnhance", equals: true },
      },
      {
        id: "faceDenoise",
        label: "Face enhancement",
        kind: "range",
        defaultValue: 0.2,
        minimum: 0,
        maximum: 0.3,
        step: 0.01,
        hint: "Strength of the face detail pass.",
        visibleWhen: { settingId: "bodyEnhance", equals: true },
      },
    ],
  },
  {
    id: "pro-upscaler",
    label: "Pro Upscaler",
    shortDescription: "Increase resolution with optional detail enhancement.",
    instructions: "Upload one source image and choose the upscale and enhancement preferences.",
    icon: ScanSearch,
    imageSlots: 1,
    settings: [
      {
        id: "engine",
        label: "Engine",
        kind: "select",
        defaultValue: "normal",
        options: [
          { label: "Normal", value: "normal" },
          { label: "Super Fast", value: "super-fast" },
        ],
      },
      {
        id: "upscale",
        label: "Upscale value",
        kind: "select",
        defaultValue: "x2",
        options: [
          { label: "2x", value: "x2" },
          { label: "4x", value: "x4" },
        ],
      },
      { id: "enhancement", label: "Enable enhancement", kind: "checkbox", defaultValue: true },
      {
        id: "creativity",
        label: "Creativity",
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
    label: "Reference Generator",
    shortDescription: "Transfer visual qualities from a reference image.",
    instructions: "Upload a main image and a reference image, then balance color, creativity, and structure.",
    icon: Images,
    imageSlots: 2,
    settings: [
      { id: "colorStrength", label: "Color strength", kind: "range", defaultValue: 0.9, minimum: 0, maximum: 1, step: 0.01 },
      { id: "creativity", label: "Creativity", kind: "range", defaultValue: 0.5, minimum: 0, maximum: 1, step: 0.01 },
      {
        id: "structureStrength",
        label: "Structure strength",
        kind: "range",
        defaultValue: 0.8,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      },
      { id: "enhancement", label: "Enable enhancement", kind: "checkbox", defaultValue: true },
      {
        id: "colorMatch",
        label: "Color match",
        kind: "checkbox",
        defaultValue: false,
        visibleWhen: { settingId: "enhancement", equals: true },
      },
    ],
  },
  {
    id: "qwen-edit",
    label: "Qwen Edit",
    shortDescription: "Apply prompt-guided edits using up to three images.",
    instructions: "Choose the number of input images, upload them, and describe the intended edit.",
    icon: ImageIcon,
    imageSlots: 1,
    prompt: {
      label: "Edit prompt",
      placeholder: "Describe the edit or target result...",
      hint: "Use natural instruction language. The prompt stays local until backend integration is added.",
    },
    settings: [
      {
        id: "mode",
        label: "Mode",
        kind: "select",
        defaultValue: "edit",
        options: [
          { label: "Edit", value: "edit" },
          { label: "Reference Transfer", value: "reference-transfer" },
          { label: "Consistency", value: "consistency" },
          { label: "Raw Enhancement", value: "raw-enhancement" },
        ],
      },
      {
        id: "imageCount",
        label: "Image count",
        kind: "select",
        defaultValue: "1",
        options: [
          { label: "1 image", value: "1" },
          { label: "2 images", value: "2" },
          { label: "3 images", value: "3" },
        ],
        visibleWhen: { settingId: "mode", equals: "edit" },
      },
    ],
  },
];

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
  };
}

function createInitialCategoryState(category: StillImageCategoryDefinition): StillImageCategoryState {
  return {
    images: [],
    prompt: "",
    settings: Object.fromEntries(category.settings.map((setting) => [setting.id, setting.defaultValue])),
  };
}

export function stillImageSlotCount(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
  if (category.id === "qwen-edit") {
    const mode = String(state.settings.mode || "edit");
    if (mode === "reference-transfer") return 2;
    if (mode === "consistency" || mode === "raw-enhancement") return 1;
    return Math.max(1, Math.min(3, Number(state.settings.imageCount) || 1));
  }
  return category.imageSlots;
}

export function stillImageSlotLabels(category: StillImageCategoryDefinition, state: StillImageCategoryState) {
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
