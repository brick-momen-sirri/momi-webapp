import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { detectMediaResolution } from "./mediaResolutionService.js";
import { renameWithRetry, rmWithRetry } from "./fsRetry.js";
import type { Resolution, WorkflowModel } from "./types.js";

const execFileAsync = promisify(execFile);
const KLING_VIDEO_MIN_DIMENSION = 720;
const KLING_VIDEO_MAX_DIMENSION = 2160;
const SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS = 2_073_600;
const VIDEO_PREPROCESS_TIMEOUT_MS = 15 * 60_000;

type VideoModel = Pick<WorkflowModel, "id" | "name" | "workflowPath">;

export async function prepareRunpodVideoFile(sourcePath: string, outputFolder: string, model: VideoModel) {
  const isKlingO3 = isKlingO3VideoEditModel(model);
  const isSeedance2Reference = isSeedance2ReferenceVideoModel(model);
  if (!isKlingO3 && !isSeedance2Reference) return sourcePath;

  // Plan against the *displayed* frame, not the stored one. Anamorphic sources
  // store fewer columns than they show, and Kling's VideoNormalize rejects any
  // non-square pixel aspect outright, so both the size and the SAR must be fixed.
  const sourceGeometry = await probeVideoGeometry(sourcePath);
  const sourceResolution = sourceGeometry
    ? displayResolution(sourceGeometry)
    : await detectMediaResolution(sourcePath, "video");
  if (!sourceResolution) return sourcePath;

  const targetResolution = isKlingO3
    ? normalizedKlingVideoDimensions(sourceResolution)
    : normalizedSeedance2ReferenceVideoDimensions(sourceResolution);
  const anamorphicNote =
    sourceGeometry && !hasSquarePixels(sourceGeometry) ? ` (pixel aspect ${aspectRatioLabel(sourceGeometry)})` : "";
  const squarePixels = !anamorphicNote;
  if (
    squarePixels &&
    targetResolution.width === sourceResolution.width &&
    targetResolution.height === sourceResolution.height
  ) {
    return sourcePath;
  }

  await fs.mkdir(outputFolder, { recursive: true });
  const outputPath = path.join(outputFolder, isKlingO3 ? "runpod_kling_o3_input.mp4" : "runpod_seedance_2_reference_input.mp4");
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.part.mp4`;
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        // scale() rewrites the output SAR to preserve display aspect, so setsar
        // has to come after it to actually land square pixels.
        "-vf",
        `scale=${targetResolution.width}:${targetResolution.height},setsar=1`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        temporaryPath,
      ],
      {
        timeout: VIDEO_PREPROCESS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const processedGeometry = await probeVideoGeometry(temporaryPath);
    const processedResolution = processedGeometry ?? (await detectMediaResolution(temporaryPath, "video"));
    if (
      !processedResolution ||
      processedResolution.width !== targetResolution.width ||
      processedResolution.height !== targetResolution.height
    ) {
      throw new Error("FFmpeg produced an unexpected video resolution.");
    }
    if (processedGeometry && !hasSquarePixels(processedGeometry)) {
      throw new Error(
        `FFmpeg left a ${aspectRatioLabel(processedGeometry)} pixel aspect ratio on the normalized video.`,
      );
    }

    await rmWithRetry(outputPath, { force: true });
    await renameWithRetry(temporaryPath, outputPath);
    console.info(
      `[runpod] Normalized ${isKlingO3 ? "Kling O3" : "Seedance 2.0 reference"} input video ` +
        `from ${sourceResolution.width}x${sourceResolution.height}${anamorphicNote} ` +
        `to ${targetResolution.width}x${targetResolution.height} with square pixels.`,
    );
    return outputPath;
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : "unknown FFmpeg error";
    const requirement = isKlingO3
      ? `Kling O3 requires square pixels and video dimensions between ${KLING_VIDEO_MIN_DIMENSION}px and ${KLING_VIDEO_MAX_DIMENSION}px.`
      : `Seedance 2.0 reference video requires square pixels and at most ${SEEDANCE_2_REFERENCE_VIDEO_MAX_PIXELS.toLocaleString("en-US")} pixels.`;
    throw new Error(
      `${requirement} Could not normalize ${sourceResolution.width}x${sourceResolution.height}${anamorphicNote} input: ${message}`,
    );
  }
}

/**
 * Models whose provider rejects anamorphic input outright. Their video has to be
 * re-encoded to square pixels first, which the backend can only do to bytes it
 * holds on disk -- so these models cannot accept a bare remote URL.
 */
export function requiresNormalizedVideoInput(model: VideoModel) {
  return isKlingO3VideoEditModel(model) || isSeedance2ReferenceVideoModel(model);
}

export function remoteVideoInputRejection(model: VideoModel) {
  return (
    `${model.name} needs an uploaded video. Its provider rejects non-square pixels, and the backend can only ` +
    `normalize a clip it has on disk, so a link cannot be forwarded as-is. Upload the video and resubmit.`
  );
}

export function isKlingO3VideoEditModel(model: VideoModel) {
  const key = `${model.id} ${model.name} ${model.workflowPath}`.toLowerCase();
  return (
    key.includes("kling") &&
    (key.includes("o3") || key.includes("omni")) &&
    (key.includes("video_edit") || key.includes("video edit"))
  );
}

export function isSeedance2ReferenceVideoModel(model: VideoModel) {
  const key = `${model.id} ${model.name} ${model.workflowPath}`.toLowerCase();
  const isSeedance2 = key.includes("seedance2") || key.includes("seedance 2");
  const isReferenceVideo = key.includes("r2v") || key.includes("reference_to_video") || key.includes("reference to video");
  return isSeedance2 && isReferenceVideo;
}

export function normalizedSeedance2ReferenceVideoDimensions(resolution: Pick<Resolution, "width" | "height">) {
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
    scale *= Math.max(KLING_VIDEO_MIN_DIMENSION / scaledWidth, KLING_VIDEO_MIN_DIMENSION / scaledHeight);
  }

  const target = {
    width: evenDimension(width * scale),
    height: evenDimension(height * scale),
  };
  if (
    target.width < KLING_VIDEO_MIN_DIMENSION ||
    target.height < KLING_VIDEO_MIN_DIMENSION ||
    target.width > KLING_VIDEO_MAX_DIMENSION ||
    target.height > KLING_VIDEO_MAX_DIMENSION
  ) {
    throw new Error(
      `Video aspect ratio cannot fit within Kling O3's ${KLING_VIDEO_MIN_DIMENSION}–` +
        `${KLING_VIDEO_MAX_DIMENSION}px dimension limits without cropping.`,
    );
  }
  return target;
}

