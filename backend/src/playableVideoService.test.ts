import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-playable-"));
process.env.PLAYABLE_VIDEO_CACHE_DIR = path.join(tempRoot, "cache");
// The clips below are tiny; a fast preset keeps the suite from spending most of
// its time in x264.
process.env.PLAYABLE_VIDEO_PRESET = "ultrafast";

const {
  getOrCreatePlayableVideo,
  isBrowserPlayable,
  isPlayableVideoSource,
  probeVideo,
  prunePlayableVideoCache,
  warmPlayableVideo,
} = await import("./playableVideoService.js");

const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

const hasFfmpeg = await execFileAsync(ffmpegPath, ["-version"], { windowsHide: true })
  .then(() => true)
  .catch(() => false);

/**
 * Renders a short synthetic clip with the given encoder arguments.
 *
 * Real fixtures are not checked in: the whole point of this service is codec
 * behaviour, and a committed HEVC file would be both large and unreadable as a
 * test input. Generating them makes what each case is about explicit.
 */
async function writeClip(name: string, encoderArgs: string[]) {
  const filePath = path.join(tempRoot, name);
  await execFileAsync(
    ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=12:duration=1",
      ...encoderArgs,
      filePath,
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  return filePath;
}

test("recognises video sources by extension", () => {
  assert.equal(isPlayableVideoSource("C:/renders/shot.mp4"), true);
  assert.equal(isPlayableVideoSource("C:/renders/shot.MOV"), true);
  assert.equal(isPlayableVideoSource("C:/renders/shot.png"), false);
});

test("treats 8-bit H.264 as playable and everything unusual as not", () => {
  const h264 = {
    codecName: "h264",
    codecTag: "avc1",
    pixelFormat: "yuv420p",
    profile: "High",
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  assert.equal(isBrowserPlayable(h264), true);

  // The job that prompted this service: HEVC Main 10 tagged hev1.
  assert.equal(isBrowserPlayable({ ...h264, codecName: "hevc", codecTag: "hev1", pixelFormat: "yuv420p10le" }), false);
  // Legal H.264 that browsers still refuse — the codec name alone is not enough.
  assert.equal(isBrowserPlayable({ ...h264, pixelFormat: "yuv420p10le", profile: "High 10" }), false);
  assert.equal(isBrowserPlayable({ ...h264, pixelFormat: "yuv444p", profile: "High 4:4:4 Predictive" }), false);
  // An unrecognised codec is rebuilt rather than gambled on.
  assert.equal(isBrowserPlayable({ ...h264, codecName: "prores", codecTag: "apcn", pixelFormat: "yuv422p10le" }), false);
  // VP9 in a WebM needs no rendition.
  assert.equal(isBrowserPlayable({ ...h264, codecName: "vp9", codecTag: "" }), true);
});

test("probing a file that is not a video returns nothing", { skip: !hasFfmpeg }, async () => {
  const notAVideo = path.join(tempRoot, "notes.txt");
  await fs.writeFile(notAVideo, "this is not a video");
  assert.equal(await probeVideo(notAVideo), undefined);
});

test("passes an H.264 source through without building a rendition", { skip: !hasFfmpeg }, async () => {
  const source = await writeClip("plain-h264.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast"]);

  const playable = await getOrCreatePlayableVideo(source);
  assert.equal(playable.kind, "passthrough");

  // Nothing was written: a passthrough that quietly copied the file would double
  // the disk cost of every video in the library.
  const shards = await fs.readdir(process.env.PLAYABLE_VIDEO_CACHE_DIR!).catch(() => []);
  assert.equal(shards.length, 0);
});

test("re-encodes a 10-bit HEVC source to 8-bit H.264", { skip: !hasFfmpeg }, async () => {
  const source = await writeClip("hevc-main10.mp4", [
    "-c:v",
    "libx265",
    "-pix_fmt",
    "yuv420p10le",
    "-preset",
    "ultrafast",
    "-tag:v",
    "hev1",
  ]).catch(() => undefined);
  // libx265 is not in every FFmpeg build; without it there is nothing to assert.
  if (!source) return;

  const playable = await getOrCreatePlayableVideo(source);
  assert.equal(playable.kind, "rendition");
  if (playable.kind !== "rendition") return;
  assert.equal(playable.contentType, "video/mp4");

  const probe = await probeVideo(playable.filePath);
  assert.ok(probe, "expected the rendition to be probeable");
  assert.equal(probe.codecName, "h264");
  assert.equal(probe.pixelFormat, "yuv420p");
  assert.equal(probe.codecTag, "avc1");
  assert.equal(isBrowserPlayable(probe), true);
  // Resolution is preserved: the proxy is what people review the shot on.
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 240);

  // The master is untouched — it is still what the download route serves.
  const original = await probeVideo(source);
  assert.equal(original?.codecName, "hevc");

  // A second call is served from cache rather than transcoding again.
  const again = await getOrCreatePlayableVideo(source);
  assert.equal(again.kind, "rendition");
  if (again.kind !== "rendition") return;
  assert.equal(again.filePath, playable.filePath);
  assert.equal(again.cacheKey, playable.cacheKey);
});

test("a rewritten source gets a different rendition", { skip: !hasFfmpeg }, async () => {
  const source = await writeClip("rewritten.mp4", [
    "-c:v",
    "libx265",
    "-pix_fmt",
    "yuv420p10le",
    "-preset",
    "ultrafast",
  ]).catch(() => undefined);
  if (!source) return;

  const first = await getOrCreatePlayableVideo(source);
  if (first.kind !== "rendition") return;

  // Re-render the same path with different content, as a re-run of a job does.
  await writeClip("rewritten.mp4", ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast", "-crf", "40"]);

  const second = await getOrCreatePlayableVideo(source);
  assert.equal(second.kind, "rendition");
  if (second.kind !== "rendition") return;
  assert.notEqual(
    second.cacheKey,
    first.cacheKey,
    "a re-rendered source must invalidate its rendition rather than serve the old one",
  );
});

test("warming never throws on an unreadable source", async () => {
  assert.equal(await warmPlayableVideo(path.join(tempRoot, "missing.mp4")), false);

  const corrupt = path.join(tempRoot, "corrupt.mp4");
  await fs.writeFile(corrupt, Buffer.alloc(2048, 7));
  assert.equal(await warmPlayableVideo(corrupt), false);
});

test("pruning respects the disk budget, oldest first", async () => {
  const cacheDir = process.env.PLAYABLE_VIDEO_CACHE_DIR!;
  const shard = path.join(cacheDir, "ab");
  await fs.mkdir(shard, { recursive: true });

  const older = path.join(shard, "older.mp4");
  const newer = path.join(shard, "newer.mp4");
  await fs.writeFile(older, Buffer.alloc(4096, 1));
  await fs.writeFile(newer, Buffer.alloc(4096, 2));
  // Backdate the first so eviction order is deterministic rather than resting on
  // filesystem timestamp resolution.
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(older, past, past);

  const result = await prunePlayableVideoCache(5000);
  assert.ok(result.deletedFiles >= 1, "expected the budget to force at least one eviction");
  assert.equal(await fs.stat(older).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(newer).then(() => true).catch(() => false), true);
});

test("a cache under budget is left alone", async () => {
  const result = await prunePlayableVideoCache(1024 ** 3);
  assert.equal(result.deletedFiles, 0);
  assert.equal(result.deletedBytes, 0);
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});
