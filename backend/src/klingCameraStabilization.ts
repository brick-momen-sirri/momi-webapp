import type { ComfyNode } from "./comfyGraph.js";
import type { WorkflowModel, WorkflowOptions } from "./types.js";

/**
 * Kling 3.0's "Stabilize camera" switch: anti-shake terms appended to the negative
 * prompt, never written over it.
 *
 * Only KlingVideoNode has a negative prompt, and only under `multi_shot:
 * "disabled"` -- the storyboard options carry per-shot prompts and no negative one,
 * and the node sends none when storyboards are on. KlingFirstLastFrameNode has no
 * negative prompt at all, and the kling-3.0-turbo model drops it on the floor. In
 * this app that leaves exactly one workflow the switch can affect: the Kling 3.0
 * image-to-video graph, which ships with multi_shot disabled on kling-v3.
 */
export const KLING_CAMERA_STABILITY_NEGATIVE_PROMPT =
  "camera shake, handheld camera, micro jitter, camera vibration, unstable framing, drifting camera, sudden camera movement, unwanted camera motion";

const NEGATIVE_PROMPT_KEY = "multi_shot.negative_prompt";

export function supportsKlingCameraStabilization(model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath">) {
  return `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase().includes("kling_v3_video");
}

export function isKlingVideoClassType(classType: string) {
  return classType.toLowerCase() === "klingvideonode";
}

/**
 * Append the terms to whatever negative prompt the graph was saved with.
 *
 * Absent or false leaves the node untouched: jobs from before the switch existed,
 * and artists who want handheld motion, both run on exactly what the graph says.
 */
export function applyKlingCameraStabilization(inputs: ComfyNode, workflowOptions: WorkflowOptions | undefined) {
  if (workflowOptions?.kling?.cameraStabilization !== true) return;
  if (inputs.multi_shot !== "disabled") return;
  if (String(inputs.model ?? "").toLowerCase() === "kling-3.0-turbo") return;
  const existing = inputs[NEGATIVE_PROMPT_KEY];
  if (typeof existing !== "string") return;
  inputs[NEGATIVE_PROMPT_KEY] = appendNegativePrompt(existing, KLING_CAMERA_STABILITY_NEGATIVE_PROMPT);
}

function appendNegativePrompt(existing: string, terms: string) {
  const base = existing.trim().replace(/[,\s]+$/, "");
  if (!base) return terms;
  // A retried job's graph is rebuilt from the workflow file, so this is not what
  // stops a double append; it keeps a graph authored with the terms already in it
  // from sending them twice.
  if (base.toLowerCase().includes(terms.toLowerCase())) return base;
  return `${base}, ${terms}`;
}
