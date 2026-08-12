// Still Images presets as WorkflowModels.
//
// The job pipeline is model-shaped throughout: buildQueuedJob and executeRunpodJob
// both start from getWorkflowModel(job.modelId), and the job record stores
// modelName, category, outputType and workflowPath. Rather than carve a
// model-less path through all of that, each preset is presented as a model.
//
// These are NOT in modelsCache and never come from loadWorkflowModels. That cache
// backs GET /api/models, which is the Animation picker, and four local-GPU presets
// have no business there -- they would be selectable against the shared endpoint.
// getWorkflowModel falls back to this registry so a preset id resolves, while
// getWorkflowModels stays Animation-only.

import { isStillImageCategoryId, STILL_IMAGE_CATEGORY_IDS, type StillImageCategoryId } from "./stillImageCategories.js";
import { stillImagePreset, stillImageWorkflowPath } from "./stillImageWorkflow.js";
import type { ModelCategory, WorkflowModel } from "./types.js";

const MODEL_ID_PREFIX = "still_";

/**
 * The model id for a preset.
 *
 * MUST stay in step with stillImageModelId in src/features/still-images/. The
 * client sends this alongside workflowOptions.stillImage, and the submission route
 * rejects a request where the two disagree, so a drift here is a 400 rather than a
 * job wired to the wrong preset.
 */
export function stillImageModelId(categoryId: StillImageCategoryId) {
  return `${MODEL_ID_PREFIX}${categoryId}`;
}

export function stillImageCategoryIdFromModelId(modelId: string): StillImageCategoryId | undefined {
  if (!modelId.startsWith(MODEL_ID_PREFIX)) return undefined;
  const categoryId = modelId.slice(MODEL_ID_PREFIX.length);
  return isStillImageCategoryId(categoryId) ? categoryId : undefined;
}

export function isStillImageModelId(modelId: string) {
  return stillImageCategoryIdFromModelId(modelId) !== undefined;
}

export function stillImageWorkflowModel(modelId: string): WorkflowModel | undefined {
  const categoryId = stillImageCategoryIdFromModelId(modelId);
  return categoryId ? buildStillImageModel(categoryId) : undefined;
}

export function stillImageWorkflowModels(): WorkflowModel[] {
  return STILL_IMAGE_CATEGORY_IDS.map(buildStillImageModel);
}

type StillImageModelMetadata = {
  name: string;
  category: ModelCategory;
  /**
   * Advisory only. Real spend comes back from the worker as credit_usage and lands
   * on job.creditsActual; this figure drives the pre-flight display. These are
   * placeholders pending a measured run on each pod -- unlike the Animation models,
   * whose costs are provider list prices, these are GPU-seconds on our own pods.
   */
  estimatedCredits: number;
  estimatedTime: string;
};

const MODEL_METADATA: Record<StillImageCategoryId, StillImageModelMetadata> = {
  "general-enhancement": {
    name: "General Enhancement",
    category: "image_editing",
    estimatedCredits: 12,
    estimatedTime: "1-4 min",
  },
  "pro-upscaler": {
    name: "Pro Upscaler",
    category: "image_upscaling",
    // The heaviest of the four: SeedVR plus a tiled Flux pass at up to x4.
    estimatedCredits: 24,
    estimatedTime: "3-8 min",
  },
  "reference-generator": {
    name: "Reference Generator",
    category: "image_editing",
    estimatedCredits: 10,
    estimatedTime: "1-3 min",
  },
  "qwen-edit": {
    name: "Qwen Edit",
    category: "image_editing",
    estimatedCredits: 8,
    estimatedTime: "1-3 min",
  },
};

function buildStillImageModel(categoryId: StillImageCategoryId): WorkflowModel {
  const metadata = MODEL_METADATA[categoryId];
  const preset = stillImagePreset(categoryId);

  return {
    id: stillImageModelId(categoryId),
    name: metadata.name,
    category: metadata.category,
    workflowPath: stillImageWorkflowPath(categoryId),
    description: "Still Images preset.",
    requiredInputs: ["single_image"],
    // requiresPrompt stays false even for the presets that accept one: whether a
    // prompt is required, optional or forbidden depends on the preset's current
    // mode, and assertStillImageInputs already owns that rule.
    requiresPrompt: false,
    requiresImage: true,
    requiresStartEndFrames: false,
    // The ceiling. The exact count for a given request comes from
    // stillImageSlotCount, which the submission route enforces first.
    imageSlotCount: preset.inputBindings.length,
    outputType: "image",
    estimatedCredits: metadata.estimatedCredits,
    estimatedTime: metadata.estimatedTime,
    // Deliberately no supportedResolutions or supportedDurations: these presets
    // take their size from the input image, and a resolution on the request would
    // be silently ignored.
  };
}
