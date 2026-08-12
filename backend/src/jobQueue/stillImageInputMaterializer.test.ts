process.env.RUNPOD_ENDPOINT_ID = "still-materializer-endpoint";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
// No public base URL, so the signed-URL branch is unavailable and every slot has
// to resolve through the inline path. That is the configuration these assertions
// are about.
process.env.RUNPOD_INPUT_BASE_URL = "";
process.env.PUBLIC_API_BASE_URL = "";

import test from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

const { materializeStillImageInputs, STILL_IMAGE_INLINE_TOO_LARGE_MESSAGE } = await import("./stillImageInputMaterializer.js");
const { stillImageSlotFilename } = await import("../stillImageWorkflow.js");

// The two bugs this module exists to prevent are both silent: a URL written into a
// base64 node fails deep inside ComfyUI with an unrelated message, and two slots
// sharing a filename means one image is quietly ignored. Several tests below are
// written as mutation checks -- they fail if the guard is removed, not just if the
// happy path breaks.

async function pngDataUrl(width: number, height: number, noisy = false) {
  const channels = 3 as const;
  const raw = Buffer.alloc(width * height * channels);
  if (noisy) {
    // Incompressible content, so a large image really is large after encoding
    // rather than collapsing to a few hundred bytes of flat colour.
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 2654435761) % 256;
  }
  const png = await sharp(raw, { raw: { width, height, channels } }).png({ compressionLevel: 0 }).toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const smallImage = await pngDataUrl(8, 8);

// -- base64 presets ----------------------------------------------------------

