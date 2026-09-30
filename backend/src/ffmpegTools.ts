// Small ffmpeg/ffprobe helpers shared by the LTX 2.5 CQ pod's two features, the
// Video Enhancer and Image to Video, which both reshape a render after it lands.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { ffmpegPath, ffprobePath } from "./config.js";

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 15 * 60_000;

export type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  duration?: string;
  sample_aspect_ratio?: string;
};

export type ProbeResult = { streams?: ProbeStream[]; format?: { duration?: string } };

export async function ffprobeJson(args: string[]): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-of", "json", ...args], {
    timeout: FFMPEG_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as ProbeResult;
}

export async function runFfmpeg(args: string[]) {
  await execFileAsync(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    timeout: FFMPEG_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function partPath(filePath: string) {
  const extension = path.extname(filePath) || ".mp4";
  return `${filePath.slice(0, filePath.length - path.extname(filePath).length)}.${process.pid}.${Date.now()}.part${extension}`;
}

export function positiveInteger(value: string | number | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function ffmpegErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}
