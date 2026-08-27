import { describe, expect, it } from "vitest";

import {
  aspectEditCrop,
  drawingForCrop,
  editCropHeight,
  editCropWidth,
  editGenerationBaseLayers,
  squareEditCrop,
  visibleEditLayers,
  descriptorMaskDrawing,
} from "./imageEditLayers";
import {
  createMaskDrawing,
  maskTransform,
  rotationTransform,
  scaleTransform,
  setMaskRectangleSelection,
  setMaskTransform,
  transformPoint,
  type MaskDrawing,
} from "./maskDrawing";
import type { StillImageCategoryState, StillImageEditLayer } from "./stillImageCategories";

function drawing(overrides: Partial<MaskDrawing> = {}): MaskDrawing {
  return {
    width: 2000,
    height: 1200,
    softness: 0,
    strokes: [{ tool: "brush", radius: 50, points: [{ x: 1800, y: 300 }] }],
    ...overrides,
  };
}

describe("squareEditCrop", () => {
  it("creates a 1:1 source-pixel crop with context and clamps it to the image", () => {
    expect(squareEditCrop(drawing())).toEqual({
      x: 1700,
      y: 200,
      size: 200,
      width: 200,
      height: 200,
      sourceWidth: 2000,
      sourceHeight: 1200,
    });
  });

  it("keeps erased strokes out of the outer bound", () => {
    const crop = squareEditCrop(
      drawing({
        strokes: [
          { tool: "brush", radius: 20, points: [{ x: 400, y: 500 }] },
          { tool: "eraser", radius: 200, points: [{ x: 1800, y: 1000 }] },
        ],
      }),
    );
    expect(crop.x).toBeLessThanOrEqual(380);
    expect(crop.x + crop.size).toBeLessThan(800);
  });

  it("uses current raster coverage so an erased mask can shrink and reposition", () => {
    const source = drawing({
      strokes: [
        { tool: "brush", radius: 40, points: [{ x: 400, y: 500 }] },
        { tool: "brush", radius: 40, points: [{ x: 1500, y: 500 }] },
        { tool: "eraser", radius: 80, points: [{ x: 1500, y: 500 }] },
      ],
    });
    const historicalCrop = squareEditCrop(source);
    const currentCrop = squareEditCrop(source, 0.5, { left: 360, top: 460, right: 440, bottom: 540 });

    expect(currentCrop.size).toBeLessThan(historicalCrop.size);
    expect(currentCrop.x).toBeLessThan(500);
    expect(currentCrop.x + currentCrop.size).toBeLessThan(800);
  });

  it("rejects a painted region no in-bounds square could contain", () => {
    expect(() =>
      squareEditCrop(
        drawing({
          strokes: [
            {
              tool: "lasso",
              radius: 0,
              points: [
                { x: 0, y: 200 },
                { x: 1600, y: 200 },
                { x: 1600, y: 500 },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/too wide for a square crop/i);
  });
});

describe("aspectEditCrop", () => {
  const bounds = { left: 350, top: 450, right: 450, bottom: 550 };

  it("creates an exact 16:9 crop that contains the mask and remains in bounds", () => {
    const crop = aspectEditCrop(drawing(), "16:9", 0.5, bounds);
    expect(crop.width).toBe(368);
    expect(crop.height).toBe(207);
    expect(editCropWidth(crop) / editCropHeight(crop)).toBe(16 / 9);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + editCropWidth(crop)).toBeLessThanOrEqual(crop.sourceWidth);
    expect(crop.y + editCropHeight(crop)).toBeLessThanOrEqual(crop.sourceHeight);
  });

  it("lets a smaller margin shrink the crop around the same mask", () => {
    const tight = aspectEditCrop(drawing(), "16:9", 0, bounds);
    const roomy = aspectEditCrop(drawing(), "16:9", 1, bounds);
    expect(editCropWidth(tight)).toBeLessThan(editCropWidth(roomy));
    expect(editCropHeight(tight)).toBeLessThan(editCropHeight(roomy));
  });

  it("reads old square crops without explicit rectangular dimensions", () => {
    const legacy = { x: 0, y: 0, size: 320, sourceWidth: 1000, sourceHeight: 800 };
    expect(editCropWidth(legacy)).toBe(320);
    expect(editCropHeight(legacy)).toBe(320);
  });

  it("uses a rectangle selection as exact coverage and translates it into crop coordinates", () => {
    const source = drawing({
      strokes: [],
      selection: { x: 400, y: 300, width: 320, height: 180 },
    });
    const crop = aspectEditCrop(source, "16:9", 0);
    expect(crop.width).toBe(320);
    expect(crop.height).toBe(180);
    expect(crop.x).toBe(400);
    expect(crop.y).toBe(300);
    expect(drawingForCrop(source, crop).selection).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });

  it("creates an exact 9:16 crop for a portrait selection", () => {
    const source = drawing({
      strokes: [],
      selection: { x: 400, y: 200, width: 180, height: 320 },
      cropAspect: "9:16",
    });
    const crop = aspectEditCrop(source, "9:16", 0);

    expect(crop).toMatchObject({ x: 400, y: 200, width: 180, height: 320 });
    expect(editCropWidth(crop) / editCropHeight(crop)).toBe(9 / 16);
  });
});

it("translates mask points into crop pixels without scaling them", () => {
  const source = drawing();
  const crop = squareEditCrop(source);
  const cropped = drawingForCrop(source, crop);
  expect(cropped.width).toBe(crop.size);
  expect(cropped.height).toBe(crop.size);
  expect(cropped.strokes[0].points[0]).toEqual({ x: 100, y: 100 });
  expect(cropped.strokes[0].radius).toBe(50);
});

describe("edit layer bases", () => {
  const crop = { x: 10, y: 20, size: 200, sourceWidth: 2000, sourceHeight: 1200 };

  function layer(id: string, order: number, overrides: Partial<StillImageEditLayer> = {}): StillImageEditLayer {
    return {
      id,
      name: id,
      mask: drawing(),
      crop,
      prompt: id,
      jobId: `job_${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      visible: true,
      order,
      revision: 1,
      status: "completed",
      generatedCropSourceUrl: `/api/media?path=${id}-current.png`,
      generatedCropUrl: `/api/jobs/job_${id}/result-media`,
      maskSourceUrl: `/api/media?path=${id}-mask.png`,
      ...overrides,
      mode: overrides.mode ?? "inpaint",
      references: overrides.references ?? [],
      documentId: overrides.documentId ?? "editdoc_test",
    };
  }

  function stateWith(layers: StillImageEditLayer[], activeEditLayerId?: string): StillImageCategoryState {
    return { images: [], prompt: "", seed: "", settings: {}, editLayers: layers, activeEditLayerId };
  }

  it("uses the current visible stack for a new edit", () => {
    const lower = layer("lower", 0);
    const hidden = layer("hidden", 1, { visible: false });
    const upper = layer("upper", 2);
    const state = stateWith([upper, hidden, lower]);

    expect(visibleEditLayers(state).map((entry) => entry.layerId)).toEqual(["lower", "upper"]);
    expect(editGenerationBaseLayers(state).map((entry) => entry.layerId)).toEqual(["lower", "upper"]);
  });

  it("keeps the last completed crop visible while a replacement is queued", () => {
    const regenerating = layer("regenerating", 0, { status: "queued" });
    expect(visibleEditLayers(stateWith([regenerating])).map((entry) => entry.layerId)).toEqual(["regenerating"]);
    expect(editGenerationBaseLayers(stateWith([regenerating])).map((entry) => entry.layerId)).toEqual(["regenerating"]);
  });

  it("regenerates against the selected layer's frozen base after lower layers change", () => {
    const lower = layer("lower", 0, { generatedCropSourceUrl: "/api/media?path=lower-new.png" });
    const selected = layer("selected", 1, {
      baseLayers: [
        {
          layerId: "lower",
          crop,
          generatedCropUrl: "/api/media?path=lower-original-take.png",
          maskSourceUrl: "/api/media?path=lower-original-mask.png",
        },
      ],
    });

    const base = editGenerationBaseLayers(stateWith([lower, selected], selected.id));
    expect(base).toHaveLength(1);
    expect(base[0].generatedCropSourceUrl).toBe("/api/media?path=lower-original-take.png");
    expect(base[0].mask).toBeUndefined();
    expect(base[0].maskSourceUrl).toBe("/api/media?path=lower-original-mask.png");
  });

  it("keeps an original-only frozen base empty instead of adopting later layers", () => {
    const lower = layer("lower", 0);
    const selected = layer("selected", 1, { baseLayers: [] });
    expect(editGenerationBaseLayers(stateWith([lower, selected], selected.id))).toEqual([]);
  });
});

const base = setMaskRectangleSelection(createMaskDrawing(400, 300), { x: 40, y: 40, width: 60, height: 60 });
const crop = { x: 20, y: 20, size: 100, width: 100, height: 100, sourceWidth: 400, sourceHeight: 300 };

describe("descriptorMaskDrawing", () => {
  it("hands back the mask untouched when nothing has been done to it", () => {
    const resolved = descriptorMaskDrawing({ layerId: "a", crop, generatedCropSourceUrl: "a.png", mask: base });
    expect(resolved).toBe(base);
  });

  it("keeps a chained mask in step with its layer rather than moving it twice", () => {
    const resolved = descriptorMaskDrawing({
      layerId: "a",
      crop,
      generatedCropSourceUrl: "a.png",
      mask: base,
      offset: { x: 30, y: 10 },
      maskOffset: { x: 30, y: 10 },
    });
    expect(resolved?.selection).toEqual(base.selection);
  });

  it("writes an unchained mask's own position into its geometry", () => {
    // The content moved by 30,10 and the mask stayed, so relative to the moved
    // layer the mask is 30,10 the other way.
    const resolved = descriptorMaskDrawing({
      layerId: "a",
      crop,
      generatedCropSourceUrl: "a.png",
      mask: base,
      offset: { x: 30, y: 10 },
      maskOffset: { x: 0, y: 0 },
    });
    expect(resolved?.selection).toEqual({ x: 10, y: 30, width: 60, height: 60 });
  });

  it("turns a disabled mask into one that hides nothing", () => {
    const resolved = descriptorMaskDrawing({
      layerId: "a",
      crop,
      generatedCropSourceUrl: "a.png",
      mask: base,
      maskEnabled: false,
    });
    expect(resolved).toMatchObject({ inverted: true, softness: 0, strokes: [], selection: undefined });
  });

  it("has nothing to resolve for a frozen layer that only has a mask asset", () => {
    expect(
      descriptorMaskDrawing({ layerId: "a", crop, generatedCropSourceUrl: "a.png", maskSourceUrl: "mask.png" }),
    ).toBeUndefined();
  });
});

describe("visibleEditLayers placement", () => {
  function placedLayer(id: string, order: number, overrides: Partial<StillImageEditLayer>): StillImageEditLayer {
    return {
      id,
      name: id,
      mask: base,
      crop,
      prompt: "",
      mode: "inpaint",
      references: [],
      documentId: "editdoc_test",
      jobId: `job_${id}`,
      createdAt: "2026-08-27T09:00:00.000Z",
      updatedAt: "2026-08-27T09:00:00.000Z",
      visible: true,
      order,
      revision: 1,
      status: "completed",
      generatedCropSourceUrl: `/api/media?path=${id}.png`,
      ...overrides,
    };
  }

  it("carries opacity, the move and the mask switch onto every descriptor", () => {
    const layers = [
      placedLayer("edit_a", 0, { opacity: 45, offset: { x: 8, y: -3 }, maskEnabled: false }),
      placedLayer("edit_b", 1, { maskLinked: false, offset: { x: 5, y: 5 } }),
    ];
    const [first, second] = visibleEditLayers({
      images: [],
      prompt: "",
      seed: "",
      settings: {},
      editLayers: layers,
    } as StillImageCategoryState);

    expect(first).toMatchObject({ opacity: 45, offset: { x: 8, y: -3 }, maskOffset: { x: 8, y: -3 }, maskEnabled: false });
    // An unchained mask stays where it was painted while the content moves.
    expect(second).toMatchObject({ opacity: 100, offset: { x: 5, y: 5 }, maskOffset: { x: 0, y: 0 }, maskEnabled: true });
  });
});

describe("a transformed mask through the crop", () => {
  const transformed = setMaskTransform(
    setMaskRectangleSelection(createMaskDrawing(400, 300), { x: 40, y: 40, width: 60, height: 60 }),
    scaleTransform({ x: 100, y: 100 }, 2, 2),
  );
  const cropped = { x: 20, y: 20, size: 100, width: 100, height: 100, sourceWidth: 400, sourceHeight: 300 };

  it("re-expresses the transform in the crop's coordinates so the mask lands in the same place", () => {
    const local = drawingForCrop(transformed, cropped);
    const point = { x: 40, y: 40 };
    const inOriginal = transformPoint(maskTransform(transformed), point);
    const inCrop = transformPoint(maskTransform(local), { x: point.x - cropped.x, y: point.y - cropped.y });
    expect(inCrop).toEqual({ x: inOriginal.x - cropped.x, y: inOriginal.y - cropped.y });
  });

  it("moves the fallback crop bound onto wherever the mask was turned to", () => {
    const bar = setMaskRectangleSelection(createMaskDrawing(1000, 1000), { x: 400, y: 480, width: 200, height: 40 });
    const turned = setMaskTransform(bar, rotationTransform({ x: 500, y: 500 }, Math.PI / 4));
    const crop = squareEditCrop(turned, 0);

    // The fallback bound has no raster to sample, so what it owes the caller is
    // simply that everything the artist painted is still inside the crop.
    for (const corner of [
      { x: 400, y: 480 },
      { x: 600, y: 480 },
      { x: 600, y: 520 },
      { x: 400, y: 520 },
    ]) {
      const landed = transformPoint(maskTransform(turned), corner);
      expect(landed.x).toBeGreaterThanOrEqual(crop.x - 1);
      expect(landed.x).toBeLessThanOrEqual(crop.x + (crop.width ?? crop.size) + 1);
      expect(landed.y).toBeGreaterThanOrEqual(crop.y - 1);
      expect(landed.y).toBeLessThanOrEqual(crop.y + (crop.height ?? crop.size) + 1);
    }
    // A 200x40 bar laid at 45 degrees is a different shape from a flat one, so it
    // must not be handed the flat one's crop.
    expect(crop).not.toEqual(squareEditCrop(bar, 0));
  });
});
