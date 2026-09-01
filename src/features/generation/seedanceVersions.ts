// Which Seedance model the Animation picker offers, and what each one supports.
//
// The table is backend/src/data/seedanceVersions.json, read here the same way the
// Still Images panel reads stillImagePresets.json: one copy of the truth, so the
// picker cannot offer a duration or resolution the server will refuse. This file
// adds only what the server has no use for -- the button labels and hints -- plus
// the ModelType-shaped view the existing controls already know how to read.
//
// Data only. The two sides still cannot import each other's code, so the rules
// below are mirrored from backend/src/seedanceVersions.ts and asserted against it
// in seedanceVersions.test.ts.

import table from "../../../backend/src/data/seedanceVersions.json";
import { isSeedanceWorkflowModel } from "../../services/promptRules";
import type { ModelType } from "../../types";

export type SeedanceVersionId = "2.0" | "2.5";

export type SeedanceVersion = {
  id: SeedanceVersionId;
  label: string;
  hint: string;
  comfyModelValue: string;
  resolutions: string[];
  defaultResolution: string;
  ratios: string[];
  defaultRatio: string;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  defaultDurationSeconds: number;
  supportsRatioOnFirstLastFrame: boolean;
  outputFormat: string | null;
  supportsVideoEditing: boolean;
};

export const SEEDANCE_VERSIONS = table.versions as unknown as readonly SeedanceVersion[];
export const DEFAULT_SEEDANCE_VERSION = table.defaultVersion as SeedanceVersionId;

export function normalizeSeedanceVersion(value: unknown): SeedanceVersionId {
  return SEEDANCE_VERSIONS.some((version) => version.id === value) ? (value as SeedanceVersionId) : DEFAULT_SEEDANCE_VERSION;
}

export function seedanceVersion(id: unknown): SeedanceVersion {
  const normalized = normalizeSeedanceVersion(id);
  const found = SEEDANCE_VERSIONS.find((version) => version.id === normalized);
  if (!found) throw new Error(`seedanceVersions.json has no version ${normalized}.`);
  return found;
}

export function seedanceDurations(version: SeedanceVersion) {
  const { minDurationSeconds: from, maxDurationSeconds: to } = version;
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

export type SeedanceTaskFields = Pick<ModelType, "id" | "backendCategory" | "workflowPath">;

/**
 * Whether this task runs on ByteDance2FirstLastFrameNode rather than the reference
 * node, which is the difference that decides whether a ratio input exists at all.
 *
 * backendCategory first because that is the backend's own `model.category`, the field
 * the server makes the same decision from, and it is set on every model the catalogue
 * returns. The path is the fallback for a model that arrives without one.
 */
function usesFirstLastFrameNode(model: SeedanceTaskFields) {
  if (model.backendCategory) return model.backendCategory === "first_last_frame_to_video";
  return `${model.id} ${model.workflowPath ?? ""}`.toLowerCase().replaceAll("\\", "/").includes("flf2v");
}

export function seedanceSupportsRatio(model: SeedanceTaskFields, version: SeedanceVersion) {
  return !usesFirstLastFrameNode(model) || version.supportsRatioOnFirstLastFrame;
}

/**
 * Whether to offer the "edit the source video" switch.
 *
 * 2.5 only, and only where a video is actually an input: the first-last-frame node
 * has no such widget, and on image-to-video there would be no clip to edit.
 */
export function seedanceSupportsVideoEditing(
  model: SeedanceTaskFields & Pick<ModelType, "requiresVideo">,
  version: SeedanceVersion,
) {
  return version.supportsVideoEditing && Boolean(model.requiresVideo) && !usesFirstLastFrameNode(model);
}

/**
 * The model as the picked version constrains it.
 *
 * Returned in ModelType shape on purpose. A Seedance model's resolutions and
 * durations are not a property of its workflow file -- the ByteDance2 nodes take
 * one model per task and switch their own inputs on the version -- so rather than
 * teach every control about versions, the version is folded into the model the
 * controls already read. ResolutionSelector, DurationSelector, the credit estimate
 * and the reuse normalisers then need no Seedance branch at all.
 *
 * A non-Seedance model is returned untouched.
 */
export function seedanceEffectiveModel(model: ModelType, versionId: unknown): ModelType {
  if (!isSeedanceWorkflowModel(model)) return model;
  const version = seedanceVersion(versionId);
  const durations = seedanceDurations(version);
  return {
    ...model,
    supportedResolutions: version.resolutions,
    supportedDurations: durations,
    defaultDurationSeconds: durations.includes(model.defaultDurationSeconds ?? 0)
      ? model.defaultDurationSeconds
      : version.defaultDurationSeconds,
  };
}
