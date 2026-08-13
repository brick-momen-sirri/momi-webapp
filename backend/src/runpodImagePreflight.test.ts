import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import sharp from "sharp";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-runpod-image-preflight-"));
process.env.LOCAL_PROJECTS_ROOT = tempRoot;
process.env.BRICK_PROJECTS_ROOT = path.join(tempRoot, "brick");
process.env.UPLOADED_MEDIA_ROOT = path.join(tempRoot, "uploads");

const { validateRunpodImageRequirements } = await import("./runpodImagePreflight.js");

const klingWorkflow = {
  "12": { class_type: "KlingFirstLastFrameNode", inputs: {} },
};

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("accepts Kling first and last frames that meet the minimum height", async () => {
  const first = await imageDataUrl(640, 360);
  const last = await imageDataUrl(640, 300);
  await validateRunpodImageRequirements(klingWorkflow, [first, last]);
});

test("rejects a Kling frame below the minimum dimensions before submission", async () => {
  const first = await imageDataUrl(640, 360);
  const last = await imageDataUrl(640, 211);
  await assert.rejects(
    () => validateRunpodImageRequirements(klingWorkflow, [first, last]),
    /last frame must be at least 300px wide and high; received 640x211px.*not sent to RunPod/i,
  );
});

test("checks saved local media and rejects unverifiable remote Kling frames", async () => {
  const localPath = path.join(tempRoot, "first.png");
  await sharp({ create: { width: 400, height: 299, channels: 3, background: "white" } }).png().toFile(localPath);
  const localUrl = `/api/media?path=${encodeURIComponent(localPath)}`;

  await assert.rejects(
    () => validateRunpodImageRequirements(klingWorkflow, [localUrl, localUrl]),
    /first frame must be at least 300px wide and high; received 400x299px/i,
  );
  await assert.rejects(
    () => validateRunpodImageRequirements(klingWorkflow, ["https://cdn.example/first.png", "https://cdn.example/last.png"]),
    /dimensions cannot be verified safely.*not sent to RunPod/i,
  );
});

test("rejects Kling frames outside the 0.40 to 2.50 aspect-ratio range", async () => {
  const valid = await imageDataUrl(400, 1000);
  const tooNarrow = await imageDataUrl(390, 1000);
  const tooWide = await imageDataUrl(2510, 1000);

  await validateRunpodImageRequirements(klingWorkflow, [valid, valid]);
  await assert.rejects(
    () => validateRunpodImageRequirements(klingWorkflow, [tooNarrow, valid]),
    /first frame aspect ratio must be between 0\.40 and 2\.50.*received 0\.39 from 390x1000px.*not sent to RunPod/i,
  );
  await assert.rejects(
    () => validateRunpodImageRequirements(klingWorkflow, [valid, tooWide]),
    /last frame aspect ratio must be between 0\.40 and 2\.50.*received 2\.51 from 2510x1000px/i,
  );
});

test("does not impose Kling requirements on other workflows", async () => {
  await validateRunpodImageRequirements({ "1": { class_type: "LoadImage" } }, ["https://cdn.example/tiny.png"]);
});

async function imageDataUrl(width: number, height: number) {
  const buffer = await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
