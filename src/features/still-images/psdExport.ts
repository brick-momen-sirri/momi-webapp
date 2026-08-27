import type { Layer, Psd } from "ag-psd";

import { resolveMediaUrl } from "../../services/api/mediaAccess";
import {
  drawingForCrop,
  editCropHeight,
  editCropWidth,
  layerMaskEnabled,
  layerMaskLinked,
  layerOffset,
  layerOpacity,
} from "./imageEditLayers";
import { loadImageElement, maskImageToAlphaCanvas, renderMaskCanvas } from "./maskRaster";
import type { StillImageEditLayer } from "./stillImageCategories";

export type PreparedPsdLayer = {
  layer: StillImageEditLayer;
  pixels: HTMLCanvasElement;
  mask: HTMLCanvasElement;
};

export type LayeredPsdExportInput = {
  source: CanvasImageSource;
  width: number;
  height: number;
  imageName: string;
  layers: StillImageEditLayer[];
};

/**
 * Export the non-destructive editor stack without sending the document anywhere.
 *
 * Photoshop layers are top-to-bottom, while the editor stores them bottom-to-top.
 * Each generated crop stays small and positioned at its original source coordinates;
 * its editable bitmap mask is attached rather than baked into the layer pixels.
 */
export async function exportLayeredPsd(input: LayeredPsdExportInput) {
  const width = positiveDimension(input.width, "width");
  const height = positiveDimension(input.height, "height");
  const exportable = input.layers.filter((layer) => Boolean(layer.generatedCropUrl ?? layer.generatedCropSourceUrl));
  if (!exportable.length) throw new Error("Generate at least one edit layer before exporting a PSD.");

  const original = imageCanvas(input.source, width, height);
  const prepared = await Promise.all(exportable.map(prepareLayer));
  const composite = compositeCanvas(original, prepared);
  const psd = buildLayeredPsdDocument({ width, height, original, composite, layers: prepared });
  const { writePsd } = await import("ag-psd");
  const bytes = writePsd(psd, { generateThumbnail: true, noBackground: true });
  downloadPsd(bytes, layeredPsdFileName(input.imageName));
}

/** Separated from image decoding so layer ordering and mask placement stay unit-testable. */
export function buildLayeredPsdDocument(input: {
  width: number;
  height: number;
  original: HTMLCanvasElement;
  composite: HTMLCanvasElement;
  layers: PreparedPsdLayer[];
}): Psd {
  const editLayers: Layer[] = [...input.layers]
    .sort((a, b) => b.layer.order - a.layer.order)
    .map(({ layer, pixels, mask }) => {
      const width = editCropWidth(layer.crop);
      const height = editCropHeight(layer.crop);
      // Photoshop has all three of these natively, so none of them is baked into
      // the exported pixels: a moved layer is a moved layer, a faded one carries
      // its opacity, and a switched-off mask arrives switched off rather than
      // deleted. The mask keeps its own absolute position, which is what makes an
      // unchained mask survive the round trip.
      const offset = layerOffset(layer);
      const maskOffset = layerMaskLinked(layer) ? offset : { x: 0, y: 0 };
      return {
        name: layer.name,
        canvas: pixels,
        top: layer.crop.y + offset.y,
        left: layer.crop.x + offset.x,
        bottom: layer.crop.y + offset.y + height,
        right: layer.crop.x + offset.x + width,
        hidden: !layer.visible,
        opacity: layerOpacity(layer) / 100,
        blendMode: "normal",
        mask: {
          canvas: mask,
          top: layer.crop.y + maskOffset.y,
          left: layer.crop.x + maskOffset.x,
          bottom: layer.crop.y + maskOffset.y + height,
          right: layer.crop.x + maskOffset.x + width,
          defaultColor: 0,
          disabled: !layerMaskEnabled(layer),
          positionRelativeToLayer: false,
          fromVectorData: false,
        },
      };
    });

  return {
    width: input.width,
    height: input.height,
    canvas: input.composite,
    children: [
      ...editLayers,
      {
        name: "Original image",
        canvas: input.original,
        top: 0,
        left: 0,
        bottom: input.height,
        right: input.width,
        blendMode: "normal",
      },
    ],
  };
}

export function layeredPsdFileName(imageName: string) {
  const stem = imageName
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .trim();
  return `${stem || "edited-composite"}-layers.psd`;
}

async function prepareLayer(layer: StillImageEditLayer): Promise<PreparedPsdLayer> {
  const cropWidth = editCropWidth(layer.crop);
  const cropHeight = editCropHeight(layer.crop);
  const resultUrl = layer.generatedCropUrl ?? resolveMediaUrl(layer.generatedCropSourceUrl as string);
  const generated = await loadImageElement(resultUrl);
  const pixels = imageCanvas(generated, cropWidth, cropHeight);

  let mask: HTMLCanvasElement;
  if (layer.mask) {
    mask = renderMaskCanvas(drawingForCrop(layer.mask, layer.crop));
  } else if (layer.maskSourceUrl) {
    mask = imageCanvas(await loadImageElement(resolveMediaUrl(layer.maskSourceUrl)), cropWidth, cropHeight, "#000000");
  } else {
    throw new Error(`${layer.name} is missing its edit mask.`);
  }
  return { layer, pixels, mask };
}

function compositeCanvas(original: HTMLCanvasElement, layers: PreparedPsdLayer[]) {
  const composite = imageCanvas(original, original.width, original.height);
  const context = requiredContext(composite);

  for (const { layer, pixels, mask } of [...layers].sort((a, b) => a.layer.order - b.layer.order)) {
    if (!layer.visible) continue;
    const opacity = layerOpacity(layer) / 100;
    if (opacity <= 0) continue;
    const offset = layerOffset(layer);
    const maskOffset = layerMaskLinked(layer) ? offset : { x: 0, y: 0 };
    const isolated = imageCanvas(pixels, pixels.width, pixels.height);
    const isolatedContext = requiredContext(isolated);
    if (layerMaskEnabled(layer)) {
      isolatedContext.globalCompositeOperation = "destination-in";
      isolatedContext.drawImage(
        maskImageToAlphaCanvas(mask, isolated.width, isolated.height),
        maskOffset.x - offset.x,
        maskOffset.y - offset.y,
      );
      isolatedContext.globalCompositeOperation = "source-over";
    }
    context.globalAlpha = opacity;
    context.drawImage(isolated, layer.crop.x + offset.x, layer.crop.y + offset.y);
    context.globalAlpha = 1;
  }
  return composite;
}

function imageCanvas(source: CanvasImageSource, width: number, height: number, background?: string) {
  const canvas = document.createElement("canvas");
  canvas.width = positiveDimension(width, "canvas width");
  canvas.height = positiveDimension(height, "canvas height");
  const context = requiredContext(canvas);
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function requiredContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the layered Photoshop document.");
  return context;
}

function positiveDimension(value: number, label: string) {
  const normalized = Math.round(value);
  if (!Number.isFinite(normalized) || normalized < 1) throw new Error(`The PSD ${label} is invalid.`);
  return normalized;
}

function downloadPsd(bytes: ArrayBuffer, fileName: string) {
  const blob = new Blob([bytes], { type: "image/vnd.adobe.photoshop" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
