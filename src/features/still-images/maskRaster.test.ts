import { describe, expect, it, vi } from "vitest";

import { currentMaskEditCrop, maskBoundsFromPixels, maskCoverageBounds, renderMaskAlphaCanvas } from "./maskRaster";
import { createMaskDrawing, setMaskCropAspect, setMaskCropMargin, setMaskRectangleSelection } from "./maskDrawing";

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

it("keeps rectangle selection bounds exact without raster sampling", () => {
  const drawing = setMaskRectangleSelection(setMaskCropAspect(setMaskCropMargin(createMaskDrawing(6000, 4000), 0), "16:9"), {
    x: 1234,
    y: 567,
    width: 1600,
    height: 900,
  });
  expect(maskCoverageBounds(drawing)).toEqual({ left: 1234, top: 567, right: 2834, bottom: 1467 });
  expect(currentMaskEditCrop(drawing)).toMatchObject({ x: 1234, y: 567, width: 1600, height: 900 });
});

it("rasterizes a rectangle selection as a solid exact alpha region", () => {
  const fillRect = vi.fn();
  const context = {
    fillRect,
    lineCap: "butt",
    lineJoin: "miter",
    fillStyle: "",
    strokeStyle: "",
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D;
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  try {
    const drawing = setMaskRectangleSelection(createMaskDrawing(800, 600), {
      x: 123,
      y: 45,
      width: 320,
      height: 180,
    });
    const canvas = renderMaskAlphaCanvas(drawing);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(fillRect).toHaveBeenCalledOnce();
    expect(fillRect).toHaveBeenCalledWith(123, 45, 320, 180);
  } finally {
    getContext.mockRestore();
  }
});
