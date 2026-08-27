import { describe, expect, it } from "vitest";

import type { StillImageEditLayer } from "./stillImageCategories";
import { buildLayeredPsdDocument, layeredPsdFileName, type PreparedPsdLayer } from "./psdExport";

function canvas(width: number, height: number) {
  const value = document.createElement("canvas");
  value.width = width;
  value.height = height;
  return value;
}

function preparedLayer(id: string, order: number, visible = true): PreparedPsdLayer {
  const crop = { x: order * 10, y: order * 20, size: 80, width: 80, height: 45, sourceWidth: 400, sourceHeight: 300 };
  const layer: StillImageEditLayer = {
    id,
    name: `Layer ${id}`,
    mask: {
      width: 400,
      height: 300,
      softness: 0,
      selection: { x: crop.x, y: crop.y, width: 80, height: 45 },
      strokes: [],
    },
    crop,
    prompt: id,
    mode: "inpaint",
    references: [],
    documentId: "editdoc_test",
    jobId: `job_${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    visible,
    order,
    revision: 1,
    status: "completed",
    generatedCropSourceUrl: `/api/media?path=${id}.png`,
  };
  return { layer, pixels: canvas(80, 45), mask: canvas(80, 45) };
}

describe("layered PSD structure", () => {
  it("keeps generated edits top-to-bottom, positions their masks, and retains the original", () => {
    const lower = preparedLayer("lower", 0);
    const upper = preparedLayer("upper", 1, false);
    const original = canvas(400, 300);
    const composite = canvas(400, 300);
    const psd = buildLayeredPsdDocument({ width: 400, height: 300, original, composite, layers: [lower, upper] });

    expect(psd.canvas).toBe(composite);
    expect(psd.children?.map((layer) => layer.name)).toEqual(["Layer upper", "Layer lower", "Original image"]);
    expect(psd.children?.[0]).toMatchObject({ top: 20, left: 10, bottom: 65, right: 90, hidden: true });
    expect(psd.children?.[0].mask).toMatchObject({ top: 20, left: 10, bottom: 65, right: 90, defaultColor: 0 });
    expect(psd.children?.[0].mask?.canvas).toBe(upper.mask);
    expect(psd.children?.[2].canvas).toBe(original);
  });

  it("carries opacity, a move and a switched-off mask into Photoshop's own fields", () => {
    const moved = preparedLayer("moved", 0);
    moved.layer.opacity = 40;
    moved.layer.offset = { x: 25, y: -10 };
    moved.layer.maskEnabled = false;
    const psd = buildLayeredPsdDocument({
      width: 400,
      height: 300,
      original: canvas(400, 300),
      composite: canvas(400, 300),
      layers: [moved],
    });

    // Photoshop stores opacity 0-1, and the crop is 80x45 at 0,0 before the move.
    expect(psd.children?.[0]).toMatchObject({ opacity: 0.4, top: -10, left: 25, bottom: 35, right: 105 });
    // A chained mask travels with its layer, and "off" is a flag rather than a
    // deleted mask, so the artist still has it when they reopen the file.
    expect(psd.children?.[0].mask).toMatchObject({ top: -10, left: 25, disabled: true });
    expect(psd.children?.[0].mask?.canvas).toBe(moved.mask);
  });

  it("leaves an unchained mask where it was painted while the layer moves", () => {
    const unchained = preparedLayer("unchained", 0);
    unchained.layer.offset = { x: 30, y: 0 };
    unchained.layer.maskLinked = false;
    const psd = buildLayeredPsdDocument({
      width: 400,
      height: 300,
      original: canvas(400, 300),
      composite: canvas(400, 300),
      layers: [unchained],
    });

    expect(psd.children?.[0]).toMatchObject({ left: 30, opacity: 1 });
    expect(psd.children?.[0].mask).toMatchObject({ left: 0, disabled: false });
  });

  it("creates a safe, recognizable Photoshop filename", () => {
    expect(layeredPsdFileName("Client:Lobby?.png")).toBe("Client-Lobby--layers.psd");
    expect(layeredPsdFileName(".png")).toBe("edited-composite-layers.psd");
  });
});
