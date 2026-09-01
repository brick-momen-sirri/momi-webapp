import table from "./data/seedanceVersions.json" with { type: "json" };
import type { ComfyNode } from "./comfyGraph.js";
import type { WorkflowModel, WorkflowOptions } from "./types.js";

/**
 * Which Seedance model a job runs on, and what that model accepts.
 *
 * The ByteDance2 nodes are one node per task with a dynamic `model` combo, and the
 * chosen option decides which nested inputs exist -- 2.5 drops 4K and gains
 * `output_format`, the first-last-frame node loses `ratio` entirely, and the
 * duration ceiling doubles. So a Seedance model's capabilities are not a property
 * of the workflow file, and cannot be inferred from it at boot the way every other
 * model's are: they depend on the version the artist picked.
 *
 * Hence seedanceEffectiveModel(), which folds the version into the WorkflowModel
 * the rest of the pipeline already reads. Submission validation, duration
 * clamping and credit estimation then need no Seedance-specific branches, and the
 * UI does the mirror-image thing with the same table.
 */

export type SeedanceVersionId = "2.0" | "2.5";

export type SeedanceVersion = {
  id: SeedanceVersionId;
  label: string;
  hint: string;
  /** The value the node's `model` combo takes. Not the id: the combo spells it out. */
  comfyModelValue: string;
  resolutions: string[];
  defaultResolution: string;
  ratios: string[];
  defaultRatio: string;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  defaultDurationSeconds: number;
  /** 2.5's first-last-frame option has no `ratio` input at all; 2.0's does. */
  supportsRatioOnFirstLastFrame: boolean;
  /** `model.output_format`, which exists only from 2.5. Null means the input is absent. */
  outputFormat: string | null;
  supportsVideoEditing: boolean;
};

export const SEEDANCE_VERSION_IDS: readonly SeedanceVersionId[] = ["2.0", "2.5"];

/**
 * Validated at load, like the still image preset table: this drives both what the
 * server accepts and what goes into the graph, so a malformed row would otherwise
 * surface as a rejected submission or a job that fails inside ComfyUI.
 */
export const seedanceVersions: readonly SeedanceVersion[] = assertVersionTableShape(
  table.versions as unknown as SeedanceVersion[],
);

export const DEFAULT_SEEDANCE_VERSION = assertDefaultVersion(table.defaultVersion);

function assertVersionTableShape(versions: SeedanceVersion[]) {
  const seen = new Set<string>();
  for (const version of versions) {
    if (!SEEDANCE_VERSION_IDS.includes(version.id)) {
      throw new Error(`seedanceVersions.json names an unknown version: ${String(version.id)}`);
    }
    if (seen.has(version.id)) throw new Error(`seedanceVersions.json lists ${version.id} twice.`);
    seen.add(version.id);
    if (!version.comfyModelValue) throw new Error(`seedanceVersions.json gives ${version.id} no comfyModelValue.`);
    if (!version.resolutions.includes(version.defaultResolution)) {
      throw new Error(`seedanceVersions.json gives ${version.id} a defaultResolution it does not list.`);
    }
    if (!version.ratios.includes(version.defaultRatio)) {
      throw new Error(`seedanceVersions.json gives ${version.id} a defaultRatio it does not list.`);
    }
    if (!Number.isInteger(version.minDurationSeconds) || version.minDurationSeconds < 1) {
      throw new Error(`seedanceVersions.json gives ${version.id} an impossible minDurationSeconds.`);
    }
    if (version.maxDurationSeconds < version.minDurationSeconds) {
      throw new Error(`seedanceVersions.json gives ${version.id} a maxDurationSeconds below its minimum.`);
    }
    const { minDurationSeconds: from, maxDurationSeconds: to, defaultDurationSeconds } = version;
    if (defaultDurationSeconds < from || defaultDurationSeconds > to) {
      throw new Error(`seedanceVersions.json gives ${version.id} a defaultDurationSeconds outside its range.`);
    }
  }
  const missing = SEEDANCE_VERSION_IDS.filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`seedanceVersions.json is missing versions: ${missing.join(", ")}`);
  return versions;
}

function assertDefaultVersion(value: unknown): SeedanceVersionId {
  if (!isSeedanceVersionId(value)) throw new Error(`seedanceVersions.json has no version ${String(value)} to default to.`);
  return value;
}

export function seedanceVersion(id: unknown): SeedanceVersion {
  const found = seedanceVersions.find((version) => version.id === id);
  if (found) return found;
  const fallback = seedanceVersions.find((version) => version.id === DEFAULT_SEEDANCE_VERSION);
  if (!fallback) throw new Error(`seedanceVersions.json has no version ${DEFAULT_SEEDANCE_VERSION}.`);
  return fallback;
}

export function isSeedanceVersionId(value: unknown): value is SeedanceVersionId {
  return seedanceVersions.some((version) => version.id === value);
}

export function seedanceVersionIdFromOptions(workflowOptions: WorkflowOptions | undefined): SeedanceVersionId {
  const requested = workflowOptions?.seedance?.version;
  return isSeedanceVersionId(requested) ? requested : DEFAULT_SEEDANCE_VERSION;
}

