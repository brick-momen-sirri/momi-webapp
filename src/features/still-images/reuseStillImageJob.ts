// Reading a Still Images job back into the form.
//
// The Animation reuse path (features/jobs/jobReuse.ts) restores a model,
// resolution and duration, none of which a preset has -- pointed at a still image
// job it silently rewrites the Animation panel instead and drops every slider the
// preset actually ran with. So the two surfaces get their own reader, and App
// picks between them on jobSection.
//
// A job's settings were normalized by the server when it was submitted, so they
// arrive valid. They are re-checked against the catalogue as it stands now --
// savedSettings.ts owns that, shared with the persisted panel state, which reads
// back settings of exactly the same age and doubtfulness.

import type { Job } from "../../types";
import { stillImageSettingsFromSaved } from "./savedSettings";
import { normalizeStillImageSeedInput } from "./seed";
import {
  STILL_IMAGE_CATEGORIES,
  stillImageSlotCount,
  type StillImageCategoryDefinition,
  type StillImageCategoryId,
  type StillImageCategoryState,
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

  const state = {
    prompt: typeof job.prompt === "string" ? job.prompt : "",
    seed: stillImage.seed === undefined ? "" : normalizeStillImageSeedInput(String(stillImage.seed)),
    settings: stillImageSettingsFromSaved(category, stillImage.settings),
  };

  return {
    categoryId: category.id,
    category,
    state,
    slotCount: stillImageSlotCount(category, { ...state, images: [] }),
  };
}
