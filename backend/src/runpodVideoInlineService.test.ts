import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-runpod-video-inline-"));
const workFolder = path.join(tempRoot, "work");

const { prepareRunpodInlineVideoFile } = await import("./runpodVideoInlineService.js");

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

// A real clip, because the whole point of this module is what FFmpeg does to
// the bytes. `noise` picks a per-pixel random source: colour bars compress down
// to a few KB no matter what bitrate is requested, so only noise reliably
// produces a source that overshoots the budgets these tests hand it.
async function makeClip(name: string, options: { size: string; duration: number; bitrate: string; noise?: boolean }) {
  const clip = path.join(tempRoot, name);
  const sourceArgs = options.noise
    ? ["-f", "lavfi", "-i", `nullsrc=s=${options.size}:r=30:d=${options.duration}`, "-vf", "geq=random(1)*255:128:128"]
    : ["-f", "lavfi", "-i", `testsrc=size=${options.size}:rate=30:duration=${options.duration}`];

  await execFileAsync(
    process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...sourceArgs,
      "-c:v",
      "libx264",
      "-b:v",
      options.bitrate,
      "-pix_fmt",
      "yuv420p",
      clip,
    ],
    { timeout: 60_000, windowsHide: true },
  );
  // Probed here too: the service needs ffprobe as well as ffmpeg, so a host
  // with only one of them should skip rather than fail.
  await execFileAsync(process.env.FFPROBE_PATH?.trim() || "ffprobe", ["-v", "error", "-show_entries", "format=duration", clip], {
    timeout: 30_000,
    windowsHide: true,
  });
  return clip;
}

async function probeResolution(filePath: string) {
  const { stdout } = await execFileAsync(
    process.env.FFPROBE_PATH?.trim() || "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath],
    { timeout: 30_000, windowsHide: true },
  );
  const stream = (JSON.parse(stdout) as { streams?: Array<{ width: number; height: number }> }).streams?.[0];
  return stream ? `${stream.width}x${stream.height}` : undefined;
}

function dataUrlByteLength(value: string) {
  const payload = value.slice(value.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

test("a video already inside the inline budget is passed through untouched", async (t) => {
  let clip: string;
  try {
    clip = await makeClip("small.mp4", { size: "160x120", duration: 1, bitrate: "80k" });
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  const original = await fs.readFile(clip);
  const prepared = await prepareRunpodInlineVideoFile({ filePath: clip, workFolder, maxBytes: 2 * 1024 * 1024 });

  assert.equal(prepared.compressed, false, "a clip under budget must not be re-encoded");
  assert.equal(prepared.byteLength, original.byteLength);
  assert.equal(prepared.image, `data:video/mp4;base64,${original.toString("base64")}`);
});

test("an oversized video is re-encoded under budget at its original resolution", async (t) => {
  let clip: string;
  try {
    clip = await makeClip("oversized.mp4", { size: "320x240", duration: 2, bitrate: "8M", noise: true });
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  const maxBytes = 400_000;
  const originalBytes = (await fs.stat(clip)).size;
  assert.ok(originalBytes > maxBytes, `test clip should exceed the budget, got ${originalBytes}`);

  const prepared = await prepareRunpodInlineVideoFile({ filePath: clip, workFolder, maxBytes });

  assert.equal(prepared.compressed, true);
  assert.ok(prepared.byteLength <= maxBytes, `re-encode must fit ${maxBytes}, got ${prepared.byteLength}`);
  assert.equal(dataUrlByteLength(prepared.image), prepared.byteLength, "the data URL must carry the re-encoded bytes");
  assert.match(prepared.image, /^data:video\/mp4;base64,/);

  // The load-bearing invariant: resolution is never traded away, because the
  // video preprocess step normalizes dimensions for the provider's limits and a
  // downscale here would silently undo it.
  const encodedPath = path.join(workFolder, "runpod_inline_video.mp4");
  assert.equal(await probeResolution(encodedPath), "320x240");
});

test("a budget unreachable at the bitrate floor fails with the base URL hint", async (t) => {
  let clip: string;
  try {
    clip = await makeClip("hopeless.mp4", { size: "320x240", duration: 2, bitrate: "8M", noise: true });
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  // 50KB over 2s leaves ~180kbps, well under the 400kbps floor, so the service
  // should refuse rather than ship an unusable smear to a paid provider run.
  await assert.rejects(
    prepareRunpodInlineVideoFile({ filePath: clip, workFolder, maxBytes: 50_000 }),
    (error: Error) => {
      assert.match(error.message, /above the inline 0\.05MiB budget/);
      assert.match(error.message, /RUNPOD_INPUT_BASE_URL/);
      return true;
    },
  );
});
