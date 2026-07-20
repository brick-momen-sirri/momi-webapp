import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { chooseRunpodImageInputNames, isRemoteResultMediaUrl, jobRemoteMediaEntries } from "./jobQueue.js";
import {
  prepareRunpodInlineImageInput,
  runpodInlineImageByteBudget,
} from "./runpodImageInlineService.js";

test("RunPod image input names stay unique when workflow placeholders repeat", () => {
  const names = chooseRunpodImageInputNames(
    [
      "data:image/png;base64,AA==",
      "data:image/jpeg;base64,AA==",
    ],
    "job_test",
    ["0001.png", "0001.png", "0001.png", "0001.png"],
  );

  assert.deepEqual(names, ["0001.png", "job_test_2.jpg"]);
});

test("RunPod image input names keep distinct workflow placeholders", () => {
  const names = chooseRunpodImageInputNames(
    [
      "data:image/png;base64,AA==",
      "data:image/jpeg;base64,AA==",
    ],
    "job_test",
    ["image_a.png", "image_b.jpg"],
  );

  assert.deepEqual(names, ["image_a.png", "image_b.jpg"]);
});

test("remote result media urls are detected regardless of scheme and whitespace", () => {
  assert.equal(isRemoteResultMediaUrl("https://cdn.runpod.io/output/clip.mp4"), true);
  assert.equal(isRemoteResultMediaUrl("http://example.com/frame.png"), true);
  assert.equal(isRemoteResultMediaUrl("  https://example.com/frame.png  "), true);
  assert.equal(isRemoteResultMediaUrl("/api/media?path=C%3A%5Cout%5Cclip.mp4"), false);
  assert.equal(isRemoteResultMediaUrl("[embedded data URL omitted]"), false);
});

test("jobRemoteMediaEntries flags only remote urls on completed jobs", () => {
  const entries = jobRemoteMediaEntries({
    status: "completed",
    resultUrls: ["/api/media?path=local.mp4", "https://cdn.runpod.io/clip.mp4"],
    thumbnailUrls: ["https://cdn.runpod.io/thumb.png"],
  });

  assert.deepEqual(entries, [
    { kind: "result", index: 1, url: "https://cdn.runpod.io/clip.mp4" },
    { kind: "thumbnail", index: 0, url: "https://cdn.runpod.io/thumb.png" },
  ]);
});

test("jobRemoteMediaEntries ignores jobs that are not completed or are fully local", () => {
  assert.deepEqual(
    jobRemoteMediaEntries({
      status: "running",
      resultUrls: ["https://cdn.runpod.io/clip.mp4"],
      thumbnailUrls: [],
    }),
    [],
  );

  assert.deepEqual(
    jobRemoteMediaEntries({
      status: "completed",
      resultUrls: ["/api/media?path=local.mp4"],
      thumbnailUrls: ["/api/media?path=thumb.png"],
    }),
    [],
  );
});

test("RunPod inline image budget shrinks as image input count grows", () => {
  const oneImageBudget = runpodInlineImageByteBudget(1);
  const twoImageBudget = runpodInlineImageByteBudget(2);
  const fourImageBudget = runpodInlineImageByteBudget(4);

  assert.ok(oneImageBudget > twoImageBudget);
  assert.ok(twoImageBudget > fourImageBudget);
});

test("oversized RunPod inline images are compressed below their JSON budget", async () => {
  const width = 512;
  const height = 512;
  const noisyPng = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();

  const prepared = await prepareRunpodInlineImageInput({
    buffer: noisyPng,
    mimeType: "image/png",
    name: "input.png",
    source: "input.png",
    maxBytes: 80 * 1024,
  });

  assert.equal(prepared.name, "input.jpg");
  assert.match(prepared.image, /^data:image\/jpeg;base64,/);
  assert.ok(prepared.byteLength <= 80 * 1024);
  assert.ok(prepared.compressed);
});
