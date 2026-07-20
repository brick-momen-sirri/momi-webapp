import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { detectMediaResolution } from "./mediaResolutionService.js";
import type { Resolution, WorkflowModel } from "./types.js";

const execFileAsync = promisify(execFile);
const KLING_VIDEO_MIN_DIMENSION = 720;
const KLING_VIDEO_MAX_DIMENSION = 2160;
const SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS = 2_073_600;
const VIDEO_PREPROCESS_TIMEOUT_MS = 15 * 60_000;

type VideoModel = Pick<WorkflowModel, "id" | "name" | "workflowPath">;

export async function prepareRunpodVideoFile(
  sourcePath: string,
  outputFolder: string,
  model: VideoModel,
) {
  const isKlingO3 = isKlingO3VideoEditModel(model);
  const isSeedance2Reference = isSeedance2ReferenceVideoModel(model);
  if (!isKlingO3 && !isSeedance2Reference) return sourcePath;

  const sourceResolution = await detectMediaResolution(sourcePath, "video");
  if (!sourceResolution) return sourcePath;

  const targetResolution = isKlingO3
    ? normalizedKlingVideoDimensions(sourceResolution)
    : normalizedSeedance2ReferenceVideoDimensions(sourceResolution);
  if (
    targetResolution.width === sourceResolution.width
    && targetResolution.height === sourceResolution.height
  ) {
    return sourcePath;
  }

  await fs.mkdir(outputFolder, { recursive: true });
  const outputPath = path.join(
    outputFolder,
    isKlingO3 ? "runpod_kling_o3_input.mp4" : "runpod_seedance_2_reference_input.mp4",
  );
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.part.mp4`;
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", sourcePath,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", `scale=${targetResolution.width}:${targetResolution.height}`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        temporaryPath,
      ],
      {
        timeout: VIDEO_PREPROCESS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const processedResolution = await detectMediaResolution(temporaryPath, "video");
    if (
      !processedResolution
      || processedResolution.width !== targetResolution.width
      || processedResolution.height !== targetResolution.height
    ) {
      throw new Error("FFmpeg produced an unexpected video resolution.");
    }

    await fs.rm(outputPath, { force: true });
    await fs.rename(temporaryPath, outputPath);
    console.info(
      `[runpod] Normalized ${isKlingO3 ? "Kling O3" : "Seedance 2.0 reference"} input video `
      + `from ${sourceResolution.width}x${sourceResolution.height} `
      + `to ${targetResolution.width}x${targetResolution.height}.`,
    );
    return outputPath;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : "unknown FFmpeg error";
    const requirement = isKlingO3
      ? `Kling O3 requires video dimensions between ${KLING_VIDEO_MIN_DIMENSION}px and ${KLING_VIDEO_MAX_DIMENSION}px.`
      : `Seedance 2.0 reference video accepts at most ${SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS.toLocaleString("en-US")} pixels.`;
    throw new Error(`${requirement} Could not normalize ${sourceResolution.width}x${sourceResolution.height} input: ${message}`);
  }
}

export function isKlingO3VideoEditModel(model: VideoModel) {
  const key = `${model.id} ${model.name} ${model.workflowPath}`.toLowerCase();
  return key.includes("kling")
    && (key.includes("o3") || key.includes("omni"))
    && (key.includes("video_edit") || key.includes("video edit"));
}

export function isSeedance2ReferenceVideoModel(model: VideoModel) {
  const key = `${model.id} ${model.name} ${model.workflowPath}`.toLowerCase();
  const isSeedance2 = key.includes("seedance2") || key.includes("seedance 2");
  const isReferenceVideo = key.includes("r2v")
    || key.includes("reference_to_video")
    || key.includes("reference to video");
  return isSeedance2 && isReferenceVideo;
}

export function normalizedSeedance2ReferenceVideoDimensions(
  resolution: Pick<Resolution, "width" | "height">,
) {
  const { width, height } = resolution;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Input video dimensions are invalid.");
  }

  if (width * height <= SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS) {
    return { width, height };
  }

  const scale = Math.sqrt(SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS / (width * height));
  let targetWidth = evenFloorDimension(width * scale);
  let targetHeight = evenFloorDimension(height * scale);

  // Rounding both dimensions independently can only approach the limit from below,
  // but keep a hard guard here for extreme aspect ratios clamped to two pixels.
  if (targetWidth * targetHeight > SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS) {
    if (targetWidth >= targetHeight) {
      targetWidth = evenFloorDimension(SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS / targetHeight);
    } else {
      targetHeight = evenFloorDimension(SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS / targetWidth);
    }
  }

  return { width: targetWidth, height: targetHeight };
}

export function normalizedKlingVideoDimensions(resolution: Pick<Resolution, "width" | "height">) {
  const { width, height } = resolution;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Input video dimensions are invalid.");
  }

  let scale = Math.min(1, KLING_VIDEO_MAX_DIMENSION / width, KLING_VIDEO_MAX_DIMENSION / height);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  if (scaledWidth < KLING_VIDEO_MIN_DIMENSION || scaledHeight < KLING_VIDEO_MIN_DIMENSION) {
    scale *= Math.max(
      KLING_VIDEO_MIN_DIMENSION / scaledWidth,
      KLING_VIDEO_MIN_DIMENSION / scaledHeight,
    );
  }

  const target = {
    width: evenDimension(width * scale),
    height: evenDimension(height * scale),
  };
  if (
    target.width < KLING_VIDEO_MIN_DIMENSION
    || target.height < KLING_VIDEO_MIN_DIMENSION
    || target.width > KLING_VIDEO_MAX_DIMENSION
    || target.height > KLING_VIDEO_MAX_DIMENSION
  ) {
    throw new Error(
      `Video aspect ratio cannot fit within Kling O3's ${KLING_VIDEO_MIN_DIMENSION}–`
      + `${KLING_VIDEO_MAX_DIMENSION}px dimension limits without cropping.`,
    );
  }
  return target;
}

function evenDimension(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function evenFloorDimension(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2);
}
