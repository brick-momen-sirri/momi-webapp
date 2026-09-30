// The ffmpeg half of the Video Enhancer: measuring the source, preparing it the
// way the worker's named mode would have, and putting the result back at the
// source frame rate afterwards. See videoEnhancer.ts for why this is ours to do.

import { ffmpegErrorMessage, ffprobeJson, partPath, positiveInteger, runFfmpeg } from "./ffmpegTools.js";
import { renameWithRetry, rmWithRetry } from "./fsRetry.js";
import { localMediaFilePathFromUrl } from "./jobQueue/providerInputs.js";
import { resolveAllowedExistingMediaPath } from "./mediaPathPolicy.js";
import type { Job } from "./types.js";
import {
  parseFrameRate,
  VIDEO_ENHANCER_MODEL_FPS,
  type VideoEnhancerPlan,
  type VideoEnhancerSourceProbe,
} from "./videoEnhancer.js";

export type VideoEnhancerSource = VideoEnhancerSourceProbe & {
  /** Sample aspect ratio. Anything but 1 is squared up during preparation. */
  pixelAspect: number;
};

export async function probeVideoEnhancerSource(filePath: string): Promise<VideoEnhancerSource> {
  const info = await ffprobeJson(["-show_streams", "-show_format", filePath]);
  const streams = info.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error("The input file has no readable video stream.");

  // avg_frame_rate is the real cadence; r_frame_rate is the container's guess and
  // reads 90000/1 on some streams, so it is only the fallback.
  const fps = [video.avg_frame_rate, video.r_frame_rate].find((rate) => {
    const value = parseFrameRate(rate);
    return value !== undefined && value <= 240;
  });
  if (!fps) throw new Error("Could not read the input video's frame rate.");

  const pixelAspect = parseAspectRatio(video.sample_aspect_ratio) ?? 1;
  const durationSeconds = Number(info.format?.duration ?? video.duration);
  // MP4 and MOV state the count in the header. WebM and MKV do not, and the
  // packet count is the next best thing: exact for these codecs, and far cheaper
  // than decoding.
  const frames = positiveInteger(video.nb_frames) ?? (await countVideoPackets(filePath));

  return {
    width: Math.round(video.width * pixelAspect),
    height: video.height,
    fps,
    frames,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    pixelAspect,
  };
}

/**
 * Produce the file the model conditions on: 30 fps, the plan's exact size, the
 * plan's exact frame count, and a silent stereo track.
 *
 * The same normalization the worker applies to a named-mode request (fps, cover
 * scale, centre crop, trim, silence), with one addition: a source inside the
 * retime band has every frame re-stamped at 30 fps first, so none are dropped.
 * The silence is there because the graph's output muxes the input's audio; the
 * source's real audio is put back afterwards, in finishVideoEnhancerResult,
 * where it can be matched to the restored timing.
 */
