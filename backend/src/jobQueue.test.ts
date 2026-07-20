import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { chooseRunpodImageInputNames } from "./jobQueue.js";
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
