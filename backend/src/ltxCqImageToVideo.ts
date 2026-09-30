// Image to Video on the LTX 2.5 CQ pod: an input image plus a prompt, generated
// with LTX 2.5 dev INT8 -> distilled LoRA 450 at 1.0 -> CQ Enhancer V2 LoRA at 1.0.
//
// Source: the momi-i2v-cq-handoff package (2026-09-30) from
// brick-momen-sirri/worker-comfyui-LTX-2.5, branch codex/i2v-cq-experiment. Its
// workflow-api.json is copied verbatim into
// backend/workflow-ltx-cq-i2v/ltx25-cq-i2v.json (sha256 aff46be2...), and
// every limit below is the one its README and input-contract.json state.
//
// This is an experimental use of CQ -- its publisher documents restoration, not
// ordinary image-to-video -- tested on one marina scene at 1920x1088 (49 and 121
// frames) and 2560x1440 (121 frames, 219 s). The sampling recipe is therefore
// left exactly as tested: seed 42, CFG 1, the fixed 8-step sigmas, image strength
// 0.7, compression 18, both LoRAs at 1.0. Only size, length and prompt vary.
//
// Unlike the Video Enhancer this graph generates at the delivered frame rate (24)
// and makes its own audio, so the result needs no retiming. 1080p is the one
// preset with a post step: the model's 32 px grid makes it 1920x1088, and four
// rows come off the top and bottom afterwards.
//
// Same pod as the enhancer, same legacy workflow contract -- the deployed image
// has no named mode for this, so the complete graph is sent.

import path from "node:path";

import { ltxCqI2vWorkflowRoot } from "./config.js";
import type { Resolution, WorkflowModel } from "./types.js";

export const LTX_CQ_I2V_MODEL_ID = "ltx25_cq_i2v";

export const LTX_CQ_I2V_FPS = 24;
export const LTX_CQ_I2V_PROMPT_MAX_LENGTH = 12_000;
/** The tested seed. Fixed, like the rest of the recipe, for the initial integration. */
export const LTX_CQ_I2V_SEED = 42;

type Preset = {
  /** Size of the delivered file. */
  width: number;
  height: number;
  /** Size the model generates at, on its 32 px grid. */
  generationWidth: number;
  generationHeight: number;
};

/**
 * The two tested landscape presets. The contract would admit other 32 px sizes up
 * to 2560x1440, but only these were run on the GPU, and the handoff asks for them
 * to be the initial offer.
 */
const PRESETS: Readonly<Record<string, Preset>> = {
  "1080p": { width: 1920, height: 1080, generationWidth: 1920, generationHeight: 1088 },
  "1440p": { width: 2560, height: 1440, generationWidth: 2560, generationHeight: 1440 },
};

export const LTX_CQ_I2V_RESOLUTIONS = Object.keys(PRESETS);
/**
 * Whole seconds, each 24n+1 frames: 2 s is the tested 49 frames and 5 s the
 * tested 121, which is also the contract's ceiling. Every 24n+1 is 8n+1 too, so
 * the ones between satisfy the model's frame rule.
 */
export const LTX_CQ_I2V_DURATIONS = [2, 3, 4, 5];

export type LtxCqI2vPlan = Preset & { frames: number; durationSeconds: number };

export function isLtxCqI2vModelId(modelId: string | undefined) {
  return modelId === LTX_CQ_I2V_MODEL_ID;
}

export function ltxCqI2vWorkflowPath() {
  return path.join(ltxCqI2vWorkflowRoot, "ltx25-cq-i2v.json");
}

let cachedModel: WorkflowModel | undefined;

/** Registered rather than scanned, like the enhancer; see config.ts. One instance. */
export function ltxCqI2vWorkflowModel(): WorkflowModel {
  cachedModel ??= {
    id: LTX_CQ_I2V_MODEL_ID,
    name: "LTX 2.5 CQ Image to Video",
    category: "image_to_video",
    workflowPath: ltxCqI2vWorkflowPath(),
    description:
      "LTX 2.5 with the CQ Enhancer V2 LoRA, run on the studio's own GPU pod. Generates at up to 2560x1440 with " +
      "its own ambient audio. Experimental: tested on architectural scenes, and exact geometry is not guaranteed.",
    requiredInputs: ["prompt", "single_image", "resolution"],
    supportedResolutions: LTX_CQ_I2V_RESOLUTIONS,
    defaultResolution: "1440p",
    supportedDurations: LTX_CQ_I2V_DURATIONS,
    defaultDurationSeconds: 5,
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    imageSlotCount: 1,
    outputType: "video",
    estimatedCredits: ltxCqI2vCredits("1440p", 5),
    estimatedTime: "2-5 min",
  };
  return cachedModel;
}