export async function prepareVideoEnhancerInput(
  sourcePath: string,
  outputPath: string,
  plan: VideoEnhancerPlan,
  source: Pick<VideoEnhancerSource, "pixelAspect">,
) {
  const filters = [
    plan.timing === "retime" ? `setpts=N/(${VIDEO_ENHANCER_MODEL_FPS}*TB)` : undefined,
    `fps=${VIDEO_ENHANCER_MODEL_FPS}`,
    // Cover-scale reads stored pixels, so an anamorphic source is squared first
    // or the crop would be planned against the wrong aspect.
    Math.abs(source.pixelAspect - 1) > 0.001 ? "scale=trunc(iw*sar/2)*2:ih,setsar=1" : undefined,
    `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${plan.width}:${plan.height}`,
    "setsar=1",
  ].filter(Boolean);

  const temporaryPath = partPath(outputPath);
  try {
    await runFfmpeg([
      "-i",
      sourcePath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      filters.join(","),
      "-frames:v",
      String(plan.frames),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      // A notch under the worker's own 18: this file is the model's guide, and
      // the upload is by URL, so size costs nothing here.
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      (plan.frames / VIDEO_ENHANCER_MODEL_FPS).toFixed(6),
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      temporaryPath,
    ]);

    const prepared = (await ffprobeJson(["-select_streams", "v:0", "-show_streams", temporaryPath])).streams?.[0];
    if (prepared?.width !== plan.width || prepared.height !== plan.height) {
      throw new Error(`expected ${plan.width}x${plan.height}, got ${prepared?.width}x${prepared?.height}`);
    }
    const frames = positiveInteger(prepared.nb_frames) ?? 0;
    // The worker checks this too, but only after the upload and a GPU cold start.
    if (frames < plan.frames) throw new Error(`expected ${plan.frames} frames, got ${frames}`);

    await rmWithRetry(outputPath, { force: true });
    await renameWithRetry(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not prepare the input video for the Video Enhancer: ${ffmpegErrorMessage(error)}`);
  }
}

/**
 * Put a finished render back on the source's clock, with the source's audio.
 *
 * The model returns 30 fps. For a retimed source that is the source's own frames
 * played too fast, so the timestamps are stretched back -- a stream copy, which
 * leaves the rendered pixels untouched. The model's audio is the silence it was
 * given and is always discarded.
 *
 * Returns false and leaves the file as it was when anything fails: the render is
 * already paid for, and a 30 fps file is a better thing to hand back than none.
 */
export async function finishVideoEnhancerResult(job: Pick<Job, "id" | "inputVideo" | "workflowOptions">, filePath: string) {
  const plan = job.workflowOptions?.videoEnhancer?.plan;
  if (!plan) return false;

  const temporaryPath = partPath(filePath);
  try {
    const outputFps = parseFrameRate(plan.outputFps);
    const sourceFps = parseFrameRate(plan.sourceFps);
    if (!outputFps || !sourceFps) throw new Error("the plan has no usable frame rate");
    const stretch = plan.timing === "retime" ? VIDEO_ENHANCER_MODEL_FPS / sourceFps : 1;
    const sourcePath = plan.sourceHasAudio ? await sourceVideoPath(job.inputVideo) : undefined;

    const renderedFrames = positiveInteger(
      (await ffprobeJson(["-select_streams", "v:0", "-show_streams", filePath])).streams?.[0]?.nb_frames,
    );

    await runFfmpeg([
      "-itsscale",
      stretch.toFixed(9),
      "-i",
      filePath,
      ...(sourcePath ? ["-i", sourcePath] : []),
      "-map",
      "0:v:0",
      ...(sourcePath ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v",
      "copy",
      // A track timescale the output rate divides evenly. Left to the muxer, a
      // copy keeps the render's own timescale, which need not hold 1/24 s steps,
      // and the frames would land on an uneven cadence.
      "-video_track_timescale",
      String(trackTimescale(plan.outputFps)),
      "-t",
      (plan.frames / outputFps).toFixed(6),
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      temporaryPath,
    ]);

    const finished = positiveInteger(
      (await ffprobeJson(["-select_streams", "v:0", "-show_streams", temporaryPath])).streams?.[0]?.nb_frames,
    );
    if (renderedFrames && finished !== renderedFrames) {
      throw new Error(`restored file has ${finished} frames, the render had ${renderedFrames}`);
    }

    await rmWithRetry(filePath, { force: true });
    await renameWithRetry(temporaryPath, filePath);
    return true;
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    console.warn(
      `[video-enhancer] ${job.id}: kept the 30 fps render as returned; restoring the source frame rate failed: ${ffmpegErrorMessage(error)}`,
    );
    return false;
  }
}

async function sourceVideoPath(inputVideo: string | undefined) {
  const filePath = inputVideo ? localMediaFilePathFromUrl(inputVideo) : undefined;
  const resolved = filePath ? await resolveAllowedExistingMediaPath(filePath) : undefined;
  if (!resolved) throw new Error("the source video is no longer available to take its audio from");
  return resolved;
}

/** "24/1" -> 24000, "24000/1001" -> 24000, "30/1" -> 30000: one frame is always a whole number of ticks. */
export function trackTimescale(rate: string) {
  const [numerator, denominator = "1"] = rate.split("/").map(Number);
  return denominator === 1 ? numerator * 1000 : numerator;
}

async function countVideoPackets(filePath: string) {
  const info = await ffprobeJson([
    "-select_streams",
    "v:0",
    "-count_packets",
    "-show_entries",
    "stream=nb_read_packets",
    filePath,
  ]);
  return positiveInteger(info.streams?.[0]?.nb_read_packets);
}

function parseAspectRatio(value: string | undefined) {
  const [width, height] = (value ?? "").split(":").map(Number);
  return width > 0 && height > 0 ? width / height : undefined;
}