export function isSeedanceWorkflowModel(model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath">) {
  if (!model.category.includes("video")) return false;
  return `${model.id} ${model.name} ${model.workflowPath}`.toLowerCase().includes("seedance");
}

function isFirstLastFrameModel(model: Pick<WorkflowModel, "category">) {
  return model.category === "first_last_frame_to_video";
}

/** Whether this (version, task) pair has a `ratio` input to send at all. */
export function seedanceSupportsRatio(
  model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath">,
  version: SeedanceVersion,
) {
  if (!isSeedanceWorkflowModel(model)) return false;
  return !isFirstLastFrameModel(model) || version.supportsRatioOnFirstLastFrame;
}

/**
 * Whether the node has a `video_editing` input, which is not the same question as
 * whether offering it would make sense.
 *
 * 2.5's reference node declares it required whether or not a video is connected, so
 * every 2.5 reference job has to send it -- false when nobody asked. The picker is
 * stricter and only shows the switch where a clip is actually an input.
 */
function hasVideoEditingInput(model: Pick<WorkflowModel, "category">, version: SeedanceVersion) {
  return version.supportsVideoEditing && !isFirstLastFrameModel(model);
}

export function seedanceDurations(version: SeedanceVersion) {
  const { minDurationSeconds: from, maxDurationSeconds: to } = version;
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

/**
 * The model as the picked version constrains it.
 *
 * A non-Seedance model, or a Seedance one with no version on the request, is
 * returned untouched -- absent options mean a job submitted before the picker
 * existed, and those ran on 2.0.
 */
export function seedanceEffectiveModel<T extends WorkflowModel>(model: T, workflowOptions: WorkflowOptions | undefined): T {
  if (!isSeedanceWorkflowModel(model)) return model;
  const version = seedanceVersion(seedanceVersionIdFromOptions(workflowOptions));
  const durations = seedanceDurations(version);
  return {
    ...model,
    supportedResolutions: version.resolutions,
    defaultResolution: version.resolutions.includes(model.defaultResolution ?? "")
      ? model.defaultResolution
      : version.defaultResolution,
    supportedDurations: durations,
    defaultDurationSeconds: durations.includes(model.defaultDurationSeconds ?? 0)
      ? model.defaultDurationSeconds
      : version.defaultDurationSeconds,
  };
}

/**
 * Point a ByteDance2 node's inputs at the picked version.
 *
 * The nested inputs are flat `model.<name>` keys in the API prompt, and ComfyUI
 * builds the node's arguments from the *selected* option's schema: a key the
 * option does not declare is dropped without complaint, while one it declares as
 * required and cannot find fails validation before the job runs. So this writes
 * every key the version needs and removes the ones it does not have, rather than
 * trusting the graph's saved 2.0 shape to be close enough.
 */
export function applySeedanceModelInputs(
  inputs: ComfyNode,
  model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath">,
  workflowOptions: WorkflowOptions | undefined,
) {
  const requested = workflowOptions?.seedance;
  // No Seedance block at all is a submission from before the picker existed, or one
  // from a client that does not send options. Those ran on whatever the graph was
  // saved with, so leave the node exactly as it is rather than imposing a default.
  if (!requested) return;

  const version = seedanceVersion(seedanceVersionIdFromOptions(workflowOptions));
  setSeedanceInput(inputs, "model", version.comfyModelValue, ["model"]);

  if (!seedanceSupportsRatio(model, version)) {
    deleteSeedanceInput(inputs, ["model.ratio", "ratio"]);
  } else if (version.ratios.includes(requested.ratio ?? "")) {
    setSeedanceInput(inputs, "model.ratio", requested.ratio, ["model.ratio", "ratio"]);
  }
  // An unrecognised or absent ratio keeps the graph's saved value, which is the
  // aspect the workflow was authored to produce.

  // output_format and video_editing are required inputs of 2.5's options, so they are
  // written unconditionally: ComfyUI fails a prompt that is missing one before the
  // job runs. 2.0 has neither, and a leftover key would be dropped in silence.
  if (version.outputFormat) {
    setSeedanceInput(inputs, "model.output_format", version.outputFormat, ["model.output_format", "output_format"]);
  } else {
    deleteSeedanceInput(inputs, ["model.output_format", "output_format"]);
  }

  if (hasVideoEditingInput(model, version)) {
    setSeedanceInput(inputs, "model.video_editing", requested.videoEditing === true, ["model.video_editing", "video_editing"]);
  } else {
    deleteSeedanceInput(inputs, ["model.video_editing", "video_editing"]);
  }
}

/**
 * Write `value` to whichever of `aliases` the graph already spells, else to `key`.
 *
 * Graphs saved from the node use "model.ratio"; a hand-built one may use plain
 * "ratio". Honouring what is there avoids leaving a second, ignored key behind.
 */
function setSeedanceInput(inputs: ComfyNode, key: string, value: unknown, aliases: string[]) {
  const existing = Object.keys(inputs).find((name) => aliases.includes(name.toLowerCase()));
  inputs[existing ?? key] = value;
}

function deleteSeedanceInput(inputs: ComfyNode, aliases: string[]) {
  for (const name of Object.keys(inputs)) {
    if (aliases.includes(name.toLowerCase())) delete inputs[name];
  }
}
