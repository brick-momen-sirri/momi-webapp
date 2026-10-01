import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import sharp from "sharp";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-ltx-cq-i2v-"));

const { finishLtxCqResult, prepareLtxCqI2vImage } = await import("./ltxCqImageToVideoMedia.js");

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const ltxJob = (label: string, width: number, height: number) => ({
  id: "job_ltx",
  modelId: "ltx25_cq_i2v",
  resolution: { width, height, label },
});

test("the input is written upright, opaque and as PNG whatever it arrived as", async () => {
  // A portrait phone photo: stored 60x40, EXIF says rotate 90.
  const rotated = path.join(tempRoot, "rotated.jpg");
  await sharp({ create: { width: 60, height: 40, channels: 3, background: "#336699" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(rotated);
  const out = await prepareLtxCqI2vImage(rotated, path.join(tempRoot, "rotated.png"));
  const upright = await sharp(out).metadata();
  assert.deepEqual([upright.format, upright.width, upright.height], ["png", 40, 60]);

  const transparent = path.join(tempRoot, "transparent.png");
  await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toFile(transparent);
  const flattened = await prepareLtxCqI2vImage(transparent, path.join(tempRoot, "flattened.png"));
  const { data, info } = await sharp(flattened).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  // Laid on white, not left as the black LoadImage would have produced.
  assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255]);
});

test("a file that is not an image is refused, whatever its extension", async () => {
  const fake = path.join(tempRoot, "fake.png");
  await fs.writeFile(fake, "definitely not a png");
  await assert.rejects(prepareLtxCqI2vImage(fake, path.join(tempRoot, "fake-out.png")), /could not be decoded/);
});

test("a source over 40 MP is scaled down rather than refused", async () => {
  const huge = path.join(tempRoot, "huge.png");
  await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#808080" } })
    .png()
    .toFile(huge);
  const out = await prepareLtxCqI2vImage(huge, path.join(tempRoot, "huge-out.png"));
  const { width = 0, height = 0 } = await sharp(out).metadata();
  assert.ok(width * height <= 40_000_000, `${width}x${height}`);
  assert.ok(Math.abs(width / height - 8000 / 6000) < 0.01);
});

test("a 1080p render is cropped from 1088 to 1080 with every frame and its audio", async (t) => {
  const render = path.join(tempRoot, "render-1088.mp4");
  try {
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
        "testsrc=size=1920x1088:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=48000",
        "-frames:v",
        "25",
        "-t",
        String(25 / 24),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        render,
      ],
      { timeout: 120_000, windowsHide: true },
    );
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  assert.equal(await finishLtxCqResult(ltxJob("1080p", 1920, 1080), render), true);
  const { stdout } = await execFileAsync(
    ffprobe,
    ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,nb_read_frames", "-of", "json", render],
    { windowsHide: true },
  );
  const streams = (JSON.parse(stdout) as { streams: Array<Record<string, string | number>> }).streams;
  const video = streams.find((stream) => stream.codec_type === "video");
  assert.deepEqual([video?.width, video?.height, Number(video?.nb_read_frames)], [1920, 1080, 25]);
  assert.ok(
    streams.some((stream) => stream.codec_type === "audio"),
    "the generated audio is kept",
  );

  // Already the delivered size: nothing to do, and nothing done.
  assert.equal(await finishLtxCqResult(ltxJob("1080p", 1920, 1080), render), false);
});

test("1440p renders and other models' results are left alone", async () => {
  const file = path.join(tempRoot, "untouched.mp4");
  await fs.writeFile(file, "not a video");
  assert.equal(await finishLtxCqResult(ltxJob("1440p", 2560, 1440), file), false);
  assert.equal(await finishLtxCqResult({ ...ltxJob("1080p", 1920, 1080), modelId: "brick_api_kling_v3_video" }, file), false);
  assert.equal(await fs.readFile(file, "utf8"), "not a video");
});

// First & Last Frame: cropped where its preset needs it, then checked against the
// plan; any shortfall throws so the job cannot complete on a wrong file.
const flfJob = (label: string, durationSeconds = 2) => ({
  id: "job_flf",
  modelId: "ltx25_cq_flf2v",
  resolution: { width: 0, height: 0, label },
  durationSeconds,
});

async function renderClip(name: string, size: string, frames: number, rate = 24) {
  const file = path.join(tempRoot, name);
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
      `testsrc=size=${size}:rate=${rate}`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:sample_rate=48000",
      "-frames:v",
      String(frames),
      "-t",
      String(frames / rate),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      file,
    ],
    { timeout: 120_000, windowsHide: true },
  );
  return file;
}

async function probe(file: string) {
  const { stdout } = await execFileAsync(
    ffprobe,
    ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,nb_read_frames,avg_frame_rate", "-of", "json", file],
    { windowsHide: true },
  );
  return (JSON.parse(stdout) as { streams: Array<Record<string, string | number>> }).streams;
}

test("First & Last Frame crops 720p and 1080p, keeps 1440p, and checks frames and fps", async (t) => {
  let r720: string;
  try {
    r720 = await renderClip("flf-736.mp4", "1280x736", 49);
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  assert.equal(await finishLtxCqResult(flfJob("720p"), r720), true);
  const streams720 = await probe(r720);
  const video720 = streams720.find((stream) => stream.codec_type === "video");
  assert.deepEqual([video720?.width, video720?.height, Number(video720?.nb_read_frames), video720?.avg_frame_rate], [1280, 720, 49, "24/1"]);
  assert.ok(streams720.some((stream) => stream.codec_type === "audio"), "the generated audio is kept");

  const r1088 = await renderClip("flf-1088.mp4", "1920x1088", 49);
  assert.equal(await finishLtxCqResult(flfJob("1080p"), r1088), true);
  const video1080 = (await probe(r1088)).find((stream) => stream.codec_type === "video");
  assert.deepEqual([video1080?.width, video1080?.height, Number(video1080?.nb_read_frames)], [1920, 1080, 49]);

  // 1440p is already on the grid: verified, not re-encoded.
  const r1440 = await renderClip("flf-1440.mp4", "2560x1440", 49);
  const before = await fs.readFile(r1440);
  assert.equal(await finishLtxCqResult(flfJob("1440p"), r1440), false);
  assert.ok(before.equals(await fs.readFile(r1440)), "1440p is delivered byte for byte");
});

test("First & Last Frame refuses a render with the wrong frames, rate or size", async (t) => {
  let short: string;
  try {
    short = await renderClip("flf-short.mp4", "1920x1088", 41);
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }
  await assert.rejects(finishLtxCqResult(flfJob("1080p"), short), /has 41 frames, expected 49/);

  const fast = await renderClip("flf-30fps.mp4", "2560x1440", 49, 30);
  await assert.rejects(finishLtxCqResult(flfJob("1440p"), fast), /runs at 30 fps, expected 24/);

  const small = await renderClip("flf-small.mp4", "1280x720", 49);
  await assert.rejects(finishLtxCqResult(flfJob("1080p"), small), /render is 1280x720, expected 1920x1088/);

  const notVideo = path.join(tempRoot, "flf-not-video.mp4");
  await fs.writeFile(notVideo, "not a video");
  await assert.rejects(finishLtxCqResult(flfJob("720p"), notVideo), /could not be finished/);
  await assert.rejects(finishLtxCqResult(flfJob("4K"), notVideo), /720p, 1080p, 1440p only/);
});