/** "1440p", "2560x1440" or a resolution object, to the preset it names. */
export function ltxCqI2vPreset(resolution: Pick<Resolution, "width" | "height" | "label"> | string | undefined) {
  if (!resolution) return undefined;
  const key = typeof resolution === "string" ? resolution : (resolution.label ?? `${resolution.width}x${resolution.height}`);
  const normalized = key.toLowerCase().replace(/\s+/g, "");
  const byLabel = PRESETS[normalized];
  if (byLabel) return byLabel;
  return Object.values(PRESETS).find((preset) => `${preset.width}x${preset.height}` === normalized);
}

/** Throws with an artist-facing message on anything the tested contract does not cover. */
export function planLtxCqI2v(resolution: Resolution | undefined, durationSeconds: number | undefined): LtxCqI2vPlan {
  const preset = ltxCqI2vPreset(resolution);
  if (!preset) throw new Error(`LTX 2.5 CQ supports ${LTX_CQ_I2V_RESOLUTIONS.join(" and ")} only.`);
  const seconds = durationSeconds ?? 5;
  if (!LTX_CQ_I2V_DURATIONS.includes(seconds)) {
    throw new Error(`LTX 2.5 CQ supports ${LTX_CQ_I2V_DURATIONS.join(", ")} second clips.`);
  }
  return { ...preset, frames: seconds * LTX_CQ_I2V_FPS + 1, durationSeconds: seconds };
}

type ApiGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

/**
 * One job's values into a fresh copy of the tested graph.
 *
 * Width and height go to both the latent and the conditioning image's resize,
 * frames to both the video and audio latents -- a mismatch in either pair renders
 * wrongly rather than failing. Each binding checks its node's class so a replaced
 * graph fails here instead of quietly keeping a default.
 */
export function buildLtxCqI2vWorkflow(
  template: unknown,
  input: { plan: LtxCqI2vPlan; prompt: string; imageName: string; outputPrefix: string },
) {
  const graph = structuredClone(template) as ApiGraph;
  const set = (nodeId: string, classType: string, key: string, value: unknown) => {
    const node = graph[nodeId];
    if (!node || node.class_type !== classType || !node.inputs || !(key in node.inputs)) {
      throw new Error(`The LTX 2.5 CQ graph has no ${classType} node "${nodeId}" with input ${key}.`);
    }
    node.inputs[key] = value;
  };

  set("positive", "CLIPTextEncode", "text", input.prompt);
  set("load_image", "LoadImage", "image", input.imageName);
  set("image_resize", "ImageScale", "width", input.plan.generationWidth);
  set("image_resize", "ImageScale", "height", input.plan.generationHeight);
  set("video_latent", "EmptyLTXVLatentVideo", "width", input.plan.generationWidth);
  set("video_latent", "EmptyLTXVLatentVideo", "height", input.plan.generationHeight);
  set("video_latent", "EmptyLTXVLatentVideo", "length", input.plan.frames);
  set("audio_latent", "LTXVEmptyLatentAudio", "frames_number", input.plan.frames);
  set("sample_noise", "RandomNoise", "noise_seed", LTX_CQ_I2V_SEED);
  set("save", "SaveVideo", "filename_prefix", input.outputPrefix);
  return graph;
}

/**
 * Billed worker seconds. Fitted to the handoff's runs -- 1920x1088x49 in 54 s,
 * x121 in 110 s, 2560x1440x121 in 219 s -- which are close to linear in
 * pixel-frames, plus the minute of load and billed overhead the enhancer showed.
 */
export function ltxCqI2vSeconds(width: number, height: number, frames: number) {
  return 60 + 0.45 * ((width * height * frames) / 1_000_000);
}

/** Billed rate of the pod's RTX PRO 6000 MIG 2g.48gb workers; see podRuntimeCost.ts. */
const USD_PER_SECOND = 0.000462;
const CREDITS_PER_USD = 211;

export function ltxCqI2vCredits(resolution: Resolution | string | undefined, durationSeconds: number | undefined) {
  const preset = ltxCqI2vPreset(resolution) ?? PRESETS["1440p"];
  const frames = (LTX_CQ_I2V_DURATIONS.includes(durationSeconds ?? 5) ? (durationSeconds ?? 5) : 5) * LTX_CQ_I2V_FPS + 1;
  const seconds = ltxCqI2vSeconds(preset.generationWidth, preset.generationHeight, frames);
  return Math.max(1, Math.ceil(seconds * USD_PER_SECOND * CREDITS_PER_USD));
}
