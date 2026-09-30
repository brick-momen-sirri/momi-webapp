import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import sharp from "sharp";

// A saved-media slot takes the URL branch only when the target pod can download
// it. On 2026-09-30 every Qwen Edit, Pro Upscaler and Flux Klein Upscaler job
// failed in the worker's input check because a { name, url } entry was sent to a
// handler that only reads { name, image }.

// realpath because the Windows temp dir can be an 8.3 short path: the media policy
// resolves the file to its long form, which then falls outside a short-form root.
const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "momi-still-url-inputs-")));
const uploadRoot = path.join(tempDir, "uploads");
await fs.mkdir(uploadRoot, { recursive: true });

process.env.UPLOADED_MEDIA_ROOT = uploadRoot;
process.env.LOCAL_PROJECTS_ROOT = path.join(tempDir, "projects");
process.env.BRICK_PROJECTS_ROOT = path.join(tempDir, "brick");
process.env.COMFY_ROOT = path.join(tempDir, "comfy");
// A signed input URL needs no network, so the URL branch is really reachable
// here; the bucket stays blank so nothing is ever uploaded from a unit test.
process.env.RUNPOD_INPUT_BASE_URL = "https://momi.test";
process.env.RUNPOD_INPUT_URL_SECRET = "input-url-secret-test";
process.env.RUNPOD_INPUT_BUCKET_ENDPOINT_URL = "";
process.env.RUNPOD_INPUT_BUCKET_ACCESS_KEY_ID = "";
process.env.RUNPOD_INPUT_BUCKET_SECRET_ACCESS_KEY = "";

const { materializeStillImageInputs } = await import("./stillImageInputMaterializer.js");

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function savedImage(name: string) {
  const filePath = path.join(uploadRoot, "prj_1", "usr_1", name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png()
    .toFile(filePath);
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

test("a dedicated pod receives inline image data, not a URL", async () => {
  const source = await savedImage("upscale-source.png");
  const result = await materializeStillImageInputs({ categoryId: "pro-upscaler", imageCount: 1, inputImages: [source] });

  const [entry] = result.payloadImages;
  assert.equal(entry.url, undefined, "the Pro Upscaler handler cannot fetch a URL");
  assert.ok(entry.image && entry.image.length > 0, "the bytes travel as `image`");
  assert.equal(result.graphValues[0], entry.name, "the graph reads the name the worker writes");
});

test("every Qwen Edit slot is inlined for its pod", async () => {
  const sources = await Promise.all([savedImage("q1.png"), savedImage("q2.png"), savedImage("q3.png")]);
  const result = await materializeStillImageInputs({ categoryId: "qwen-edit", imageCount: 3, inputImages: sources });

  assert.equal(result.payloadImages.length, 3);
  for (const entry of result.payloadImages) {
    assert.equal(entry.url, undefined);
    assert.ok(entry.image);
  }
});

test("an endpoint that downloads URLs still gets one", async () => {
  // Image Editing on the Animation endpoint: a signed URL sends the original
  // bytes, which is what spares a whole-image edit the inline JPEG re-encode.
  const source = await savedImage("edit-source.png");
  const result = await materializeStillImageInputs({
    categoryId: "image-editing",
    imageCount: 2,
    inputImages: [source, source],
    acceptsUrlInputs: true,
  });

  for (const entry of result.payloadImages) {
    assert.equal(entry.image, undefined);
    assert.match(entry.url ?? "", /^https:\/\/momi\.test\/api\/runpod-input\?token=/);
  }
  assert.deepEqual(result.graphValues, ["momi_still_01.png", "momi_still_02.png"]);
});
