// How much detail an Image Editing crop keeps on its way through Nano Banana.
//
// Nano Banana does not draw at the size it is sent. It draws at one of a fixed
// set of sizes for each aspect ratio, all close in area to the resolution
// setting (1K is 1024x1024 at 1:1 and 1376x768 at 16:9), and the result is then
// scaled back up to the crop. For a small crop that is no loss. For a whole
// 5504px render sent at 1K it means the edit comes back enlarged about four
// times and visibly soft, which is worth saying before anyone pays for it.

import type { StillImageEditCrop } from "../../types";
import { editCropHeight, editCropWidth } from "./imageEditLayers";

/** About how many pixels Nano Banana draws at each resolution setting. */
const NANO_BANANA_OUTPUT_PIXELS: Record<string, number> = {
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "4K": 4096 * 4096,
};

/** At or past this enlargement an edit reads as soft next to the original. */
export const SOFT_EDIT_UPSCALE = 2;

export type NanoBananaOutputEstimate = {
  /** About the size the model draws, before it is scaled back to the crop. */
  width: number;
  height: number;
  /** How many times each edge is enlarged to fill the crop. Below 1 is a reduction. */
  upscale: number;
};

export function nanoBananaOutputEstimate(crop: StillImageEditCrop, resolution: string): NanoBananaOutputEstimate | undefined {
  const pixels = NANO_BANANA_OUTPUT_PIXELS[resolution];
  if (!pixels) return undefined;
  const width = editCropWidth(crop);
  const height = editCropHeight(crop);
  const aspect = width / height;
  return {
    width: Math.round(Math.sqrt(pixels * aspect)),
    height: Math.round(Math.sqrt(pixels / aspect)),
    upscale: Math.sqrt((width * height) / pixels),
  };
}

/**
 * A warning for the settings panel when the chosen resolution will leave the
 * edit soft, or undefined when it will not.
 *
 * Only suggests a resolution that exists, so a region too big even for 4K gets
 * no warning: there is nothing the artist could change here to fix it.
 */
export function softEditWarning(crop: StillImageEditCrop, resolution: string) {
  const estimate = nanoBananaOutputEstimate(crop, resolution);
  const higher = resolution === "1K" ? "2K or 4K" : resolution === "2K" ? "4K" : undefined;
  if (!estimate || !higher || estimate.upscale < SOFT_EDIT_UPSCALE) return undefined;
  return (
    `At ${resolution} the model draws this ${editCropWidth(crop)} × ${editCropHeight(crop)} px region at about ` +
    `${estimate.width} × ${estimate.height}, so the edit is enlarged about ${Math.round(estimate.upscale)}× and will look soft. ` +
    `${higher} keeps more detail.`
  );
}
