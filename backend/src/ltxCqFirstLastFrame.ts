// First & Last Frame on the LTX 2.5 CQ pod: a starting image, an ending image and
// a prompt for the movement between them, generated with the same stack as LTX 2.5
// CQ Image to Video -- dev INT8 -> distilled LoRA 450 at 1.0 -> CQ Enhancer V2 LoRA
// at 1.0, convolution VAE -- on the same endpoint and Docker image.
//
// Source: brick-momen-sirri/worker-comfyui-LTX-2.5 @ 1bdcbcf (main, 2026-10-01),
// workflows/experimental/first-last-cq.md. Its first_last_frame_cq.json is copied
// verbatim into backend/workflow-ltx-cq-i2v/ltx25-cq-flf.json (sha256 d517af3e...)
// and manifest.first-last-cq.json into ltx25-cq-flf.manifest.json (sha256
// 493afcba...), the worker repo's manifest format; every binding comes from the
// latter. That is the tested CQ graph -- not the standard first_last_frame.json,
// which selects a distilled transformer and the standard VAE: here it is the dev
// transformer, both LoRAs, the convolution VAE, SamplerEulerAncestral (eta 0,
// s_noise 1), LTXVDualCFGGuider (video/audio CFG 1) and untiled VAEDecode.
// The manifest's mode name, first_last_frame_cq_experimental, is this app's name
// for it only: the deployed worker's named-mode catalog does not contain it, so
// the graph is compiled here and sent through the legacy input.workflow +
// input.images contract, exactly like the image-to-video graph.
//
// Guidance: the first image is an LTXVAddGuide at frame 0, the last an
// LTXVAddGuide at frame -1, chained, and both feed the sampler; LTXVCropGuides
// removes the two appended guide latents before decoding. Nothing pastes the
// source images onto the result. The compiler checks that wiring on every build,
// so a replaced graph that drops a guide fails before anything is sent.
//
// Experimental: one job per preset completed on the pod on 2026-10-01 (121 frames,
// 24 fps, one architectural image pair) and the endpoints followed their
// references closely, but sampled middle frames showed window-grid, facade and
// plaza geometry morphing at every resolution, and 1440p added a background
// building. The recipe is therefore pinned as tested and only size, length,
// prompt and the two images vary.

import fs from "node:fs/promises";
import path from "node:path";

import { ltxCqI2vWorkflowRoot } from "./config.js";
import { isLtxCqI2vModelId } from "./ltxCqImageToVideo.js";
import type { Resolution, WorkflowModel } from "./types.js";

export const LTX_CQ_FLF_MODEL_ID = "ltx25_cq_flf2v";
/** The manifest's mode. Never sent to RunPod. */
export const LTX_CQ_FLF_MODE = "first_last_frame_cq_experimental";

export const LTX_CQ_FLF_FPS = 24;
export const LTX_CQ_FLF_PROMPT_MAX_LENGTH = 12_000;

/** The worker's hard limits for this mode, enforced again on top of the manifest's. */
export const LTX_CQ_FLF_MAX_WIDTH = 2560;
export const LTX_CQ_FLF_MAX_HEIGHT = 1440;
export const LTX_CQ_FLF_MIN_FRAMES = 9;
export const LTX_CQ_FLF_MAX_FRAMES = 121;

/**
 * The tested settings, by manifest parameter name. Fixed for the initial
 * integration, like the image-to-video recipe.
 */
export const LTX_CQ_FLF_RECIPE = {
  fps: LTX_CQ_FLF_FPS,
  image_compression: 18,
  first_frame_strength: 0.7,
  last_frame_strength: 0.7,
  seed: 42,
  cfg: 1,
  distilled_lora_strength: 1,
  cq_lora_strength: 1,
} as const;

type Preset = {
  /** Size of the delivered file. */
  width: number;
  height: number;
  /** Size the model generates at, on its 32 px grid. */
  generationWidth: number;
  generationHeight: number;
};

/**
 * The three tested presets. 720p and 1080p are generated a few rows taller to sit
 * on the 32 px grid and cropped evenly top and bottom afterwards; 1440p is
 * already on it and is delivered as generated.
 */
const PRESETS: Readonly<Record<string, Preset>> = {
  "720p": { width: 1280, height: 720, generationWidth: 1280, generationHeight: 736 },
  "1080p": { width: 1920, height: 1080, generationWidth: 1920, generationHeight: 1088 },
  "1440p": { width: 2560, height: 1440, generationWidth: 2560, generationHeight: 1440 },
};

