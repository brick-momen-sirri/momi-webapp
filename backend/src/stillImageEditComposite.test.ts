import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { uploadedMediaRoot } from "./config.js";
import { compositeStillImageEditResult, renderStillImageEditComposite } from "./stillImageEditComposite.js";
import type { Job } from "./types.js";

test("a generated crop is preserved as a layer and composited into the original", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-composite-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "result.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(mask, 20, 20, { r: 255, g: 255, b: 255 });
  await solid(target, 20, 20, { r: 255, g: 0, b: 0 });

  const crop = { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 };
  const job = {
    workflowOptions: {
      stillImage: {
        categoryId: "image-editing",
        settings: {},
        edit: {
          layerId: "edit_12345678",
          operation: "create",
          mode: "inpaint",
          documentId: "editdoc_12345678",
          crop,
          mask: { width: 100, height: 80, softness: 0, strokes: [] },
          originalSourceUrl: mediaUrl(original),
          maskSourceUrl: mediaUrl(mask),
          baseLayerIds: [],
          baseLayers: [],
          referenceSourceUrls: [],
        },
      },
    },
  } as Job;

  const result = await compositeStillImageEditResult(job, target);
  assert.ok(result);
  assert.equal(job.workflowOptions?.stillImage?.edit?.generatedCropUrl, result.generatedCropUrl);
  assert.deepEqual((await sharp(target).metadata()).width, 100);
  assert.deepEqual(await pixel(target, 5, 5), [0, 0, 255, 255]);
  assert.deepEqual(await pixel(target, 15, 20), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(result.generatedCropPath, 5, 5), [255, 0, 0, 255]);
});

test("finalization composites every visible layer in order at the original resolution", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-final-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const firstCrop = path.join(directory, "first.png");
  const secondCrop = path.join(directory, "second.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(firstCrop, 20, 20, { r: 255, g: 0, b: 0 });
  await solid(secondCrop, 20, 20, { r: 0, g: 255, b: 0 });
  await solid(mask, 20, 20, { r: 255, g: 255, b: 255 });

  const metadata = await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "first",
        crop: { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(firstCrop),
        maskSourceUrl: mediaUrl(mask),
      },
      {
        layerId: "second",
        crop: { x: 15, y: 20, size: 20, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(secondCrop),
        maskSourceUrl: mediaUrl(mask),
      },
    ],
    target,
  );

  assert.deepEqual(metadata, { width: 100, height: 80 });
  assert.deepEqual(await pixel(target, 12, 18), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(target, 18, 23), [0, 255, 0, 255]);
  assert.deepEqual(await pixel(target, 5, 5), [0, 0, 255, 255]);
});

async function solid(filePath: string, width: number, height: number, background: { r: number; g: number; b: number }) {
  await sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toFile(filePath);
}

async function pixel(filePath: string, left: number, top: number) {
  const { data } = await sharp(filePath)
    .ensureAlpha()
    .extract({ left, top, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Array.from(data);
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}
