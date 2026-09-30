import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-video-enhancer-"));
// The restore step reads the source's audio back, and only allowed media roots
// may be read. Set before the modules load, since config reads it once.
process.env.UPLOADED_MEDIA_ROOT = tempRoot;

const { planVideoEnhancement } = await import("./videoEnhancer.js");
const { finishVideoEnhancerResult, prepareVideoEnhancerInput, probeVideoEnhancerSource, trackTimescale } =
  await import("./videoEnhancerMedia.js");

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";

/** A 24 fps clip with a tone, like a Kling or Seedance delivery in miniature. */
async function makeSource(name: string, frames: number) {
  const clip = path.join(tempRoot, name);
  await execFileAsync(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x180:rate=24`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-frames:v",
      String(frames),
      "-t",
      String(frames / 24),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      clip,
    ],
    { timeout: 60_000, windowsHide: true },
  );
  return clip;
}

async function streams(filePath: string) {
  const { stdout } = await execFileAsync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", filePath], {
    timeout: 60_000,
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout) as {
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      nb_read_frames?: string;
      duration?: string;
    }>;
  };
  return {
    video: parsed.streams.find((stream) => stream.codec_type === "video"),
    audio: parsed.streams.find((stream) => stream.codec_type === "audio"),
  };
}

async function framePtsDeltas(filePath: string) {
  const { stdout } = await execFileAsync(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", filePath],
    { timeout: 60_000, windowsHide: true },
  );
  const times = stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/,+$/, "").trim())
    // Number("") is 0, which would read as a duplicate first frame.
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return times.slice(1).map((time, index) => time - times[index]);
}

test("a 24 fps source goes to the model at 30 fps with every frame, and comes back at 24 with its audio", async (t) => {
  let source: string;
  try {
    source = await makeSource("source.mp4", 150);
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  const probe = await probeVideoEnhancerSource(source);
  assert.equal(probe.fps, "24/1");
  assert.equal(probe.frames, 150);
  assert.equal(probe.hasAudio, true);

  const plan = planVideoEnhancement(probe, 1280);
  assert.deepEqual([plan.width, plan.height, plan.frames, plan.timing], [1280, 736, 121, "retime"]);

  // Prepared: exactly what the graph expects, 30 fps, silent audio.
  const prepared = await prepareVideoEnhancerInput(source, path.join(tempRoot, "prepared.mp4"), plan, probe);
  const preparedStreams = await streams(prepared);
  assert.equal(preparedStreams.video?.width, 1280);
  assert.equal(preparedStreams.video?.height, 736);
  assert.equal(preparedStreams.video?.r_frame_rate, "30/1");
  assert.equal(Number(preparedStreams.video?.nb_read_frames), 121);
  assert.ok(preparedStreams.audio, "the graph muxes input audio, so the guide carries a silent track");

  // Stand in for the render: the model returns the guide's frames at 30 fps.
  const render = path.join(tempRoot, "render.mp4");
  await fs.copyFile(prepared, render);
  const job = {
    id: "job_test",
    inputVideo: `/api/media?path=${encodeURIComponent(source)}`,
    workflowOptions: { videoEnhancer: { longSide: 1280 as const, plan } },
  };
  assert.equal(await finishVideoEnhancerResult(job, render), true);

  const finished = await streams(render);
  assert.equal(Number(finished.video?.nb_read_frames), 121);
  assert.equal(finished.video?.r_frame_rate, "24/1");
  // All 121 frames on an even 1/24 s cadence, not bunched onto a 1/30 s grid.
  for (const delta of await framePtsDeltas(render)) assert.ok(Math.abs(delta - 1 / 24) < 1e-4, String(delta));
  assert.ok(finished.audio, "the source's audio is put back");
  assert.ok(Math.abs(Number(finished.audio?.duration) - 121 / 24) < 0.05, finished.audio?.duration);
});

test("a render with no plan is left alone", async () => {
  const file = path.join(tempRoot, "untouched.bin");
  await fs.writeFile(file, "not a video");
  assert.equal(await finishVideoEnhancerResult({ id: "job_other", workflowOptions: {} }, file), false);
  assert.equal(await fs.readFile(file, "utf8"), "not a video");
});

test("a failed restore keeps the render as returned", async () => {
  const file = path.join(tempRoot, "broken.mp4");
  await fs.writeFile(file, "not a video");
  const job = {
    id: "job_broken",
    workflowOptions: {
      videoEnhancer: {
        longSide: 1280 as const,
        plan: {
          width: 1280,
          height: 736,
          frames: 121,
          sourceWidth: 320,
          sourceHeight: 180,
          sourceFps: "24/1",
          timing: "retime" as const,
          outputFps: "24/1",
          sourceHasAudio: false,
        },
      },
    },
  };
  assert.equal(await finishVideoEnhancerResult(job, file), false);
  assert.equal(await fs.readFile(file, "utf8"), "not a video");
});

test("track timescales hold a whole number of ticks per frame", () => {
  assert.equal(trackTimescale("24/1"), 24000);
  assert.equal(trackTimescale("24000/1001"), 24000);
  assert.equal(trackTimescale("30/1"), 30000);
});
