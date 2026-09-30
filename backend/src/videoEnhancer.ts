// The Animation tab's Video Enhancer: LTX 2.5 with the CQ Enhancer V2 LoRA,
// running on its own RunPod endpoint (RUNPOD_ENDPOINT_ID_VIDEO_ENHANCER).
//
// Where this comes from: brick-momen-sirri/worker-comfyui-LTX-2.5, whose
// workflows/video_enhance_cq_v2.json is copied verbatim into
// backend/workflow-video-enhancer/ltx25-cq-v2.json (sha256 80dfe08b..., repo
// commit a602e5e). That repo's docs/cq-v2.md is the reference for every limit here.
//
// Why the graph is sent raw rather than as the worker's named mode: the deployed
// image still caps named requests at 1536 px on the long side, and the one run
// verified at 2560x1440 / 121 frames (2026-09-30, 688 s) went through the legacy
// `workflow` + `videos` contract instead. That contract does no preprocessing of
// its own -- no resize, trim or fps change -- so the backend does exactly what
// the worker's named mode would have done before handing the file over. See
// videoEnhancerMedia.ts.
//
// The model runs at 30 fps. A 24 fps source is not resampled to 30 (that would
// invent frames and cut the clip short); every source frame is instead retimed
// to 30 fps going in and back to the source rate coming out, which is how the
// verified run preserved all 121 frames and the 5.04 s duration.

import path from "node:path";

import { runpodTimeoutMs, runpodVideoEnhancerExecutionTimeoutMs, videoEnhancerWorkflowRoot } from "./config.js";
import type { WorkflowModel } from "./types.js";

export const VIDEO_ENHANCER_MODEL_ID = "video_enhancer_ltx25_cq";

/** Long-side choices offered to the artist. 2560 is the largest verified canvas. */
export const VIDEO_ENHANCER_LONG_SIDES = [1280, 1920, 2560] as const;
export type VideoEnhancerLongSide = (typeof VIDEO_ENHANCER_LONG_SIDES)[number];
export const DEFAULT_VIDEO_ENHANCER_LONG_SIDE: VideoEnhancerLongSide = 2560;

/** The frame rate the CQ recipe conditions on. Fixed by the publisher's graph. */
export const VIDEO_ENHANCER_MODEL_FPS = 30;
/** 121 is the longest single job verified at 2560x1440. The graph itself allows 153. */
export const VIDEO_ENHANCER_MAX_FRAMES = 121;
const MIN_FRAMES = 9;
/** 2560x1440, the verified canvas. A square source is held to the same area, not 2560x2560. */
export const VIDEO_ENHANCER_MAX_PIXELS = 2560 * 1440;
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 2560;
const DIMENSION_STEP = 32;
/** The publisher's default; fixed so a re-run of the same clip is reproducible. */
export const DEFAULT_VIDEO_ENHANCER_SEED = 42;

/**
 * Retiming stays sensible for ordinary delivery rates only. Outside this band a
 * 1:1 frame retime would run motion at more than 1.5x or less than 1x speed
 * through the model, so those sources are resampled to 30 fps instead -- the
 * publisher's own preprocessing -- and delivered at 30.
 */
const RETIME_MIN_FPS = 20;
const RETIME_MAX_FPS = 30.5;

export type VideoEnhancerPlan = {
  /** Enhanced frame size. Also the size sent to the model; nothing is resized afterwards. */
  width: number;
  height: number;
  /** Frames enhanced, always 8n+1. */
  frames: number;
  /** Display size of the source, after any non-square pixel aspect is applied. */
  sourceWidth: number;
  sourceHeight: number;
  /** Source frame rate as ffprobe reports it, e.g. "24/1" or "24000/1001". */
  sourceFps: string;
  /**
   * "retime": every source frame is shown to the model at 30 fps and put back at
   * sourceFps afterwards. "resample": the source is converted to 30 fps first
   * (frames dropped or repeated) and the result is delivered at 30.
   */
  timing: "retime" | "resample";
  /** Frame rate of the delivered file, as a rational. */
  outputFps: string;
  /** The source's own audio is put back on the result; the model's copy is silence. */
  sourceHasAudio: boolean;
};

export type VideoEnhancerOptions = {
  longSide: VideoEnhancerLongSide;
  seed?: number;
  /**
   * Written by the dispatcher once the source has been probed, and read back when
   * the result is restored to the source frame rate. Never accepted from a
   * client: normalizeVideoEnhancerOptions drops it.
   */
  plan?: VideoEnhancerPlan;
};

export type VideoEnhancerSourceProbe = {
  /** Display dimensions. */
  width: number;
  height: number;
  fps: string;
  /** Decoded frame count, when the container states it or it was counted. */
  frames?: number;
  durationSeconds: number;
  hasAudio: boolean;
};

export function isVideoEnhancerModelId(modelId: string | undefined) {
  return modelId === VIDEO_ENHANCER_MODEL_ID;
}

