import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { resolveAllowedExistingMediaPath } from "./mediaPathPolicy.js";
import type { StillImageEditBaseLayer, StillImageEditCrop } from "./stillImageCategories.js";
import type { Job } from "./types.js";
import { localMediaFilePathFromUrl } from "./jobQueue/providerInputs.js";

export type StillImageEditCompositeResult = { generatedCropUrl: string; generatedCropPath: string };
export type StillImageEditCompositeMetadata = { width: number; height: number };

/**
 * Preserve the returned crop as the editable layer payload, then rebuild the
 * full-resolution visible composite from the original plus ordered crop layers.
 * The target file is replaced atomically only after the complete PNG is ready.
 */
export async function compositeStillImageEditResult(
  job: Job,
  targetFilePath: string,
): Promise<StillImageEditCompositeResult | undefined> {
  const edit = job.workflowOptions?.stillImage?.edit;
  if (!edit) return undefined;

  const generatedCropPath = layerCropPath(targetFilePath);
  await fs.copyFile(targetFilePath, generatedCropPath);

  try {
    await renderStillImageEditComposite(
      edit.originalSourceUrl,
      [
        ...edit.baseLayers,
        {
          layerId: edit.layerId,
          crop: edit.crop,
          generatedCropUrl: mediaUrl(generatedCropPath),
          maskSourceUrl: edit.maskSourceUrl,
        },
      ],
      targetFilePath,
    );
  } catch (error) {
    await fs.rm(generatedCropPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const generatedCropUrl = mediaUrl(generatedCropPath);
  edit.generatedCropUrl = generatedCropUrl;
  return { generatedCropUrl, generatedCropPath };
}

/** Build the final, full-resolution composite from the original and visible layers. */
export async function renderStillImageEditComposite(
  originalSourceUrl: string,
  layers: StillImageEditBaseLayer[],
  targetFilePath: string,
): Promise<StillImageEditCompositeMetadata> {
  const originalPath = await allowedMediaPath(originalSourceUrl, "original image");
  // The canvas is taken from the crops rather than from the file's own metadata:
  // every crop is validated against the same source dimensions, and those are the
  // dimensions the editor composited against. Reading them back off disk would
  // have to account for EXIF rotation to agree with it.
  const canvas = {
    width: layers[0]?.crop.sourceWidth ?? 0,
    height: layers[0]?.crop.sourceHeight ?? 0,
  };
  const prepared = await Promise.all(layers.map((layer) => maskedOverlay(layer, canvas)));
  // A layer dragged entirely off the canvas contributes nothing and cannot be
  // handed to sharp, which requires every overlay to land inside the base.
  const overlays = prepared.filter((overlay) => overlay !== undefined);
  const temporaryPath = `${targetFilePath}.composite-${process.pid}-${Date.now()}.tmp`;
  try {
    await sharp(originalPath, { limitInputPixels: false }).rotate().composite(overlays).png().toFile(temporaryPath);
    await fs.rename(temporaryPath, targetFilePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const metadata = await sharp(targetFilePath, { limitInputPixels: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("The final composite has no readable dimensions.");
  return { width: metadata.width, height: metadata.height };
}

/**
 * One layer, masked, faded and positioned, ready for sharp's composite list.
 *
 * Opacity is folded into the mask rather than applied as a separate pass: the
 * mask is already the layer's alpha channel, so scaling it is one multiply
 * instead of a second full-size composite. Undefined means the layer cannot
 * contribute -- fully transparent, or dragged off the canvas entirely.
 */
async function maskedOverlay(layer: StillImageEditBaseLayer, canvas: { width: number; height: number }) {
  const opacity = Math.min(1, Math.max(0, (layer.opacity ?? 100) / 100));
  if (opacity <= 0) return undefined;

  const width = cropWidth(layer.crop);
  const height = cropHeight(layer.crop);
  const offset = layer.offset ?? { x: 0, y: 0 };
  const left = Math.round(layer.crop.x + offset.x);
  const top = Math.round(layer.crop.y + offset.y);
  const visibleLeft = Math.max(0, left);
  const visibleTop = Math.max(0, top);
  const visibleRight = Math.min(canvas.width || left + width, left + width);
  const visibleBottom = Math.min(canvas.height || top + height, top + height);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return undefined;

  const imagePath = await allowedMediaPath(layer.generatedCropUrl, `generated crop for ${layer.layerId}`);
  const maskPath = await allowedMediaPath(layer.maskSourceUrl, `mask for ${layer.layerId}`);
  const input = await cropWithMask(imagePath, maskPath, layer.crop, opacity);
  if (visibleLeft === left && visibleTop === top && visibleRight === left + width && visibleBottom === top + height) {
    return { input, left, top, blend: "over" as const };
  }

  const clipped = await sharp(input, { limitInputPixels: false })
    .extract({
      left: visibleLeft - left,
      top: visibleTop - top,
      width: visibleRight - visibleLeft,
      height: visibleBottom - visibleTop,
    })
    .png()
    .toBuffer();
  return { input: clipped, left: visibleLeft, top: visibleTop, blend: "over" as const };
}

async function cropWithMask(imagePath: string, maskPath: string, crop: StillImageEditCrop, opacity: number) {
  const width = cropWidth(crop);
  const height = cropHeight(crop);
  const alpha = await sharp(maskPath, { limitInputPixels: false })
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  // Scaled here rather than with sharp's linear(): this buffer is already the
  // layer's alpha channel, so one multiply over it is both the cheapest way to
  // apply opacity and the one whose result does not depend on where linear()
  // lands in sharp's fixed pipeline order.
  if (opacity < 1) {
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = Math.round(alpha[index] * opacity);
  }

  // Two passes, and they cannot be one.
  //
  // sharp runs a fixed pipeline regardless of call order, and removeAlpha runs
  // after joinChannel in it -- so stripping the crop's own alpha and attaching
  // the mask in a single chain strips the mask that was just attached and pastes
  // the layer as an opaque rectangle. The strip has to be finished, as bytes,
  // before the mask is joined. Stripping first is still required: a crop that
  // already carries alpha would otherwise become a five-channel image.
  const opaqueCrop = await sharp(imagePath, { limitInputPixels: false })
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .png()
    .toBuffer();
  return sharp(opaqueCrop, { limitInputPixels: false })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

function cropWidth(crop: StillImageEditCrop) {
  return Math.max(1, Math.round(crop.width ?? crop.size));
}

function cropHeight(crop: StillImageEditCrop) {
  return Math.max(1, Math.round(crop.height ?? crop.size));
}

async function allowedMediaPath(url: string, label: string) {
  const filePath = localMediaFilePathFromUrl(url);
  if (!filePath) throw new Error(`The ${label} is not saved project media.`);
  const allowed = await resolveAllowedExistingMediaPath(filePath);
  if (!allowed) throw new Error(`The ${label} is missing or outside allowed media roots.`);
  return allowed;
}

function layerCropPath(targetFilePath: string) {
  const extension = path.extname(targetFilePath) || ".png";
  return targetFilePath.slice(0, targetFilePath.length - extension.length) + `.edit-layer${extension}`;
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}
