// The Animation tab's Video Enhancer: LTX 2.5 CQ Enhancer V2 on its own pod.
//
// Mirrors backend/src/videoEnhancer.ts by hand, the way creditEstimator mirrors
// its backend counterpart. The backend is the authority -- it probes the source
// and plans the real size and frame count at dispatch -- so everything here is
// the preview and the pre-flight quote.

import type { ModelType, WorkflowOptions } from "../../types";

/** MUST match VIDEO_ENHANCER_MODEL_ID in backend/src/videoEnhancer.ts. */
export const VIDEO_ENHANCER_MODEL_ID = "video_enhancer_ltx25_cq";

export const VIDEO_ENHANCER_LONG_SIDES = [1280, 1920, 2560] as const;
export type VideoEnhancerLongSide = (typeof VIDEO_ENHANCER_LONG_SIDES)[number];
export const DEFAULT_VIDEO_ENHANCER_LONG_SIDE: VideoEnhancerLongSide = 2560;
export const VIDEO_ENHANCER_MAX_FRAMES = 121;
const MAX_PIXELS = 2560 * 1440;
const USD_PER_SECOND = 0.000462;
const CREDITS_PER_USD = 211;

export function isVideoEnhancerModel(model: Pick<ModelType, "id"> | undefined) {
  return model?.id === VIDEO_ENHANCER_MODEL_ID;
}

export function normalizeVideoEnhancerLongSide(value: unknown): VideoEnhancerLongSide {
  return VIDEO_ENHANCER_LONG_SIDES.includes(value as VideoEnhancerLongSide)
    ? (value as VideoEnhancerLongSide)
    : DEFAULT_VIDEO_ENHANCER_LONG_SIDE;
}

export function reusableVideoEnhancerLongSide(options: WorkflowOptions | undefined) {
  const value = options?.videoEnhancer?.longSide;
  return VIDEO_ENHANCER_LONG_SIDES.includes(value as VideoEnhancerLongSide) ? (value as VideoEnhancerLongSide) : undefined;
}

/** The source aspect on the model's 32 px grid, long side on target, area held to 2560x1440. */
export function enhancedDimensions(sourceWidth: number, sourceHeight: number, longSide: number) {
  let scale = Math.min(longSide / Math.max(sourceWidth, sourceHeight), Math.sqrt(MAX_PIXELS / (sourceWidth * sourceHeight)));
  for (;;) {
    const width = gridDimension(sourceWidth * scale);
    const height = gridDimension(sourceHeight * scale);
    if (width * height <= MAX_PIXELS && Math.max(width, height) <= longSide) return { width, height };
    scale *= 0.995;
  }
}

function gridDimension(value: number) {
  return Math.min(2560, Math.max(256, Math.round(value / 32) * 32));
}

/** Billed worker seconds, fitted to the measured runs. See videoEnhancerSeconds on the backend. */
export function videoEnhancerSeconds(width: number, height: number, frames = VIDEO_ENHANCER_MAX_FRAMES) {
  return 60 + 0.1745 * ((width * height * frames) / 1_000_000) ** 1.35;
}

export function videoEnhancerCredits(longSide: number, width?: number, height?: number) {
  const size = width && height ? enhancedDimensions(width, height, longSide) : enhancedDimensions(1920, 1080, longSide);
  const seconds = videoEnhancerSeconds(size.width, size.height);
  return Math.max(1, Math.ceil(seconds * USD_PER_SECOND * CREDITS_PER_USD));
}

/** "about 12 min", for a render that will take minutes rather than seconds. */
export function videoEnhancerTimeLabel(longSide: number, width?: number, height?: number) {
  const size = width && height ? enhancedDimensions(width, height, longSide) : enhancedDimensions(1920, 1080, longSide);
  const minutes = Math.max(1, Math.round(videoEnhancerSeconds(size.width, size.height) / 60));
  return `about ${minutes} min`;
}
