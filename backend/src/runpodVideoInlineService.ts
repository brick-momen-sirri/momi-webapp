// Squeezes an oversized video input into RunPod's inline JSON budget.
//
// This is the video twin of runpodImageInlineService, and exists for the same
// reason: when RUNPOD_INPUT_BASE_URL is unset the dispatcher has no way to hand
// RunPod a download URL, so the bytes must ride inside the JSON request. Videos
// used to fail hard at that point, which turned a routine 8MiB clip into a dead
// job and left the operator hand-compressing files until one slipped under the
// cap.
//
// One deliberate difference from the image path: this never changes the
// resolution. Video dimensions are load-bearing for the models that take video
// input -- runpodVideoPreprocessService normalizes Kling O3 to a 720-2160px
// range and caps Seedance 2.0 reference pixels -- so a downscale here would
// silently undo that normalization and get the job rejected by the provider
// instead. Bitrate is the only dimension we trade away, and when even the
// bitrate floor cannot fit the budget we fail with the base-URL hint rather
// than ship a smear.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { renameWithRetry, rmWithRetry } from "./fsRetry.js";

import {
  runpodInlineMediaMaxBytes,
  runpodInlineVideoAutoCompress,
  runpodInlineVideoMinBitrate,
  runpodInputBaseUrl,
} from "./config.js";

const execFileAsync = promisify(execFile);
const INLINE_ENCODE_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const AUDIO_BITRATE = 128_000;
// Single-pass rate control drifts a few percent either side of -b:v, and the
// container adds its own overhead, so each attempt aims at a fraction of the
// budget instead of at the budget itself. A miss falls through to the next,
// tighter fill rather than failing the job.
const attemptFills = [0.9, 0.78, 0.66, 0.54];

export type RunpodInlineVideoInput = {
  image: string;
  byteLength: number;
  compressed: boolean;
};

export function runpodInlineVideoByteBudget() {
  return runpodInlineMediaMaxBytes;
}

export async function prepareRunpodInlineVideoFile(options: {
  filePath: string;
  workFolder: string;
  maxBytes?: number;
}): Promise<RunpodInlineVideoInput> {
  const maxBytes = options.maxBytes ?? runpodInlineVideoByteBudget();
  const stat = await fs.stat(options.filePath);
  if (stat.size <= maxBytes) {
    return {
      image: await readVideoAsDataUrl(options.filePath),
      byteLength: stat.size,
      compressed: false,
    };
  }

  if (!runpodInlineVideoAutoCompress) {
    throwRunpodInlineVideoTooLarge(stat.size, maxBytes, options.filePath);
  }

  const compressed = await compressVideoForInlineJson(options.filePath, options.workFolder, maxBytes);
  return {
    image: `data:video/mp4;base64,${compressed.buffer.toString("base64")}`,
    byteLength: compressed.buffer.byteLength,
    compressed: true,
  };
}

async function compressVideoForInlineJson(sourcePath: string, workFolder: string, maxBytes: number) {
  const probed = await probeVideo(sourcePath);
  if (!probed) {
    throw new Error(
      `Could not read the duration of video input "${path.basename(sourcePath)}", so it cannot be re-encoded to fit ` +
        `RunPod's inline ${formatBytes(maxBytes)} budget. Install FFmpeg or set RUNPOD_INPUT_BASE_URL.`,
    );
  }

  await fs.mkdir(workFolder, { recursive: true });
  const outputPath = path.join(workFolder, "runpod_inline_video.mp4");
  const audioBitrate = probed.hasAudio ? AUDIO_BITRATE : 0;
  let smallest: number | undefined;

  for (const fill of attemptFills) {
    const videoBitrate = Math.floor((maxBytes * 8 * fill) / probed.duration) - audioBitrate;
    if (videoBitrate < runpodInlineVideoMinBitrate) break;

    const encoded = await encodeVideo(sourcePath, outputPath, videoBitrate, probed.hasAudio);
    if (!smallest || encoded.byteLength < smallest) smallest = encoded.byteLength;
    if (encoded.byteLength <= maxBytes) {
      console.info(
        `[runpod] Re-encoded inline video input ${path.basename(sourcePath)} from ${formatBytes(probed.size)} to ` +
          `${formatBytes(encoded.byteLength)} at ${Math.round(videoBitrate / 1000)}kbps, preserving resolution.`,
      );
      return { buffer: encoded };
    }
  }

  await rmWithRetry(outputPath, { force: true }).catch(() => undefined);
  throwRunpodInlineVideoTooLarge(probed.size, maxBytes, sourcePath, smallest);
}

async function encodeVideo(sourcePath: string, outputPath: string, videoBitrate: number, hasAudio: boolean) {
  const temporaryPath = `${outputPath}.${process.pid}.part.mp4`;
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  const audioArgs = hasAudio ? ["-c:a", "aac", "-b:a", String(AUDIO_BITRATE)] : ["-an"];

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
        ...(hasAudio ? ["-map", "0:a:0"] : []),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-b:v",
        String(videoBitrate),
        // Capping the peak keeps a burst of motion from blowing the whole
        // budget on one second of footage.
        "-maxrate",
        String(Math.floor(videoBitrate * 1.35)),
        "-bufsize",
        String(videoBitrate * 2),
        "-pix_fmt",
        "yuv420p",
        ...audioArgs,
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temporaryPath,
      ],
      {
        timeout: INLINE_ENCODE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    await rmWithRetry(outputPath, { force: true });
    await renameWithRetry(temporaryPath, outputPath);
    return await fs.readFile(outputPath);
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : "unknown FFmpeg error";
    throw new Error(`Could not re-encode video input "${path.basename(sourcePath)}" for inline submission: ${message}`);
  }
}

async function probeVideo(filePath: string) {
  const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=codec_type", "-of", "json", filePath],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; size?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return undefined;
    return {
      duration,
      size: Number(parsed.format?.size) || (await fs.stat(filePath)).size,
      hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === "audio"),
    };
  } catch {
    return undefined;
  }
}

async function readVideoAsDataUrl(filePath: string) {
  const buffer = await fs.readFile(filePath);
  return `data:${videoMimeType(filePath)};base64,${buffer.toString("base64")}`;
}

function videoMimeType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    case ".m4v":
      return "video/x-m4v";
    default:
      return "video/mp4";
  }
}

function throwRunpodInlineVideoTooLarge(
  originalBytes: number,
  maxBytes: number,
  source: string,
  compressedBytes?: number,
): never {
  const sourceName = path.basename(source) || "video input";
  const compressedHint = compressedBytes ? ` The smallest re-encode was ${formatBytes(compressedBytes)}.` : "";
  const baseUrlHint = runpodInputBaseUrl
    ? "The input could not be sent as a signed file URL, and re-encoding was not enough."
    : "Set RUNPOD_INPUT_BASE_URL to a public URL for this backend so RunPod can download the original file bytes without inline JSON.";

  throw new Error(
    `RunPod video input "${sourceName}" is ${formatBytes(originalBytes)}, above the inline ${formatBytes(maxBytes)} budget.${compressedHint} ${baseUrlHint}`,
  );
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`;
}
