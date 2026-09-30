// The media half of LTX 2.5 CQ Image to Video: the input image normalized to PNG
// before it is sent, and the 1080p render cropped to 1080 after it lands.

import fs from "node:fs/promises";

import sharp, { type Metadata } from "sharp";

import { ffmpegErrorMessage, ffprobeJson, partPath, positiveInteger, runFfmpeg } from "./ffmpegTools.js";
import { renameWithRetry, rmWithRetry, writeFileWithRetry } from "./fsRetry.js";
import { isLtxCqI2vModelId, ltxCqI2vPreset } from "./ltxCqImageToVideo.js";
import type { Job } from "./types.js";

/**
 * The tested normalizer's decoded-pixel ceiling. A larger source is scaled down to
 * it rather than refused: the graph resizes the image to at most 2560x1440 anyway,
 * and studio renders past 40 MP are ordinary.
 */
const MAX_DECODED_PIXELS = 40_000_000;

/**
 * Decode the source and write it back as an 8-bit sRGB PNG, upright.
 *
 * Decoding is the validation: a file that is not an image fails here, before
 * anything is uploaded or a GPU is paid for, whatever its extension says. EXIF
 * orientation is applied because LoadImage does not, and transparency is laid on
 * white because LoadImage drops alpha to whatever colour sits underneath.
 *
 * Read into memory first: these files live on the SMB share, where sharp reading
 * by path issues thousands of 4 KB reads for one large PNG.
 */
export async function prepareLtxCqI2vImage(sourcePath: string, outputPath: string) {
  let input: Buffer;
  try {
    input = await fs.readFile(sourcePath);
  } catch {
    throw new Error("The input image could not be read.");
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input, { failOn: "error" }).metadata();
  } catch {
    throw new Error("The input image could not be decoded. Use a PNG, JPEG or WebP image.");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("The input image has no readable dimensions.");

  let image = sharp(input, { failOn: "error", limitInputPixels: false }).rotate();
  if (width * height > MAX_DECODED_PIXELS) {
    const scale = Math.sqrt(MAX_DECODED_PIXELS / (width * height));
    image = image.resize({
      width: Math.floor(width * scale),
      height: Math.floor(height * scale),
      fit: "inside",
      kernel: "lanczos3",
    });
  }
  if (metadata.hasAlpha) image = image.flatten({ background: "#ffffff" });

  const png = await image.toColourspace("srgb").png({ compressionLevel: 6 }).toBuffer();
  await writeFileWithRetry(outputPath, png);
  return outputPath;
}

/**
 * Crop a 1080p render from the model's 1920x1088 to 1920x1080.
 *
 * Four rows come off the top and bottom, as the handoff specifies: the frames are
 * generated at 1088, not resized to it, so this is a crop of real pixels. Cropping
 * means one re-encode, kept visually lossless; the audio track is copied as is.
 *
 * A no-op for every other job and for a render that is already the delivered
 * size. Returns false and leaves the file as it was on any failure: a 1088 file
 * is a better thing to hand back than no file.
 */
export async function finishLtxCqI2vResult(job: Pick<Job, "id" | "modelId" | "resolution">, filePath: string) {
  if (!isLtxCqI2vModelId(job.modelId)) return false;
  const preset = ltxCqI2vPreset(job.resolution);
  if (!preset || (preset.generationWidth === preset.width && preset.generationHeight === preset.height)) return false;

  const temporaryPath = partPath(filePath);
  try {
    const rendered = (await ffprobeJson(["-select_streams", "v:0", "-show_streams", filePath])).streams?.[0];
    if (rendered?.width !== preset.generationWidth || rendered.height !== preset.generationHeight) return false;
    const renderedFrames = positiveInteger(rendered.nb_frames);

    const x = (preset.generationWidth - preset.width) / 2;
    const y = (preset.generationHeight - preset.height) / 2;
    await runFfmpeg([
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      `crop=${preset.width}:${preset.height}:${x}:${y}`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "14",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      temporaryPath,
    ]);

    const cropped = (await ffprobeJson(["-select_streams", "v:0", "-show_streams", temporaryPath])).streams?.[0];
    if (cropped?.width !== preset.width || cropped.height !== preset.height) {
      throw new Error(`cropped file is ${cropped?.width}x${cropped?.height}`);
    }
    if (renderedFrames && positiveInteger(cropped.nb_frames) !== renderedFrames) {
      throw new Error(`cropped file has ${cropped.nb_frames} frames, the render had ${renderedFrames}`);
    }

    await rmWithRetry(filePath, { force: true });
    await renameWithRetry(temporaryPath, filePath);
    return true;
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    console.warn(
      `[ltx-cq-i2v] ${job.id}: kept the ${preset.generationHeight}p render as returned; crop failed: ${ffmpegErrorMessage(error)}`,
    );
    return false;
  }
}
