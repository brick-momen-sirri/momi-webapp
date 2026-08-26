import { describe, expect, it } from "vitest";

import { drawingForCrop, editGenerationBaseLayers, squareEditCrop, visibleEditLayers } from "./imageEditLayers";
import type { MaskDrawing } from "./maskDrawing";
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