/**
 * Coded frame size plus the sample aspect ratio the container declares. The two
 * only differ for anamorphic sources, which every provider here rejects.
 */
export type VideoGeometry = {
  width: number;
  height: number;
  sarNumerator: number;
  sarDenominator: number;
};

export function hasSquarePixels(geometry: Pick<VideoGeometry, "sarNumerator" | "sarDenominator">) {
  return geometry.sarNumerator === geometry.sarDenominator;
}

export function displayResolution(geometry: VideoGeometry) {
  return {
    width: Math.max(1, Math.round((geometry.width * geometry.sarNumerator) / geometry.sarDenominator)),
    height: geometry.height,
  };
}

export function parseSampleAspectRatio(value: string | undefined) {
  // ffprobe reports "N:D", or "0:1" / "N/A" when the container declares nothing —
  // an undeclared ratio means square pixels.
  const match = /^(\d+):(\d+)$/.exec(value?.trim() ?? "");
  const numerator = match ? Number(match[1]) : 0;
  const denominator = match ? Number(match[2]) : 0;
  if (numerator <= 0 || denominator <= 0) return { sarNumerator: 1, sarDenominator: 1 };
  return { sarNumerator: numerator, sarDenominator: denominator };
}

function aspectRatioLabel(geometry: Pick<VideoGeometry, "sarNumerator" | "sarDenominator">) {
  return `${geometry.sarNumerator}:${geometry.sarDenominator}`;
}

async function probeVideoGeometry(filePath: string): Promise<VideoGeometry | undefined> {
  const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,sample_aspect_ratio",
        "-of",
        "json",
        filePath,
      ],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string }>;
    };
    const stream = parsed.streams?.find((item) => Number.isFinite(item.width) && Number.isFinite(item.height));
    if (!stream) return undefined;
    const width = Number(stream.width);
    const height = Number(stream.height);
    if (width <= 0 || height <= 0) return undefined;
    return { width, height, ...parseSampleAspectRatio(stream.sample_aspect_ratio) };
  } catch {
    // No ffprobe on this host: fall back to the container-level resolution probe,
    // which is the behaviour this service had before pixel aspect was handled.
    return undefined;
  }
}

function evenDimension(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function evenFloorDimension(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2);
}