test("a base64 preset receives inline data, never a URL", async () => {
  const result = await materializeStillImageInputs({
    categoryId: "general-enhancement",
    imageCount: 1,
    inputImages: [smallImage],
  });

  assert.equal(result.payloadImages.length, 0, "base64 presets send nothing in the payload images array");
  assert.equal(result.graphValues.length, 1);

  const value = result.graphValues[0];
  assert.ok(value.length > 0);
  assert.equal(value.startsWith("data:"), false, "raw base64, not a data URL -- ETN_LoadImageBase64 wants the payload only");
  assert.equal(/^https?:\/\//i.test(value), false, "a URL must never reach a base64 node");
  // Round-trips as real image bytes.
  assert.ok(Buffer.from(value, "base64").byteLength > 0);
  assert.equal(Buffer.from(value, "base64").subarray(1, 4).toString("ascii"), "PNG");
});

test("both reference generator slots are inlined independently", async () => {
  const other = await pngDataUrl(10, 6);
  const result = await materializeStillImageInputs({
    categoryId: "reference-generator",
    imageCount: 2,
    inputImages: [smallImage, other],
  });

  assert.equal(result.graphValues.length, 2);
  assert.equal(result.payloadImages.length, 0);
  assert.notEqual(result.graphValues[0], result.graphValues[1], "each slot carries its own image");
});

test("an image under budget succeeds without compression changing it", async () => {
  const result = await materializeStillImageInputs({
    categoryId: "general-enhancement",
    imageCount: 1,
    inputImages: [smallImage],
  });
  const expected = smallImage.slice(smallImage.indexOf(",") + 1);
  assert.equal(result.graphValues[0], expected, "passed through untouched when it already fits");
});

test("an oversized image is compressed rather than rejected", async () => {
  // Well past the inline budget raw, but compressible to inside it, so the existing
  // downscale/quality ladder should rescue it.
  const large = await pngDataUrl(2600, 2600, true);
  const rawBytes = Buffer.from(large.slice(large.indexOf(",") + 1), "base64").byteLength;
  assert.ok(rawBytes > 6 * 1024 * 1024, `fixture should exceed the inline budget, was ${rawBytes}`);

  const result = await materializeStillImageInputs({
    categoryId: "general-enhancement",
    imageCount: 1,
    inputImages: [large],
  });

  const encodedBytes = Buffer.from(result.graphValues[0], "base64").byteLength;
  assert.ok(encodedBytes < rawBytes, "compression ran");
  assert.equal(result.payloadImages.length, 0, "still inline, not swapped for a URL");
});

// The over-budget failure needs a smaller inline budget than the rest of this file
// wants, and config.ts reads env once at module load, so it lives in
// stillImageInlineBudget.test.ts instead of fighting the module cache here.

test("the failure message is the documented one", () => {
  assert.equal(
    STILL_IMAGE_INLINE_TOO_LARGE_MESSAGE,
    "This Still Images workflow requires inline image data, but the image is too large for the RunPod request limit. Please use a smaller image.",
  );
});

test("a remote URL is refused for a base64 slot instead of being passed through", async () => {
  // The mutation check for the URL guard: the Animation path would happily return
  // { name, url } here, which is precisely what must not happen.
  await assert.rejects(
    () =>
      materializeStillImageInputs({
        categoryId: "general-enhancement",
        imageCount: 1,
        inputImages: ["https://cdn.example/photo.png"],
      }),
    /must be saved project media or an uploaded image; remote URLs cannot be inlined/,
  );
});

// -- load-image presets ------------------------------------------------------

test("qwen edit slots get unique deterministic filenames", async () => {
  const images = await Promise.all([pngDataUrl(8, 8), pngDataUrl(9, 9), pngDataUrl(10, 10)]);
  const result = await materializeStillImageInputs({
    categoryId: "qwen-edit",
    imageCount: 3,
    inputImages: images,
  });

  assert.deepEqual(result.graphValues, ["momi_still_01.png", "momi_still_02.png", "momi_still_03.png"]);
  assert.deepEqual(
    result.payloadImages.map((image) => image.name),
    ["momi_still_01.png", "momi_still_02.png", "momi_still_03.png"],
    "payload names match the graph values exactly",
  );
  assert.equal(new Set(result.graphValues).size, 3, "no collision");
});

test("slots 2 and 3 stay distinct despite identical values in the export", async () => {
  // The mutation check for the collision guard. qwen-edit.json was exported with
  // nodes 121 and 165 both holding "0001 (1).png"; deriving names from the graph
  // would give both slots the same destination and drop one image.
  const images = await Promise.all([pngDataUrl(8, 8), pngDataUrl(9, 9), pngDataUrl(10, 10)]);
  const result = await materializeStillImageInputs({ categoryId: "qwen-edit", imageCount: 3, inputImages: images });

  assert.notEqual(result.graphValues[1], result.graphValues[2]);
  for (const value of result.graphValues) {
    assert.doesNotMatch(value, /0001/, "the exported filename must not influence routing");
  }
});

test("slot order is preserved through materialization", async () => {
  const first = await pngDataUrl(4, 4);
  const second = await pngDataUrl(64, 64, true);
  const third = await pngDataUrl(16, 16);
  const result = await materializeStillImageInputs({
    categoryId: "qwen-edit",
    imageCount: 3,
    inputImages: [first, second, third],
  });

  // Slot n's bytes land in the payload entry named for slot n.
  const bytesFor = (name: string) => {
    const entry = result.payloadImages.find((image) => image.name === name);
    return Buffer.from(String(entry?.image).slice(String(entry?.image).indexOf(",") + 1), "base64").byteLength;
  };
  const sizes = [bytesFor("momi_still_01.png"), bytesFor("momi_still_02.png"), bytesFor("momi_still_03.png")];
  assert.ok(sizes[1] > sizes[0], "the larger middle image stayed in slot 2");
  assert.ok(sizes[1] > sizes[2]);
});

test("repeating the same job produces the same slot mapping", async () => {
  // Names come from the slot index alone, so a retry or a dispatcher failover
  // rebuilds an identical mapping with nothing persisted.
  const images = await Promise.all([pngDataUrl(8, 8), pngDataUrl(9, 9)]);
  const first = await materializeStillImageInputs({ categoryId: "qwen-edit", imageCount: 2, inputImages: images });
  const second = await materializeStillImageInputs({ categoryId: "qwen-edit", imageCount: 2, inputImages: images });

  assert.deepEqual(first.graphValues, second.graphValues);
  assert.deepEqual(
    first.payloadImages.map((image) => image.name),
    second.payloadImages.map((image) => image.name),
  );
});

test("fewer images means fewer slots, still starting at one", async () => {
  const result = await materializeStillImageInputs({
    categoryId: "qwen-edit",
    imageCount: 1,
    inputImages: [smallImage],
  });
  assert.deepEqual(result.graphValues, ["momi_still_01.png"]);
});

test("the pro upscaler slot uses the deterministic name, not the exported one", async () => {
  const result = await materializeStillImageInputs({
    categoryId: "pro-upscaler",
    imageCount: 1,
    inputImages: [smallImage],
  });
  assert.deepEqual(result.graphValues, ["momi_still_01.png"]);
  assert.doesNotMatch(result.graphValues[0], /ComfyUI_02127/, "the export's filename must not leak into routing");
});

test("user filenames cannot influence the destination name", async () => {
  const result = await materializeStillImageInputs({
    categoryId: "pro-upscaler",
    imageCount: 1,
    inputImages: [smallImage],
  });
  assert.equal(result.payloadImages[0].name, stillImageSlotFilename(1));
});

// -- shape and arity ---------------------------------------------------------

test("a slot count the preset cannot supply is a configuration error", async () => {
  await assert.rejects(
    () => materializeStillImageInputs({ categoryId: "pro-upscaler", imageCount: 2, inputImages: [smallImage, smallImage] }),
    /declares 1 input binding\(s\) but 2 were requested/,
  );
});

test("a mismatch between slots and job media is refused", async () => {
  await assert.rejects(
    () => materializeStillImageInputs({ categoryId: "reference-generator", imageCount: 2, inputImages: [smallImage] }),
    /needs 2 input image\(s\); the job carries 1/,
  );
});

test("an empty slot is refused rather than inlined as nothing", async () => {
  await assert.rejects(
    () => materializeStillImageInputs({ categoryId: "reference-generator", imageCount: 2, inputImages: [smallImage, ""] }),
    /has no media for slot 2/,
  );
});