export function videoEnhancerWorkflowPath() {
  return path.join(videoEnhancerWorkflowRoot, "ltx25-cq-v2.json");
}

/**
 * The enhancer as a WorkflowModel, so it rides the same job pipeline every
 * Animation model does. Listed in GET /api/models (it belongs in the Animation
 * picker) but never produced by the workflow scan -- see config.ts.
 */
export function videoEnhancerWorkflowModel(): WorkflowModel {
  // One instance, so getWorkflowModel and getWorkflowModels hand out the same
  // object -- as they do for every scanned model.
  cachedModel ??= buildVideoEnhancerWorkflowModel();
  return cachedModel;
}

let cachedModel: WorkflowModel | undefined;

function buildVideoEnhancerWorkflowModel(): WorkflowModel {
  return {
    id: VIDEO_ENHANCER_MODEL_ID,
    name: "Video Enhancer",
    category: "video_upscaling",
    workflowPath: videoEnhancerWorkflowPath(),
    description:
      "LTX 2.5 with the CQ Enhancer V2 LoRA regenerates footage at up to 2560 px on the long side. " +
      `Enhances the first ${VIDEO_ENHANCER_MAX_FRAMES} frames and keeps the source frame rate and audio. ` +
      "Generative, so colour and fine texture can shift from the source.",
    requiredInputs: ["video"],
    requiresPrompt: false,
    requiresImage: false,
    requiresStartEndFrames: false,
    imageSlotCount: 0,
    outputType: "video",
    estimatedCredits: videoEnhancerCredits(DEFAULT_VIDEO_ENHANCER_LONG_SIDE),
    estimatedTime: "3-15 min",
  };
}

/**
 * Validate what a client sent. Returns the object that is persisted on the job,
 * so anything not checked here -- a client-supplied plan included -- is dropped.
 */
export function normalizeVideoEnhancerOptions(value: unknown): VideoEnhancerOptions {
  if (value == null) return { longSide: DEFAULT_VIDEO_ENHANCER_LONG_SIDE };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Video Enhancer options must be an object.");
  }
  const options = value as Record<string, unknown>;
  const longSide = options.longSide ?? DEFAULT_VIDEO_ENHANCER_LONG_SIDE;
  if (!VIDEO_ENHANCER_LONG_SIDES.includes(longSide as VideoEnhancerLongSide)) {
    throw new Error(`Video Enhancer longSide must be one of: ${VIDEO_ENHANCER_LONG_SIDES.join(", ")}.`);
  }
  const normalized: VideoEnhancerOptions = { longSide: longSide as VideoEnhancerLongSide };
  if (options.seed != null) {
    if (typeof options.seed !== "number" || !Number.isSafeInteger(options.seed) || options.seed < 0) {
      throw new Error("Video Enhancer seed must be a non-negative whole number.");
    }
    normalized.seed = options.seed;
  }
  return normalized;
}

/** Parse "24/1", "24000/1001" or "25" into frames per second. */
export function parseFrameRate(value: string | undefined) {
  if (!value) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

/**
 * Decide the frame size, frame count and timing for one source.
 *
 * Throws with an artist-facing message when the source cannot be enhanced at all,
 * which happens before anything is uploaded or paid for.
 */
export function planVideoEnhancement(source: VideoEnhancerSourceProbe, longSide: VideoEnhancerLongSide): VideoEnhancerPlan {
  const fps = parseFrameRate(source.fps);
  if (!fps) throw new Error("Could not read the input video's frame rate.");
  if (!(source.width > 0 && source.height > 0)) throw new Error("Could not read the input video's dimensions.");

  const timing = fps >= RETIME_MIN_FPS && fps <= RETIME_MAX_FPS ? "retime" : "resample";
  // Retiming keeps every frame, so the source's own count is what is available.
  // Resampling makes a new 30 fps sequence, whose length follows from duration.
  const countedFrames = source.frames ?? Math.floor(source.durationSeconds * fps + 1e-6);
  const available = timing === "retime" ? countedFrames : Math.floor(source.durationSeconds * VIDEO_ENHANCER_MODEL_FPS + 1e-6);
  const frames = eightNPlusOneAtMost(Math.min(VIDEO_ENHANCER_MAX_FRAMES, available));
  if (frames < MIN_FRAMES) {
    throw new Error(`The input video is too short to enhance: it needs at least ${MIN_FRAMES} frames.`);
  }

  const { width, height } = enhancedDimensions(source.width, source.height, longSide);
  return {
    width,
    height,
    frames,
    sourceWidth: source.width,
    sourceHeight: source.height,
    sourceFps: source.fps,
    timing,
    outputFps: timing === "retime" ? source.fps : `${VIDEO_ENHANCER_MODEL_FPS}/1`,
    sourceHasAudio: source.hasAudio,
  };
}

function eightNPlusOneAtMost(value: number) {
  return value < 1 ? 0 : Math.floor((value - 1) / 8) * 8 + 1;
}

/**
 * The enhanced frame size: the source aspect, scaled so the long side lands on
 * the requested length, both sides on the model's 32 px grid, and the area held
 * to the verified 2560x1440.
 *
 * The small aspect error the 32 px grid introduces is taken as a centre crop
 * during preprocessing, never a stretch.
 */
export function enhancedDimensions(sourceWidth: number, sourceHeight: number, longSide: number) {
  let scale = Math.min(
    longSide / Math.max(sourceWidth, sourceHeight),
    Math.sqrt(VIDEO_ENHANCER_MAX_PIXELS / (sourceWidth * sourceHeight)),
  );
  // Terminates: every step shrinks the scale, and 256x256 fits every limit.
  for (;;) {
    const width = gridDimension(sourceWidth * scale);
    const height = gridDimension(sourceHeight * scale);
    if (width * height <= VIDEO_ENHANCER_MAX_PIXELS && Math.max(width, height) <= longSide) return { width, height };
    scale *= 0.995;
  }
}

function gridDimension(value: number) {
  const snapped = Math.round(value / DIMENSION_STEP) * DIMENSION_STEP;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, snapped));
}

type ApiGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

/**
 * Write one job's values into the CQ graph.
 *
 * Every binding names the node by id and checks its class, so a replaced graph
 * file fails here rather than rendering with a default the job never asked for.
 * fps and the sampler settings are left exactly as the publisher's recipe has them.
 */
export function buildVideoEnhancerWorkflow(
  template: unknown,
  input: { plan: VideoEnhancerPlan; videoName: string; seed: number; outputPrefix: string },
) {
  const graph = structuredClone(template) as ApiGraph;
  const set = (nodeId: string, classType: string, key: string, value: unknown) => {
    const node = graph[nodeId];
    if (!node || node.class_type !== classType || !node.inputs || !(key in node.inputs)) {
      throw new Error(`The Video Enhancer graph has no ${classType} node "${nodeId}" with input ${key}.`);
    }
    node.inputs[key] = value;
  };

  set("load_video", "LoadVideo", "file", input.videoName);
  set("video_latent", "EmptyLTXVLatentVideo", "width", input.plan.width);
  set("video_latent", "EmptyLTXVLatentVideo", "height", input.plan.height);
  set("video_latent", "EmptyLTXVLatentVideo", "length", input.plan.frames);
  set("audio_latent", "LTXVEmptyLatentAudio", "frames_number", input.plan.frames);
  set("noise", "RandomNoise", "noise_seed", input.seed);
  set("save", "SaveVideo", "filename_prefix", input.outputPrefix);
  return graph;
}

/**
 * The RunPod policy sent with every enhancer request. See
 * runpodVideoEnhancerExecutionTimeoutMs for why the endpoint's own 10-minute
 * limit cannot be left to apply. The ttl -- queue plus execution -- ends a few
 * minutes after this app stops waiting, so a job nobody is polling any more is
 * dropped by RunPod rather than run to completion and billed.
 */
export function videoEnhancerRunpodPolicy() {
  return {
    executionTimeout: runpodVideoEnhancerExecutionTimeoutMs,
    ttl: Math.max(runpodTimeoutMs, runpodVideoEnhancerExecutionTimeoutMs) + 5 * 60_000,
  };
}

/**
 * Seconds of billed worker time for one job.
 *
 * Fitted to the measured runs on endpoint dfadob3rm5dg32 (docs/cq-v2*.json in the
 * worker repo): 1280x704x33 in 50 s, 2560x1440x25 in 89-97 s, 2560x1440x121 in
 * 688 s with 714 s billed. Superlinear in pixel-frames, as attention is, plus a
 * fixed minute for model load and the billed overhead around execution.
 */
export function videoEnhancerSeconds(width: number, height: number, frames: number) {
  const megapixelFrames = (width * height * frames) / 1_000_000;
  return 60 + 0.1745 * megapixelFrames ** 1.35;
}

/** Billed rate of the endpoint's RTX PRO 6000 MIG 2g.48gb workers; see podRuntimeCost.ts. */
const VIDEO_ENHANCER_USD_PER_SECOND = 0.000462;
const CREDITS_PER_USD = 211;

/**
 * The pre-flight estimate. The real plan needs the source probed, which happens
 * at dispatch, so this assumes a 16:9 source long enough for the full 121 frames
 * -- the common case, and the most it can cost at that long side.
 */
export function videoEnhancerCredits(longSide: number, width?: number, height?: number, frames?: number) {
  const size = width && height ? { width, height } : enhancedDimensions(1920, 1080, longSide);
  const seconds = videoEnhancerSeconds(size.width, size.height, frames ?? VIDEO_ENHANCER_MAX_FRAMES);
  return Math.max(1, Math.ceil(seconds * VIDEO_ENHANCER_USD_PER_SECOND * CREDITS_PER_USD));
}
