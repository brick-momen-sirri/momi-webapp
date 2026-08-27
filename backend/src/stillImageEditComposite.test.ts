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

test("a 16:9 layer stays rectangular when it is composited", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-wide-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const cropImage = path.join(directory, "wide.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(cropImage, 32, 18, { r: 255, g: 0, b: 0 });
  await solid(mask, 32, 18, { r: 255, g: 255, b: 255 });

  await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "wide",
        crop: { x: 10, y: 15, size: 32, width: 32, height: 18, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
      },
    ],
    target,
  );

  assert.deepEqual(await pixel(target, 20, 20), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(target, 20, 40), [0, 0, 255, 255]);
});

test("only the masked part of a layer reaches the composite", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-partial-mask-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const cropImage = path.join(directory, "crop.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(cropImage, 20, 20, { r: 255, g: 0, b: 0 });
  // White on the left half, black on the right: the classic thing a layer mask is
  // for, and the case a chain that quietly dropped the mask would still pass
  // every fully-white-mask test around it.
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      {
        input: await sharp({ create: { width: 10, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toFile(mask);

  await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "half",
        crop: { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
      },
    ],
    target,
  );

  assert.deepEqual(await pixel(target, 12, 20), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(target, 27, 20), [0, 0, 255, 255]);
});

test("a moved layer lands at its displaced position and leaves the original spot alone", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-move-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const cropImage = path.join(directory, "crop.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(cropImage, 20, 20, { r: 255, g: 0, b: 0 });
  await solid(mask, 20, 20, { r: 255, g: 255, b: 255 });

  await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "moved",
        crop: { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
        offset: { x: 30, y: 10 },
      },
    ],
    target,
  );

  assert.deepEqual(await pixel(target, 45, 30), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(target, 15, 20), [0, 0, 255, 255]);
});

test("a faded layer blends with what is under it instead of replacing it", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-opacity-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const cropImage = path.join(directory, "crop.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(cropImage, 20, 20, { r: 255, g: 0, b: 0 });
  await solid(mask, 20, 20, { r: 255, g: 255, b: 255 });

  await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "faded",
        crop: { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
        opacity: 50,
      },
    ],
    target,
  );

  // Half red over full blue. The exact channel values depend on how sharp rounds
  // the scaled mask, so the assertion is that both colours are present at roughly
  // equal strength rather than a single pair of bytes.
  const [red, green, blue] = await pixel(target, 15, 20);
  assert.ok(Math.abs(red - 127) <= 3, `expected roughly half red, got ${red}`);
  assert.ok(Math.abs(blue - 128) <= 3, `expected roughly half blue, got ${blue}`);
  assert.equal(green, 0);
});

test("a fully transparent layer contributes nothing", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-hidden-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const cropImage = path.join(directory, "crop.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(cropImage, 20, 20, { r: 255, g: 0, b: 0 });
  await solid(mask, 20, 20, { r: 255, g: 255, b: 255 });

  await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "invisible",
        crop: { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 },
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
        opacity: 0,
      },
    ],
    target,
  );

  assert.deepEqual(await pixel(target, 15, 20), [0, 0, 255, 255]);
});

test("a layer dragged over the edge is clipped rather than refused", async (context) => {
  await fs.mkdir(uploadedMediaRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(uploadedMediaRoot, "edit-clip-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const original = path.join(directory, "original.png");
  const cropImage = path.join(directory, "crop.png");
  const mask = path.join(directory, "mask.png");
  const target = path.join(directory, "final.png");
  await solid(original, 100, 80, { r: 0, g: 0, b: 255 });
  await solid(cropImage, 20, 20, { r: 255, g: 0, b: 0 });
  await solid(mask, 20, 20, { r: 255, g: 255, b: 255 });

  const crop = { x: 10, y: 15, size: 20, sourceWidth: 100, sourceHeight: 80 };
  // Half over the right edge, and a second layer pushed off the canvas entirely.
  // Sharp rejects an overlay that does not fit, so both have to be handled here.
  await renderStillImageEditComposite(
    mediaUrl(original),
    [
      {
        layerId: "clipped",
        crop,
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
        offset: { x: 80, y: 0 },
      },
      {
        layerId: "gone",
        crop,
        generatedCropUrl: mediaUrl(cropImage),
        maskSourceUrl: mediaUrl(mask),
        offset: { x: -40, y: 0 },
      },
    ],
    target,
  );

  assert.deepEqual(await pixel(target, 95, 20), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(target, 5, 20), [0, 0, 255, 255]);
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
