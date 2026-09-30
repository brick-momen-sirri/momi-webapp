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

const { finishLtxCqI2vResult, prepareLtxCqI2vImage } = await import("./ltxCqImageToVideoMedia.js");

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

  assert.equal(await finishLtxCqI2vResult(ltxJob("1080p", 1920, 1080), render), true);
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
  assert.equal(await finishLtxCqI2vResult(ltxJob("1080p", 1920, 1080), render), false);
});

test("1440p renders and other models' results are left alone", async () => {
  const file = path.join(tempRoot, "untouched.mp4");
  await fs.writeFile(file, "not a video");
  assert.equal(await finishLtxCqI2vResult(ltxJob("1440p", 2560, 1440), file), false);
  assert.equal(await finishLtxCqI2vResult({ ...ltxJob("1080p", 1920, 1080), modelId: "brick_api_kling_v3_video" }, file), false);
  assert.equal(await fs.readFile(file, "utf8"), "not a video");
});
