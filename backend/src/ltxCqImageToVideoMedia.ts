// The media half of the LTX 2.5 CQ pod's generation graphs, Image to Video and
// First & Last Frame: each input image normalized to PNG before it is sent, and
// the render cropped to its delivered size after it lands.

import fs from "node:fs/promises";

import sharp, { type Metadata } from "sharp";

import { ffmpegErrorMessage, ffprobeJson, partPath, positiveInteger, runFfmpeg } from "./ffmpegTools.js";
import { renameWithRetry, rmWithRetry, writeFileWithRetry } from "./fsRetry.js";
import { isLtxCqFlfModelId, LTX_CQ_FLF_FPS, planLtxCqFlf } from "./ltxCqFirstLastFrame.js";
import { isLtxCqI2vModelId, ltxCqI2vPreset } from "./ltxCqImageToVideo.js";
import type { Job } from "./types.js";

/**
 * The tested normalizer's decoded-pixel ceiling. A larger source is scaled down to
 * it rather than refused: the graph resizes the image to at most 2560x1440 anyway,
 * and studio renders past 40 MP are ordinary.
 */
const MAX_DECODED_PIXELS = 40_000_000;

type Preset = { width: number; height: number; generationWidth: number; generationHeight: number };

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
 * The post step for both LTX 2.5 CQ graphs, run on the render once it is on disk.
 *
 * Image to Video: crop a 1080p render from the model's 1920x1088 to 1920x1080, or
 * leave the file alone. Returns false and keeps the file as it was on any failure:
 * a 1088 file is a better thing to hand back than no file.
 *
 * First & Last Frame is stricter, because the job is complete only once the crop
 * and the delivered file are right: 720p and 1080p are cropped (eight and four rows
 * top and bottom), 1440p is kept as generated, and then the delivered size, frame
 * count and frame rate are checked against the plan. Any failure throws, the
 * artifact is recorded as not stored, and the dispatcher fails the job.
 *
 * A no-op for every other job.
 */
export async function finishLtxCqResult(
  job: Pick<Job, "id" | "modelId" | "resolution" | "durationSeconds">,
  filePath: string,
) {
  if (isLtxCqFlfModelId(job.modelId)) return finishLtxCqFlfResult(job, filePath);
  if (!isLtxCqI2vModelId(job.modelId)) return false;
  const preset = ltxCqI2vPreset(job.resolution);
  if (!preset || (preset.generationWidth === preset.width && preset.generationHeight === preset.height)) return false;

  try {
    const rendered = await videoStream(filePath);
    if (rendered?.width !== preset.generationWidth || rendered.height !== preset.generationHeight) return false;
    await cropRows(filePath, preset, positiveInteger(rendered.nb_frames));
    return true;
  } catch (error) {
    console.warn(
      `[ltx-cq-i2v] ${job.id}: kept the ${preset.generationHeight}p render as returned; crop failed: ${ffmpegErrorMessage(error)}`,
    );
    return false;
  }
}

async function finishLtxCqFlfResult(job: Pick<Job, "id" | "resolution" | "durationSeconds">, filePath: string) {
  const plan = planLtxCqFlf(job.resolution, job.durationSeconds);
  const needsCrop = plan.generationWidth !== plan.width || plan.generationHeight !== plan.height;
  let cropped = false;
  try {
    const rendered = await videoStream(filePath);
    const renderedSize = `${rendered?.width}x${rendered?.height}`;
    if (needsCrop && renderedSize === `${plan.generationWidth}x${plan.generationHeight}`) {
      await cropRows(filePath, plan, positiveInteger(rendered?.nb_frames));
      cropped = true;
    } else if (renderedSize !== `${plan.width}x${plan.height}`) {
      throw new Error(`the render is ${renderedSize}, expected ${plan.generationWidth}x${plan.generationHeight}`);
    }

    const delivered = await videoStream(filePath, { countPackets: true });
    if (delivered?.width !== plan.width || delivered.height !== plan.height) {
      throw new Error(`the delivered file is ${delivered?.width}x${delivered?.height}, expected ${plan.width}x${plan.height}`);
    }
    const frames = positiveInteger(delivered.nb_frames) ?? positiveInteger(delivered.nb_read_packets);
    if (frames !== plan.frames) throw new Error(`the delivered file has ${frames ?? "no"} frames, expected ${plan.frames}`);
    const fps = frameRate(delivered.avg_frame_rate) ?? frameRate(delivered.r_frame_rate);
    if (!fps || Math.abs(fps - LTX_CQ_FLF_FPS) > 0.01) {
      throw new Error(`the delivered file runs at ${fps ?? "an unknown"} fps, expected ${LTX_CQ_FLF_FPS}`);
    }
    return cropped;
  } catch (error) {
    throw new Error(`LTX 2.5 CQ First & Last Frame result could not be finished: ${ffmpegErrorMessage(error)}`);
  }
}

async function videoStream(filePath: string, options: { countPackets?: boolean } = {}) {
  const args = [...(options.countPackets ? ["-count_packets"] : []), "-select_streams", "v:0", "-show_streams", filePath];
  return (await ffprobeJson(args)).streams?.[0];
}

function frameRate(value: string | undefined) {
  const [numerator, denominator = "1"] = (value ?? "").split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * Crop a render from its generated size to its delivered size, evenly from the top
 * and bottom (and sides, were they ever to differ). The frames are generated at
 * the larger size, not resized to it, so this is a crop of real pixels: one
 * re-encode, kept visually lossless, with the audio track copied as is. Throws on
 * any failure and leaves the file as it was.
 */
async function cropRows(filePath: string, preset: Preset, renderedFrames: number | undefined) {
  const temporaryPath = partPath(filePath);
  try {
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

    const cropped = await videoStream(temporaryPath);
    if (cropped?.width !== preset.width || cropped.height !== preset.height) {
      throw new Error(`cropped file is ${cropped?.width}x${cropped?.height}`);
    }
    if (renderedFrames && positiveInteger(cropped.nb_frames) !== renderedFrames) {
      throw new Error(`cropped file has ${cropped.nb_frames} frames, the render had ${renderedFrames}`);
    }

    await rmWithRetry(filePath, { force: true });
    await renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
