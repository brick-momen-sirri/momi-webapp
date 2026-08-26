import { describe, expect, it } from "vitest";

import { maskBoundsFromPixels } from "./maskRaster";

function alphaPixels(width: number, height: number, active: Array<[number, number, number]>) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, alpha] of active) pixels[(y * width + x) * 4 + 3] = alpha;
  return pixels;
}

describe("maskBoundsFromPixels", () => {
  it("finds current coverage and translates sampled cells conservatively into source pixels", () => {
    const pixels = alphaPixels(4, 3, [
      [1, 1, 255],
      [2, 1, 255],
    ]);

    expect(maskBoundsFromPixels(pixels, 4, 3, 0.5, 8, 6)).toEqual({
      left: 2,
      top: 2,
      right: 6,
      bottom: 4,
    });
  });

  it("returns no bounds after erasing every covered pixel", () => {
    expect(maskBoundsFromPixels(alphaPixels(4, 3, []), 4, 3, 1, 4, 3)).toBeUndefined();
  });

  it("ignores negligible antialiasing residue at erased edges", () => {
    const pixels = alphaPixels(4, 3, [
      [0, 0, 4],
      [3, 2, 255],
    ]);
    expect(maskBoundsFromPixels(pixels, 4, 3, 1, 4, 3)).toEqual({ left: 3, top: 2, right: 4, bottom: 3 });
  });
});
