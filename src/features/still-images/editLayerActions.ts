// What the Layers panel does to the stack, as arithmetic on plain data.
//
// Photoshop's layer controls are almost all non-destructive bookkeeping: opacity,
// visibility, order, a name, whether the mask is switched on and whether it is
// chained to the pixels. None of that needs a canvas, a decoded image or a job,
// so none of it lives in the panel that draws the buttons -- it lives here, where
// the rules can be read in one place and tested without a DOM.
//
// The one deliberate asymmetry is the mask. A layer's mask geometry is edited
// through the editor's live drawing, which the form mirrors onto the selected
// layer; the actions here only touch a mask when the operation is about the mask
// as a whole -- moving it, switching it off, unchaining it from the content.

import { layerMaskFeather, layerMaskLinked, layerOffset, layerOpacity } from "./imageEditLayers";
import { translateMaskDrawing, type MaskPoint } from "./maskDrawing";
import type { StillImageEditLayer, StillImageEditTarget } from "./stillImageCategories";

export type EditLayerList = StillImageEditLayer[];

/** Apply one change to a single layer, leaving every other layer identical. */
function withLayer(layers: EditLayerList, layerId: string, change: (layer: StillImageEditLayer) => StillImageEditLayer) {
  let changed = false;
  const next = layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    const updated = change(layer);
    if (updated === layer) return layer;
    changed = true;
    return { ...updated, updatedAt: new Date().toISOString() };
  });
  return changed ? next : layers;
}

export function setEditLayerOpacity(layers: EditLayerList, layerId: string, opacity: number): EditLayerList {
  const clamped = Math.min(100, Math.max(0, Math.round(opacity)));
  return withLayer(layers, layerId, (layer) => (layerOpacity(layer) === clamped ? layer : { ...layer, opacity: clamped }));
}

export function setEditLayerMaskFeather(layers: EditLayerList, layerId: string, feather: number): EditLayerList {
  const clamped = layerMaskFeather({ maskFeather: feather });
  return withLayer(layers, layerId, (layer) =>
    layerMaskFeather(layer) === clamped ? layer : { ...layer, maskFeather: clamped, revision: (layer.revision ?? 0) + 1 },
  );
}

export function setEditLayerVisibility(layers: EditLayerList, layerId: string, visible: boolean): EditLayerList {
  return withLayer(layers, layerId, (layer) => (layer.visible === visible ? layer : { ...layer, visible }));
}

/**
 * Rename a layer, keeping the name meaningful.
 *
 * An empty name is refused rather than accepted, because a nameless row in the
 * panel is not a layer anybody can find again. Trimming happens here so the
 * inline field can stay a plain input.
 */
export function renameEditLayer(layers: EditLayerList, layerId: string, name: string): EditLayerList {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return layers;
  return withLayer(layers, layerId, (layer) => (layer.name === trimmed ? layer : { ...layer, name: trimmed }));
}

export function setEditLayerMaskEnabled(layers: EditLayerList, layerId: string, enabled: boolean): EditLayerList {
  return withLayer(layers, layerId, (layer) => ({ ...layer, maskEnabled: enabled }));
}

export function setEditLayerMaskLinked(layers: EditLayerList, layerId: string, linked: boolean): EditLayerList {
  return withLayer(layers, layerId, (layer) => ({ ...layer, maskLinked: linked }));
}

/**
 * Move a layer's content or its mask, in original-image pixels.
 *
 * A chained mask makes the two indistinguishable: dragging either moves the
 * whole layer, which is what the chain means. Only an unchained mask can be
 * displaced on its own, and that displacement is written into the mask geometry
 * rather than kept beside it, so everything downstream that reads a mask sees
 * where it actually is.
 */
export function moveEditLayerBy(
  layers: EditLayerList,
  layerId: string,
  target: StillImageEditTarget,
  delta: MaskPoint,
): EditLayerList {
  if (!delta.x && !delta.y) return layers;
  return withLayer(layers, layerId, (layer) => {
    const bumped = { ...layer, revision: (layer.revision ?? 0) + 1 };
    if (target === "mask" && !layerMaskLinked(layer)) {
      return { ...bumped, mask: translateMaskDrawing(layer.mask, delta.x, delta.y) };
    }
    const offset = layerOffset(layer);
    return { ...bumped, offset: { x: offset.x + delta.x, y: offset.y + delta.y } };
  });
}

/** Put a moved layer or mask back where it was generated. */
export function resetEditLayerOffset(layers: EditLayerList, layerId: string): EditLayerList {
  return withLayer(layers, layerId, (layer) =>
    layerOffset(layer).x === 0 && layerOffset(layer).y === 0
      ? layer
      : { ...layer, offset: { x: 0, y: 0 }, revision: (layer.revision ?? 0) + 1 },
  );
}

/** Write an edited mask back onto one layer, invalidating its cached composite. */
export function setEditLayerMask(layers: EditLayerList, layerId: string, mask: StillImageEditLayer["mask"]): EditLayerList {
  return withLayer(layers, layerId, (layer) =>
    layer.mask === mask ? layer : { ...layer, mask, revision: (layer.revision ?? 0) + 1 },
  );
}

/**
 * Copy a layer, directly above the one it came from.
 *
 * The duplicate shares the generated crop rather than re-running the model: the
 * pixels already exist, and the point of duplicating is to mask, move or fade the
 * same take a second way. It keeps no link to the original's job, so refreshing
 * layer state from the job store leaves it exactly as it was copied.
 */
export function duplicateEditLayer(layers: EditLayerList, layerId: string, newLayerId: string) {
  const ordered = [...layers].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((layer) => layer.id === layerId);
  if (index < 0) return { layers, layerId: undefined as string | undefined };

  const source = ordered[index];
  const now = new Date().toISOString();
  const copy: StillImageEditLayer = {
    ...source,
    id: newLayerId,
    name: duplicateName(source.name, layers),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    references: source.references.map((reference, position) => ({
      ...reference,
      id: `${newLayerId}_ref_${position + 1}`,
    })),
  };

  ordered.splice(index + 1, 0, copy);
  return { layers: ordered.map((layer, order) => ({ ...layer, order })), layerId: newLayerId };
}

/** Move one layer up or down the stack, renumbering the whole list. */
export function reorderEditLayer(layers: EditLayerList, layerId: string, direction: -1 | 1): EditLayerList {
  const ordered = [...layers].sort((a, b) => a.order - b.order);
  const from = ordered.findIndex((layer) => layer.id === layerId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ordered.length) return layers;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  return ordered.map((layer, order) => ({ ...layer, order }));
}

/** "Edit Layer 03" then "Edit Layer 03 copy", then "Edit Layer 03 copy 2". */
function duplicateName(name: string, layers: EditLayerList) {
  const taken = new Set(layers.map((layer) => layer.name));
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}