export const LTX_CQ_FLF_RESOLUTIONS = Object.keys(PRESETS);
/** Whole seconds, each 24n+1 frames and so 8n+1 too. 5 s is the tested 121. */
export const LTX_CQ_FLF_DURATIONS = [2, 3, 4, 5];
export const LTX_CQ_FLF_DEFAULT_DURATION_SECONDS = 5;

export type LtxCqFlfPlan = Preset & { frames: number; durationSeconds: number };

export function isLtxCqFlfModelId(modelId: string | undefined) {
  return modelId === LTX_CQ_FLF_MODEL_ID;
}

/** Either graph that runs on the LTX 2.5 CQ pod (the enhancer is keyed on its options). */
export function isLtxCqPodModelId(modelId: string | undefined) {
  return isLtxCqI2vModelId(modelId) || isLtxCqFlfModelId(modelId);
}

export function ltxCqFlfWorkflowPath() {
  return path.join(ltxCqI2vWorkflowRoot, "ltx25-cq-flf.json");
}

export function ltxCqFlfManifestPath() {
  return path.join(ltxCqI2vWorkflowRoot, "ltx25-cq-flf.manifest.json");
}

let cachedModel: WorkflowModel | undefined;

/** Registered rather than scanned, like the image-to-video graph. One instance. */
export function ltxCqFlfWorkflowModel(): WorkflowModel {
  cachedModel ??= {
    id: LTX_CQ_FLF_MODEL_ID,
    name: "LTX 2.5 CQ First & Last Frame (Experimental)",
    category: "first_last_frame_to_video",
    workflowPath: ltxCqFlfWorkflowPath(),
    description:
      "Experimental. LTX 2.5 with the CQ Enhancer V2 LoRA on the studio's own GPU pod: animates from a starting image " +
      "to an ending image, with its own ambient audio. The first and last frames follow your images closely but are " +
      "not exact copies, and the frames in between can bend or distort architecture -- exact geometry is not preserved.",
    requiredInputs: ["prompt", "start_frame", "end_frame", "resolution"],
    supportedResolutions: LTX_CQ_FLF_RESOLUTIONS,
    defaultResolution: "1080p",
    supportedDurations: LTX_CQ_FLF_DURATIONS,
    defaultDurationSeconds: LTX_CQ_FLF_DEFAULT_DURATION_SECONDS,
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: true,
    imageSlotCount: 2,
    outputType: "video",
    estimatedCredits: ltxCqFlfCredits("1080p", LTX_CQ_FLF_DEFAULT_DURATION_SECONDS),
    estimatedTime: "2-5 min",
  };
  return cachedModel;
}

/** "1080p", "1920x1080" or a resolution object, to the preset it names. */
export function ltxCqFlfPreset(resolution: Pick<Resolution, "width" | "height" | "label"> | string | undefined) {
  if (!resolution) return undefined;
  const key = typeof resolution === "string" ? resolution : (resolution.label ?? `${resolution.width}x${resolution.height}`);
  const normalized = key.toLowerCase().replace(/\s+/g, "");
  const byLabel = PRESETS[normalized];
  if (byLabel) return byLabel;
  return Object.values(PRESETS).find((preset) => `${preset.width}x${preset.height}` === normalized);
}

/**
 * The worker's canvas and length rules: both sides on the 32 px grid, at most
 * 2560x1440, and 9-121 frames of the form 8n+1. Every preset satisfies them; this
 * is the guard against a preset or graph edit that would not.
 */
export function assertLtxCqFlfCanvas(width: number, height: number, frames: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 32 !== 0 || height % 32 !== 0) {
    throw new Error(`LTX 2.5 CQ generates on a 32 px grid; ${width}x${height} is not on it.`);
  }
  if (width > LTX_CQ_FLF_MAX_WIDTH || height > LTX_CQ_FLF_MAX_HEIGHT) {
    throw new Error(`LTX 2.5 CQ generates at most ${LTX_CQ_FLF_MAX_WIDTH}x${LTX_CQ_FLF_MAX_HEIGHT}; ${width}x${height} is larger.`);
  }
  if (
    !Number.isInteger(frames) ||
    frames < LTX_CQ_FLF_MIN_FRAMES ||
    frames > LTX_CQ_FLF_MAX_FRAMES ||
    (frames - 1) % 8 !== 0
  ) {
    throw new Error(
      `LTX 2.5 CQ renders ${LTX_CQ_FLF_MIN_FRAMES}-${LTX_CQ_FLF_MAX_FRAMES} frames of the form 8n+1; ${frames} is not.`,
    );
  }
}

