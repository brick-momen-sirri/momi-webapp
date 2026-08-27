import { describe, expect, it } from "vitest";

import {
  duplicateEditLayer,
  moveEditLayerBy,
  renameEditLayer,
  reorderEditLayer,
  resetEditLayerOffset,
  setEditLayerMaskEnabled,
  setEditLayerMaskLinked,
  setEditLayerOpacity,
} from "./editLayerActions";
import { createMaskDrawing, setMaskRectangleSelection } from "./maskDrawing";
import type { StillImageEditLayer } from "./stillImageCategories";

function layer(id: string, order: number, overrides: Partial<StillImageEditLayer> = {}): StillImageEditLayer {
  return {
    id,
    name: `Edit Layer 0${order + 1}`,
    mask: setMaskRectangleSelection(createMaskDrawing(400, 300), { x: 10, y: 20, width: 40, height: 30 }),
    crop: { x: 0, y: 0, size: 80, width: 80, height: 80, sourceWidth: 400, sourceHeight: 300 },
    prompt: id,
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

describe("layer properties", () => {
  it("clamps opacity into 0-100 and leaves the rest of the stack untouched", () => {
    const layers = [layer("a", 0), layer("b", 1, { opacity: 40 })];
    const next = setEditLayerOpacity(layers, "b", 137);

    expect(next[1].opacity).toBe(100);
    expect(next[0]).toBe(layers[0]);
    expect(setEditLayerOpacity(layers, "b", -5)[1].opacity).toBe(0);
    expect(setEditLayerOpacity(layers, "b", 62.4)[1].opacity).toBe(62);
  });

  it("returns the same array when a change is a no-op", () => {
    const layers = [layer("a", 0, { opacity: 40 })];
    expect(setEditLayerOpacity(layers, "a", 40)).toBe(layers);
    expect(setEditLayerOpacity(layers, "missing", 10)).toBe(layers);
  });

  it("refuses an empty rename rather than leaving a nameless row", () => {
    const layers = [layer("a", 0)];
    expect(renameEditLayer(layers, "a", "   ")).toBe(layers);
    expect(renameEditLayer(layers, "a", "  Sky replacement  ")[0].name).toBe("Sky replacement");
  });

  it("keeps the mask when it is switched off", () => {
    const layers = [layer("a", 0)];
    const off = setEditLayerMaskEnabled(layers, "a", false);
    expect(off[0].maskEnabled).toBe(false);
    expect(off[0].mask).toBe(layers[0].mask);
    expect(setEditLayerMaskLinked(off, "a", false)[0].maskLinked).toBe(false);
  });
});

describe("moving a layer", () => {
  it("moves the pixels and lets a chained mask ride along", () => {
    const layers = [layer("a", 0)];
    const moved = moveEditLayerBy(layers, "a", "content", { x: 12, y: -4 });

    expect(moved[0].offset).toEqual({ x: 12, y: -4 });
    // Nothing is written into the mask: chained means the composite draws both at
    // the layer's offset, so rewriting the geometry would move it twice.
    expect(moved[0].mask).toBe(layers[0].mask);
    expect(moved[0].revision).toBe(2);
  });

  it("treats a drag on a chained mask as a drag on the whole layer", () => {
    const moved = moveEditLayerBy([layer("a", 0)], "a", "mask", { x: 5, y: 5 });
    expect(moved[0].offset).toEqual({ x: 5, y: 5 });
    expect(moved[0].mask.selection).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  });

  it("displaces only the mask geometry once the chain is broken", () => {
    const layers = [layer("a", 0, { maskLinked: false })];
    const moved = moveEditLayerBy(layers, "a", "mask", { x: 7, y: 3 });

    expect(moved[0].offset).toBeUndefined();
    expect(moved[0].mask.selection).toEqual({ x: 17, y: 23, width: 40, height: 30 });
  });

  it("accumulates repeated nudges and can be put back", () => {
    let layers = [layer("a", 0)];
    layers = moveEditLayerBy(layers, "a", "content", { x: 1, y: 0 });
    layers = moveEditLayerBy(layers, "a", "content", { x: 1, y: 2 });
    expect(layers[0].offset).toEqual({ x: 2, y: 2 });

    expect(resetEditLayerOffset(layers, "a")[0].offset).toEqual({ x: 0, y: 0 });
    expect(moveEditLayerBy(layers, "a", "content", { x: 0, y: 0 })).toBe(layers);
  });
});

describe("duplicating and reordering", () => {
  it("puts the copy directly above its source and renumbers the stack", () => {
    const layers = [layer("a", 0), layer("b", 1)];
    const { layers: next, layerId } = duplicateEditLayer(layers, "a", "edit_copy");

    expect(layerId).toBe("edit_copy");
    expect(next.map((entry) => entry.id)).toEqual(["a", "edit_copy", "b"]);
    expect(next.map((entry) => entry.order)).toEqual([0, 1, 2]);
    expect(next[1].name).toBe("Edit Layer 01 copy");
    // The copy shares the generated take rather than needing the model again.
    expect(next[1].generatedCropSourceUrl).toBe(layers[0].generatedCropSourceUrl);
    expect(next[1].revision).toBe(0);
  });

  it("does not collide with a copy that already exists", () => {
    const layers = [layer("a", 0), layer("b", 1, { name: "Edit Layer 01 copy" })];
    expect(duplicateEditLayer(layers, "a", "edit_copy").layers[1].name).toBe("Edit Layer 01 copy 2");
  });

  it("leaves the stack alone when the layer is gone", () => {
    const layers = [layer("a", 0)];
    const result = duplicateEditLayer(layers, "missing", "edit_copy");
    expect(result.layerId).toBeUndefined();
    expect(result.layers).toBe(layers);
  });

  it("swaps neighbours and refuses to move past either end", () => {
    const layers = [layer("a", 0), layer("b", 1)];
    expect(reorderEditLayer(layers, "a", 1).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(reorderEditLayer(layers, "a", -1)).toBe(layers);
    expect(reorderEditLayer(layers, "b", 1)).toBe(layers);
  });
});
