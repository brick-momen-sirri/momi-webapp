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
 * Preserve the returned square as the editable layer payload, then rebuild the
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
  const overlays = await Promise.all(layers.map(maskedOverlay));
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

async function maskedOverlay(layer: StillImageEditBaseLayer) {
  const imagePath = await allowedMediaPath(layer.generatedCropUrl, `generated crop for ${layer.layerId}`);
  const maskPath = await allowedMediaPath(layer.maskSourceUrl, `mask for ${layer.layerId}`);
  const input = await cropWithMask(imagePath, maskPath, layer.crop);
  return { input, left: layer.crop.x, top: layer.crop.y, blend: "over" as const };
}

async function cropWithMask(imagePath: string, maskPath: string, crop: StillImageEditCrop) {
  const mask = await sharp(maskPath, { limitInputPixels: false })
    .resize(crop.size, crop.size, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  return sharp(imagePath, { limitInputPixels: false })
    .rotate()
    .resize(crop.size, crop.size, { fit: "fill" })
    .removeAlpha()
    .joinChannel(mask, { raw: { width: crop.size, height: crop.size, channels: 1 } })
    .png()
    .toBuffer();
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
