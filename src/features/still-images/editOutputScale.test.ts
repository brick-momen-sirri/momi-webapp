import { describe, expect, it } from "vitest";

import { nanoBananaOutputEstimate, softEditWarning } from "./editOutputScale";
import { wholeImageCrop } from "./imageEditLayers";

describe("nanoBananaOutputEstimate", () => {
  it("draws close to the resolution's area in the crop's own shape", () => {
    const estimate = nanoBananaOutputEstimate(wholeImageCrop(5504, 3072), "1K");
    // Within a few pixels of Nano Banana's own 16:9 size at 1K, 1376 x 768.
    expect(estimate).toMatchObject({ width: 1371, height: 765 });
    expect(estimate?.upscale).toBeCloseTo(4, 1);
    expect(nanoBananaOutputEstimate(wholeImageCrop(5504, 3072), "8K")).toBeUndefined();
  });
});

describe("softEditWarning", () => {
  it("warns when a large region would come back enlarged, and names a higher setting", () => {
    expect(softEditWarning(wholeImageCrop(5504, 3072), "1K")).toBe(
      "At 1K the model draws this 5504 × 3072 px region at about 1371 × 765, so the edit is enlarged about 4× and will look soft. 2K or 4K keeps more detail.",
    );
    expect(softEditWarning(wholeImageCrop(5504, 3072), "2K")).toMatch(/enlarged about 2×.*4K keeps more detail\.$/);
  });

  it("stays quiet for a crop the resolution already covers, and when nothing higher exists", () => {
    expect(softEditWarning({ x: 0, y: 0, size: 1200, width: 1200, height: 1200, sourceWidth: 4000, sourceHeight: 3000 }, "1K")).toBe(
      undefined,
    );
    expect(softEditWarning(wholeImageCrop(5504, 3072), "4K")).toBeUndefined();
    expect(softEditWarning(wholeImageCrop(20000, 12000), "4K")).toBeUndefined();
  });
});
