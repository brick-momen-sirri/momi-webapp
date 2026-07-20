import type { ModelType } from "../types";

export const KLING_PROMPT_CHARACTER_LIMIT = 2500;

export function isKlingWorkflowModel(model: ModelType) {
  if (model.category !== "video") return false;
  const text = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return text.includes("kling");
}

export function klingPromptOverflowCharacters(model: ModelType, prompt: string) {
  if (!isKlingWorkflowModel(model)) return 0;
  return Math.max(0, prompt.length - KLING_PROMPT_CHARACTER_LIMIT);
}

export function isSeedanceWorkflowModel(model: ModelType) {
  if (model.category !== "video") return false;
  const text = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return text.includes("seedance");
}
