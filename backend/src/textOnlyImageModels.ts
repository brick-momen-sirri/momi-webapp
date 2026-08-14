// Which image models can run from a prompt alone.
//
// Nano Banana and GPT Image ship as edit graphs -- a LoadImage feeding the
// generation node -- so inferRequiredInputs marks them "single_image" and their
// category is image_editing. Both providers generate from a prompt with no image
// at all, and applyTextOnlyImageWorkflowMode rewrites the graph for that case by
// dropping the image inputs and the now-orphaned LoadImage/Batch nodes.
//
// The submission route needs the same answer, to let an image-less request
// through. Shared rather than duplicated: if the route accepted a request the
// graph rewrite did not recognise, the job would reach ComfyUI still wired to a
// LoadImage pointing at a placeholder filename, and fail there instead.

import type { WorkflowModel } from "./types.js";

export function supportsTextOnlyImageWorkflow(model: WorkflowModel) {
  return isNanoBananaModel(model) || isGptImageModel(model);
}

export function isNanoBananaModel(model: WorkflowModel) {
  const key = modelKey(model);
  return key.includes("nano") && key.includes("banana");
}

export function isGptImageModel(model: WorkflowModel) {
  return isGptImageKey(modelKey(model));
}

export function isGptImageKey(key: string) {
  return (key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid");
}

function modelKey(model: WorkflowModel) {
  return `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
}