/** Throws with an artist-facing message on anything the tested contract does not cover. */
export function planLtxCqFlf(resolution: Resolution | undefined, durationSeconds: number | undefined): LtxCqFlfPlan {
  const preset = ltxCqFlfPreset(resolution);
  if (!preset) throw new Error(`LTX 2.5 CQ First & Last Frame supports ${LTX_CQ_FLF_RESOLUTIONS.join(", ")} only.`);
  const seconds = durationSeconds ?? LTX_CQ_FLF_DEFAULT_DURATION_SECONDS;
  if (!LTX_CQ_FLF_DURATIONS.includes(seconds)) {
    throw new Error(`LTX 2.5 CQ First & Last Frame supports ${LTX_CQ_FLF_DURATIONS.join(", ")} second clips.`);
  }
  const frames = seconds * LTX_CQ_FLF_FPS + 1;
  assertLtxCqFlfCanvas(preset.generationWidth, preset.generationHeight, frames);
  return { ...preset, frames, durationSeconds: seconds };
}

type ApiGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
type Binding = { node_id: string; input: string };
type Constraint = {
  type?: "string" | "integer" | "number";
  minimum?: number;
  maximum?: number;
  multiple_of?: number;
  offset?: number;
  enum?: unknown[];
  max_length?: number;
};

export type LtxCqFlfManifestMode = {
  file: string;
  constraints: Record<string, Constraint>;
  bindings: Record<string, Binding[]>;
  media: Record<string, { kind: string; node_id: string; input: string; required?: boolean }>;
  output_prefix: Binding[];
};

/** The mode out of a parsed manifest file, with the parts the compiler relies on present. */
export function ltxCqFlfManifestMode(manifest: unknown): LtxCqFlfManifestMode {
  const modes = (manifest as { modes?: Record<string, unknown> } | undefined)?.modes;
  const mode = modes?.[LTX_CQ_FLF_MODE] as Partial<LtxCqFlfManifestMode> | undefined;
  if (!mode?.bindings || !mode.media || !mode.output_prefix || !mode.constraints) {
    throw new Error(`The LTX 2.5 CQ manifest has no complete ${LTX_CQ_FLF_MODE} mode.`);
  }
  for (const role of ["first_frame", "last_frame"]) {
    if (mode.media[role]?.kind !== "image") throw new Error(`The LTX 2.5 CQ manifest has no ${role} image input.`);
  }
  return mode as LtxCqFlfManifestMode;
}

export async function loadLtxCqFlfTemplate() {
  const [graph, manifest] = await Promise.all([
    fs.readFile(ltxCqFlfWorkflowPath(), "utf8").then((text) => JSON.parse(text) as unknown),
    fs.readFile(ltxCqFlfManifestPath(), "utf8").then((text) => JSON.parse(text) as unknown),
  ]);
  return { graph, mode: ltxCqFlfManifestMode(manifest) };
}

/**
 * One job's values into a fresh copy of the graph, every one of them through the
 * manifest: its constraints are checked and its bindings written, so a size
 * reaches the latent and both resizes, and a length both latents, or the build
 * fails. A binding that names a missing node or input fails too, rather than
 * quietly leaving a default in place. The negative prompt is the one manifest
 * parameter left as the graph has it.
 */
export function compileLtxCqFlfWorkflow(
  template: unknown,
  mode: LtxCqFlfManifestMode,
  input: { plan: LtxCqFlfPlan; prompt: string; firstImageName: string; lastImageName: string; outputPrefix: string },
) {
  if (input.firstImageName === input.lastImageName) {
    throw new Error("The first and last frames need distinct filenames.");
  }
  assertLtxCqFlfCanvas(input.plan.generationWidth, input.plan.generationHeight, input.plan.frames);

  const graph = structuredClone(template) as ApiGraph;
  const write = (binding: Binding, value: unknown, what: string) => {
    const node = graph[binding.node_id];
    if (!node?.inputs || !(binding.input in node.inputs)) {
      throw new Error(`The LTX 2.5 CQ manifest binds ${what} to ${binding.node_id}.${binding.input}, which the graph lacks.`);
    }
    node.inputs[binding.input] = value;
  };

  const values: Record<string, unknown> = {
    ...LTX_CQ_FLF_RECIPE,
    prompt: input.prompt,
    width: input.plan.generationWidth,
    height: input.plan.generationHeight,
    num_frames: input.plan.frames,
  };
  for (const [parameter, value] of Object.entries(values)) {
    assertWithinConstraint(parameter, value, mode.constraints[parameter]);
    const bindings = mode.bindings[parameter];
    if (!bindings?.length) throw new Error(`The LTX 2.5 CQ manifest has no binding for ${parameter}.`);
    for (const binding of bindings) write(binding, value, parameter);
  }

  write(mode.media.first_frame, input.firstImageName, "first_frame");
  write(mode.media.last_frame, input.lastImageName, "last_frame");
  if (!mode.output_prefix.length) throw new Error("The LTX 2.5 CQ manifest has no output prefix binding.");
  for (const binding of mode.output_prefix) write(binding, input.outputPrefix, "the output prefix");

  assertLtxCqFlfGuideChain(graph, mode);
  return graph;
}

