import {
  kleinUpscaleCreditsForSource,
  kleinUpscaleOutputMegapixels,
  kleinUpscaleProjectedSeconds,
  TILED_UPSCALE_RENDER_WINDOW_SECONDS,
} from "../../utils/creditEstimator";
import type { StillImageSettingValue } from "./stillImageCategories";

export type KleinUpscaleProjection = {
  outputWidth: number;
  outputHeight: number;
  megapixels: number;
  credits: number;
  seconds: number;
  /**
   * Whether the render is expected to outlast the endpoint's execution window.
   *
   * A warning rather than a block. A 21MP source at x4 is 335MP of tiles and
   * around 78 minutes, which is a real thing to ask for -- the artist is better
   * served by the number than by a refusal, and two of these were discovered
   * only after the pod had billed for the full ten minutes and returned nothing.
   */
  exceedsRenderWindow: boolean;
};

/**
 * What a Klein upscale of this source at these settings is expected to cost and take.
 *
 * Undefined until the source has been measured. The panel decodes the image to
 * show it anyway, so the dimensions are free here; before that there is nothing
 * to project from and nothing worth guessing.
 */
export function kleinUpscaleProjection(
  source: { width?: number; height?: number } | undefined,
  settings: Record<string, StillImageSettingValue | undefined>,
): KleinUpscaleProjection | undefined {
  const options = {
    sourceWidth: source?.width,
    sourceHeight: source?.height,
    upscale: typeof settings.upscale === "string" ? settings.upscale : undefined,
    upscaleMode: typeof settings.mode === "string" ? settings.mode : undefined,
  };

  const megapixels = kleinUpscaleOutputMegapixels(options);
  const credits = kleinUpscaleCreditsForSource(options);
  const seconds = kleinUpscaleProjectedSeconds(options);
  if (megapixels == null || credits == null || seconds == null) return undefined;

  const factor = options.upscale === "x4" ? 4 : 2;
  return {
    outputWidth: Math.round(Number(source?.width) * factor),
    outputHeight: Math.round(Number(source?.height) * factor),
    megapixels,
    credits,
    seconds,
    exceedsRenderWindow: seconds > TILED_UPSCALE_RENDER_WINDOW_SECONDS,
  };
}

/** "3 min" / "1 h 18 min" -- a wait, not a duration to the second. */
export function formatProjectedWait(seconds: number) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
