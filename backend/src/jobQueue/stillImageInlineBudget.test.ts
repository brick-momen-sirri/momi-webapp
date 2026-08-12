// The over-budget half of the base64 policy: what happens when compression cannot
// get an image inside the request limit.
//
// A separate file because config.ts reads its env once at module load, and this
// needs a far smaller inline budget than the rest of the materializer tests. 512
// bytes is below anything the compression ladder can produce for real image
// content, so the "compressed as far as possible and still too big" branch is
// reached deterministically rather than by guessing at a huge fixture.
process.env.RUNPOD_ENDPOINT_ID = "still-budget-endpoint";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
process.env.RUNPOD_INLINE_MEDIA_MAX_BYTES = "512";
process.env.RUNPOD_INPUT_BASE_URL = "";
process.env.PUBLIC_API_BASE_URL = "";

import test from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

const { materializeStillImageInputs } = await import("./stillImageInputMaterializer.js");

async function noisyPngDataUrl(size: number) {
  const channels = 3 as const;
  const raw = Buffer.alloc(size * size * channels);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 2654435761) % 256;
  const png = await sharp(raw, { raw: { width: size, height: size, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("an image that cannot be compressed under budget fails before submission", async () => {
  const image = await noisyPngDataUrl(600);

  await assert.rejects(
    () =>
      materializeStillImageInputs({
        categoryId: "general-enhancement",
        imageCount: 1,
        inputImages: [image],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /requires inline image data/);
      assert.match(error.message, /too large for the RunPod request limit/);
      assert.match(error.message, /use a smaller image/i);
      // The generic helper's advice about configuring a signed URL base must not
      // survive into this message: a base64 node cannot take a URL, so pointing an
      // operator at RUNPOD_INPUT_BASE_URL would send them somewhere useless.
      assert.doesNotMatch(error.message, /RUNPOD_INPUT_BASE_URL/);
      return true;
    },
  );
});

test("the failure carries the measured sizes so it is actionable", async () => {
  const image = await noisyPngDataUrl(600);
  await assert.rejects(
    () => materializeStillImageInputs({ categoryId: "general-enhancement", imageCount: 1, inputImages: [image] }),
    /MiB|KiB|above the/,
  );
});

test("no signed URL is substituted even though the image is over budget", async () => {
  // The mutation check for the URL guard under pressure. The Animation path's
  // reaction to an over-budget image is to fall back to a URL; for a base64 node
  // that has to be a local failure instead.
  const image = await noisyPngDataUrl(600);
  let result: Awaited<ReturnType<typeof materializeStillImageInputs>> | undefined;
  try {
    result = await materializeStillImageInputs({
      categoryId: "general-enhancement",
      imageCount: 1,
      inputImages: [image],
    });
  } catch {
    // Expected.
  }
  assert.equal(result, undefined, "materialization must not succeed by degrading to a URL");
});

test("a small image still succeeds under the tightened budget", async () => {
  // Guards against the budget check being so aggressive it rejects everything,
  // which would make the assertions above pass for the wrong reason.
  const channels = 3 as const;
  const tiny = await sharp(Buffer.alloc(4 * 4 * channels), { raw: { width: 4, height: 4, channels } })
    .png()
    .toBuffer();
  const result = await materializeStillImageInputs({
    categoryId: "general-enhancement",
    imageCount: 1,
    inputImages: [`data:image/png;base64,${tiny.toString("base64")}`],
  });
  assert.equal(result.graphValues.length, 1);
  assert.equal(result.payloadImages.length, 0);
});