function assertWithinConstraint(parameter: string, value: unknown, constraint: Constraint | undefined) {
  if (!constraint) throw new Error(`The LTX 2.5 CQ manifest has no constraint for ${parameter}.`);
  const fail = (why: string) => {
    throw new Error(`LTX 2.5 CQ ${parameter}${typeof value === "number" ? ` ${value}` : ""} ${why}.`);
  };
  if (constraint.type === "string") {
    if (typeof value !== "string") fail("is not text");
    if (constraint.max_length !== undefined && (value as string).length > constraint.max_length) {
      fail(`is over ${constraint.max_length} characters`);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return fail("is not a number");
  if (constraint.type === "integer" && !Number.isInteger(value)) fail("is not a whole number");
  if (constraint.enum && !constraint.enum.includes(value)) fail(`is not one of ${constraint.enum.join(", ")}`);
  if (constraint.minimum !== undefined && value < constraint.minimum) fail(`is below ${constraint.minimum}`);
  if (constraint.maximum !== undefined && value > constraint.maximum) fail(`is above ${constraint.maximum}`);
  if (constraint.multiple_of && (value - (constraint.offset ?? 0)) % constraint.multiple_of !== 0) {
    fail(`is not ${constraint.offset ? `${constraint.offset} more than ` : ""}a multiple of ${constraint.multiple_of}`);
  }
}

type Ref = [string, number];

function isRef(value: unknown): value is Ref {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

/**
 * The guidance chain the tested graph depends on, checked on the compiled graph:
 *
 *   empty latent -> guide(first image, frame 0) -> guide(last image, frame -1)
 *     -> sampler (latent and both conditionings) -> split -> LTXVCropGuides -> decode -> video
 *
 * Each guide's image is traced back through its preprocess and resize to the
 * LoadImage the manifest names for that role, so swapped images fail too. The
 * video is built from the decoded latent directly: nothing composites the source
 * images onto it.
 */
export function assertLtxCqFlfGuideChain(graph: unknown, mode: LtxCqFlfManifestMode) {
  const nodes = graph as ApiGraph;
  const fail = (why: string): never => {
    throw new Error(`The LTX 2.5 CQ first/last-frame graph is miswired: ${why}.`);
  };
  const node = (id: string) => nodes[id] ?? fail(`node ${id} is missing`);
  const ref = (id: string, key: string): Ref => {
    const value = node(id).inputs?.[key];
    return isRef(value) ? value : fail(`${id}.${key} is not connected`);
  };
  const same = (value: Ref, id: string, slot: number) => value[0] === id && value[1] === slot;
  /** Follows single-image passthroughs back to the LoadImage. */
  const loadImageBehind = (start: Ref) => {
    let current = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const upstream = node(current[0]);
      if (upstream.class_type === "LoadImage") return current[0];
      current = ref(current[0], "image");
    }
    return fail(`${start[0]} does not lead back to a LoadImage`);
  };

  const guides = Object.entries(nodes).filter(([, value]) => value?.class_type === "LTXVAddGuide");
  if (guides.length !== 2) fail(`expected two LTXVAddGuide nodes, found ${guides.length}`);
  const guideFor = (role: "first_frame" | "last_frame") => {
    const loader = mode.media[role].node_id;
    const match = guides.filter(([id]) => loadImageBehind(ref(id, "image")) === loader);
    if (match.length !== 1) fail(`the ${role} image does not feed exactly one guide`);
    return match[0][0];
  };
  const first = guideFor("first_frame");
  const last = guideFor("last_frame");

  if (node(first).inputs?.frame_idx !== 0) fail(`the first-frame guide is at frame ${String(node(first).inputs?.frame_idx)}, not 0`);
  if (node(last).inputs?.frame_idx !== -1) fail(`the last-frame guide is at frame ${String(node(last).inputs?.frame_idx)}, not -1`);
  if (node(ref(first, "latent")[0]).class_type !== "EmptyLTXVLatentVideo") fail("the first guide does not start from the empty latent");
  for (const [key, slot] of [["positive", 0], ["negative", 1], ["latent", 2]] as const) {
    if (!same(ref(last, key), first, slot)) fail(`the last guide's ${key} does not come from the first guide`);
  }

  const samplers = Object.entries(nodes).filter(([, value]) => value?.class_type === "SamplerCustomAdvanced");
  if (samplers.length !== 1) fail(`expected one sampler, found ${samplers.length}`);
  const sampler = samplers[0][0];
  const av = ref(sampler, "latent_image")[0];
  if (node(av).class_type !== "LTXVConcatAVLatent" || !same(ref(av, "video_latent"), last, 2)) {
    fail("the sampler's video latent does not come from the last guide");
  }
  const guider = ref(sampler, "guider")[0];
  if (!same(ref(guider, "positive"), last, 0) || !same(ref(guider, "negative"), last, 1)) {
    fail("the guider's conditioning does not come from the last guide");
  }

  const crops = Object.entries(nodes).filter(([, value]) => value?.class_type === "LTXVCropGuides");
  if (crops.length !== 1) fail(`expected one LTXVCropGuides, found ${crops.length}`);
  const crop = crops[0][0];
  if (!same(ref(crop, "positive"), last, 0) || !same(ref(crop, "negative"), last, 1)) {
    fail("LTXVCropGuides does not take the guided conditioning");
  }
  const split = ref(crop, "latent");
  if (split[1] !== 0 || node(split[0]).class_type !== "LTXVSeparateAVLatent" || ref(split[0], "av_latent")[0] !== sampler) {
    fail("LTXVCropGuides does not take the sampled video latent");
  }

  const videos = Object.entries(nodes).filter(([, value]) => value?.class_type === "CreateVideo");
  if (videos.length !== 1) fail(`expected one CreateVideo, found ${videos.length}`);
  const decoder = ref(videos[0][0], "images")[0];
  if (!["VAEDecode", "VAEDecodeTiled"].includes(node(decoder).class_type ?? "") || !same(ref(decoder, "samples"), crop, 2)) {
    fail("the video is not decoded straight from the cropped latent");
  }
}

/**
 * The dispatcher's completion gate for this model: the selected result must be a
 * video that was stored in the project, which for this model also means it was
 * cropped and its size, frame count and frame rate checked (finishLtxCqResult
 * throws otherwise, and the artifact keeps that error). Anything less fails the
 * job with the reason, under the usual failed-job contract.
 */
export function assertLtxCqFlfDelivered(artifacts: Array<{ assetType: string; filePath?: string; error?: string }>) {
  const videos = artifacts.filter((artifact) => artifact.assetType === "video");
  if (!videos.length) throw new Error("LTX 2.5 CQ First & Last Frame finished without returning a video.");
  const failed = videos.find((artifact) => artifact.error || !artifact.filePath);
  if (failed) {
    throw new Error(`The render finished on RunPod but could not be saved: ${failed.error ?? "it was not written to the project"}`);
  }
}

/**
 * Worker execution measured for each preset at 121 frames on 2026-10-01: 59 s,
 * 118 s and 280.5 s. Not the image-to-video fit -- 1440p runs ~60 s longer here
 * than there (219 s), so that line would under-quote it by a quarter.
 */
const MEASURED_EXECUTION_SECONDS_121: Readonly<Record<string, number>> = {
  "720p": 59,
  "1080p": 118.4,
  "1440p": 280.5,
};

/**
 * Billed worker seconds: the preset's measured execution, scaled by length for
 * the shorter clips, plus the minute of load and billed overhead the enhancer
 * showed on this pod.
 */
export function ltxCqFlfSeconds(resolution: string, frames: number) {
  return 60 + (MEASURED_EXECUTION_SECONDS_121[resolution] ?? MEASURED_EXECUTION_SECONDS_121["1440p"]) * (frames / 121);
}

/** Billed rate of the pod's RTX PRO 6000 MIG 2g.48gb workers; see podRuntimeCost.ts. */
const USD_PER_SECOND = 0.000462;
const CREDITS_PER_USD = 211;

export function ltxCqFlfCredits(resolution: Resolution | string | undefined, durationSeconds: number | undefined) {
  const preset = ltxCqFlfPreset(resolution) ?? PRESETS["1080p"];
  const label = LTX_CQ_FLF_RESOLUTIONS.find((key) => PRESETS[key] === preset) ?? "1080p";
  const seconds = LTX_CQ_FLF_DURATIONS.includes(durationSeconds ?? -1) ? durationSeconds! : LTX_CQ_FLF_DEFAULT_DURATION_SECONDS;
  const billed = ltxCqFlfSeconds(label, seconds * LTX_CQ_FLF_FPS + 1);
  return Math.max(1, Math.ceil(billed * USD_PER_SECOND * CREDITS_PER_USD));
}
