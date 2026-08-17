// Reading a Still Images job back into the form.
//
// The Animation reuse path (features/jobs/jobReuse.ts) restores a model,
// resolution and duration, none of which a preset has -- pointed at a still image
// job it silently rewrites the Animation panel instead and drops every slider the
// preset actually ran with. So the two surfaces get their own reader, and App
// picks between them on jobSection.
//
// A job's settings were normalized by the server when it was submitted, so they
// arrive valid. They are re-checked here anyway, against the catalogue as it
// stands now: a preset whose range has since narrowed or whose select lost an
// option would otherwise put a value into the form that the server will refuse
// the moment Generate is pressed.

import type { Job } from "../../types";
import { normalizeStillImageSeedInput } from "./seed";
import {
  STILL_IMAGE_CATEGORIES,
  stillImageSlotCount,
  type StillImageCategoryDefinition,
  type StillImageCategoryId,
  type StillImageCategoryState,
  type StillImageSettingDefinition,
  type StillImageSettingValue,
} from "./stillImageCategories";

export type ReusableStillImageJob = {
  categoryId: StillImageCategoryId;
  category: StillImageCategoryDefinition;
  /** Everything the form holds except the images, which the caller rehydrates. */
  state: Omit<StillImageCategoryState, "images">;
  /** How many upload slots the restored settings ask for. */
  slotCount: number;
};

export function reusableStillImageJob(job: Pick<Job, "workflowOptions" | "prompt">): ReusableStillImageJob | undefined {
  const stillImage = job.workflowOptions?.stillImage;
  if (!stillImage) return undefined;

  // Explicit lookup, not getStillImageCategory: that one falls back to the first
  // preset for an unknown id, which would quietly restore a Pro Upscaler job's
  // settings into General Enhancement.
  const category = STILL_IMAGE_CATEGORIES.find((entry) => entry.id === stillImage.categoryId);
  if (!category) return undefined;

  const saved = stillImage.settings ?? {};
  const settings: Record<string, StillImageSettingValue> = {};
  for (const setting of category.settings) {
    const value = saved[setting.id];
    settings[setting.id] = reusableSettingValue(setting, value) ?? setting.defaultValue;
  }

  const state = {
    prompt: typeof job.prompt === "string" ? job.prompt : "",
    seed: stillImage.seed === undefined ? "" : normalizeStillImageSeedInput(String(stillImage.seed)),
    settings,
  };

  return {
    categoryId: category.id,
    category,
    state,
    slotCount: stillImageSlotCount(category, { ...state, images: [] }),
  };
}

/** The saved value if the catalogue still accepts it, otherwise undefined. */
function reusableSettingValue(setting: StillImageSettingDefinition, value: unknown): StillImageSettingValue | undefined {
  if (setting.kind === "checkbox") {
    return typeof value === "boolean" ? value : undefined;
  }

  if (setting.kind === "select") {
    return typeof value === "string" && setting.options?.some((option) => option.value === value) ? value : undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const minimum = setting.minimum ?? Number.NEGATIVE_INFINITY;
  const maximum = setting.maximum ?? Number.POSITIVE_INFINITY;
  return value >= minimum && value <= maximum ? value : undefined;
}
