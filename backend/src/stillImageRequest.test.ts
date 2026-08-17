import test from "node:test";
import assert from "node:assert/strict";

import { assertStillImageInputs, normalizeStillImageOptions } from "./stillImageRequest.js";
import { isStillImageSeed, STILL_IMAGE_MAX_SEED } from "./stillImageSeed.js";

// These settings become ComfyUI node parameters. Anything that gets through here
// unchecked either fails deep inside a graph, where the error means nothing to an
// artist, or renders at a strength nobody chose.

/** A fixed master seed, so a whole-object assertion is not racing randomness. */
const mintSeed = () => 4242;

test("fills every visible setting from the catalogue defaults", () => {
  const options = normalizeStillImageOptions({ categoryId: "pro-upscaler" }, mintSeed);
  assert.deepEqual(options, {
    categoryId: "pro-upscaler",
    seed: 4242,
    settings: { engine: "normal", upscale: "x2", enhancement: true, creativity: 30 },
  });
});

test("a missing settings object is the same as an empty one", () => {
  assert.deepEqual(
    normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: {} }, mintSeed),
    normalizeStillImageOptions({ categoryId: "pro-upscaler" }, mintSeed),
  );
});

// -- seeds -------------------------------------------------------------------
//
// The seed is what makes a result reproducible: it is persisted on the job, shown
// on the card, and sent back to render the same take again. A request that came
// away without one would be a render nobody could repeat.

test("mints a seed when the caller does not name one", () => {
  const options = normalizeStillImageOptions({ categoryId: "qwen-edit" });
  assert.equal(isStillImageSeed(options.seed), true, `minted seed out of range: ${options.seed}`);
});

test("keeps a caller's seed, which is how a result is reproduced", () => {
  const options = normalizeStillImageOptions({ categoryId: "qwen-edit", seed: 1234 }, mintSeed);
  assert.equal(options.seed, 1234);
});

test("seed 0 is a seed, not a missing one", () => {
  // Falsy but valid. Treating it as absent would silently re-roll the one seed an
  // artist is most likely to type by hand.
  assert.equal(normalizeStillImageOptions({ categoryId: "qwen-edit", seed: 0 }, mintSeed).seed, 0);
});

test("rejects a seed that is not a whole number in range", () => {
  for (const seed of [-1, 1.5, STILL_IMAGE_MAX_SEED + 1, "1234", null]) {
    assert.throws(
      () => normalizeStillImageOptions({ categoryId: "qwen-edit", seed }, mintSeed),
      /seed must be a whole number/,
      `accepted ${JSON.stringify(seed)}`,
    );
  }
});

test("caller values override defaults", () => {
  const options = normalizeStillImageOptions({
    categoryId: "pro-upscaler",
    settings: { engine: "super-fast", upscale: "x4", creativity: 40 },
  });
  assert.deepEqual(options.settings, { engine: "super-fast", upscale: "x4", enhancement: true, creativity: 40 });
});

test("hidden settings are dropped, not passed through", () => {
  // The form keeps every setting in state whether or not it is on screen, so a
  // well-behaved client does send these. They must not reach the graph: the
  // artist could not see the value they would be rendering with.
  const options = normalizeStillImageOptions({
    categoryId: "pro-upscaler",
    settings: { enhancement: false, creativity: 40 },
  });
  assert.deepEqual(options.settings, { engine: "normal", upscale: "x2", enhancement: false });
  assert.equal("creativity" in options.settings, false);
});

test("visibility is resolved from the full merged map, not just what was sent", () => {
  // generalEnhance is left out here. Its default is true, so generalDenoise is
  // visible -- reading visibility off the caller's partial map would have hidden
  // it and silently dropped the denoise value.
  const options = normalizeStillImageOptions({
    categoryId: "general-enhancement",
    settings: { generalDenoise: 0.3 },
  });
  assert.equal(options.settings.generalDenoise, 0.3);
  assert.equal(options.settings.generalEnhance, true);
});

test("advanced detail settings appear only once advancedDetails is on", () => {
  const off = normalizeStillImageOptions({ categoryId: "general-enhancement", settings: { advancedDetails: false } });
  assert.equal("sharpen" in off.settings, false);
  assert.equal("detailPass" in off.settings, false);

  const on = normalizeStillImageOptions({ categoryId: "general-enhancement", settings: { advancedDetails: true } });
  assert.equal(on.settings.sharpen, 0.4);
  assert.equal(on.settings.detailPass, 0.35);
});

test("body enhancement settings appear only once bodyEnhance is on", () => {
  const off = normalizeStillImageOptions({ categoryId: "general-enhancement", settings: { bodyEnhance: false } });
  assert.equal("bodyDenoise" in off.settings, false);
  assert.equal("faceDenoise" in off.settings, false);

  const on = normalizeStillImageOptions({ categoryId: "general-enhancement", settings: { bodyEnhance: true } });
  assert.equal(on.settings.bodyDenoise, 0.2);
  assert.equal(on.settings.faceDenoise, 0.2);
});

test("body and face denoise are bounded to the forge range", () => {
  // forge clamps both to 0.0-0.3. A value past that drives the FaceDetailerPipe
  // nodes harder than the workflow was tuned for.
  const at = (bodyDenoise: unknown) => () =>
    normalizeStillImageOptions({ categoryId: "general-enhancement", settings: { bodyEnhance: true, bodyDenoise } });

  assert.throws(at(0.31), /must be between 0 and 0.3/);
  assert.throws(at(-0.01), /must be between 0 and 0.3/);
  assert.equal(
    normalizeStillImageOptions({
      categoryId: "general-enhancement",
      settings: { bodyEnhance: true, bodyDenoise: 0.3, faceDenoise: 0 },
    }).settings.bodyDenoise,
    0.3,
  );
});

test("all three general enhancement branches can be on at once", () => {
  // Case 7 of forge's routing matrix -- the combination that exercises every knob.
  const options = normalizeStillImageOptions({
    categoryId: "general-enhancement",
    settings: { generalEnhance: true, advancedDetails: true, bodyEnhance: true },
  });
  assert.deepEqual(Object.keys(options.settings).sort(), [
    "advancedDetails",
    "bodyDenoise",
    "bodyEnhance",
    "detailPass",
    "details",
    "faceDenoise",
    "generalDenoise",
    "generalEnhance",
    "sharpen",
  ]);
});

test("rejects an unknown preset", () => {
  assert.throws(() => normalizeStillImageOptions({ categoryId: "image_editing" }), /not a known still image preset/);
  assert.throws(() => normalizeStillImageOptions({}), /not a known still image preset/);
});

test("rejects an unknown setting id rather than ignoring it", () => {
  // A typo that is silently dropped renders at the default and looks like the
  // slider did nothing.
  assert.throws(
    () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { creativityy: 30 } }),
    /Unsupported pro-upscaler setting: creativityy/,
  );
});

test("rejects a setting borrowed from another preset", () => {
  assert.throws(
    () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { sharpen: 0.5 } }),
    /Unsupported pro-upscaler setting: sharpen/,
  );
});

test("range values must be numbers inside the catalogue bounds", () => {
  const at = (creativity: unknown) => () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { creativity } });

  assert.throws(at(9), /must be between 10 and 40/);
  assert.throws(at(41), /must be between 10 and 40/);
  assert.throws(at("30"), /must be a number/);
  assert.throws(at(Number.NaN), /must be a number/);
  assert.throws(at(Number.POSITIVE_INFINITY), /must be a number/);
  assert.throws(at(null), /must be a number/);

  // The bounds themselves are valid.
  assert.equal(normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { creativity: 10 } }).settings.creativity, 10);
  assert.equal(normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { creativity: 40 } }).settings.creativity, 40);
});

test("off-grid range values are accepted", () => {
  // step is a slider affordance, not a constraint. Rejecting 0.39999999999999997
  // for missing the 0.01 grid would fail honest requests over float arithmetic.
  const options = normalizeStillImageOptions({
    categoryId: "general-enhancement",
    settings: { advancedDetails: true, sharpen: 0.39999999999999997 },
  });
  assert.equal(options.settings.sharpen, 0.39999999999999997);
});

test("select values must be one of the catalogue options", () => {
  assert.throws(
    () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { upscale: "x8" } }),
    /must be one of: x2, x4/,
  );
  assert.throws(
    () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { upscale: 2 } }),
    /must be one of: x2, x4/,
  );
});

test("checkbox values must be booleans, not truthy strings", () => {
  assert.throws(
    () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { enhancement: "true" } }),
    /must be true or false/,
  );
  assert.throws(
    () => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: { enhancement: 1 } }),
    /must be true or false/,
  );
});

test("rejects non-object payloads", () => {
  assert.throws(() => normalizeStillImageOptions(null), /must be an object/);
  assert.throws(() => normalizeStillImageOptions("qwen-edit"), /must be an object/);
  assert.throws(() => normalizeStillImageOptions([]), /must be an object/);
  assert.throws(() => normalizeStillImageOptions({ categoryId: "pro-upscaler", settings: [] }), /must be an object/);
});

// -- input rules -------------------------------------------------------------

const upscaler = normalizeStillImageOptions({ categoryId: "pro-upscaler" });
const referenceGenerator = normalizeStillImageOptions({ categoryId: "reference-generator" });

test("image count must match the preset's slot count exactly", () => {
  assert.doesNotThrow(() => assertStillImageInputs(upscaler, { inputImages: ["a.png"] }));

  assert.throws(() => assertStillImageInputs(upscaler, { inputImages: [] }), /needs exactly 1 input image; received 0/);
  assert.throws(
    () => assertStillImageInputs(upscaler, { inputImages: ["a.png", "b.png"] }),
    /needs exactly 1 input image; received 2/,
  );
  assert.throws(() => assertStillImageInputs(upscaler, {}), /needs exactly 1 input image; received 0/);
});

test("reference generator needs both the main and the reference image", () => {
  assert.doesNotThrow(() => assertStillImageInputs(referenceGenerator, { inputImages: ["main.png", "ref.png"] }));
  assert.throws(
    () => assertStillImageInputs(referenceGenerator, { inputImages: ["main.png"] }),
    /needs exactly 2 input images; received 1/,
  );
});

test("qwen edit's slot count follows its mode and image count", () => {
  const threeUp = normalizeStillImageOptions({ categoryId: "qwen-edit", settings: { mode: "edit", imageCount: "3" } });
  assert.doesNotThrow(() => assertStillImageInputs(threeUp, { inputImages: ["a", "b", "c"], prompt: "warmer light" }));
  assert.throws(() => assertStillImageInputs(threeUp, { inputImages: ["a", "b"] }), /needs exactly 3 input images/);

  const transfer = normalizeStillImageOptions({ categoryId: "qwen-edit", settings: { mode: "reference-transfer" } });
  assert.doesNotThrow(() => assertStillImageInputs(transfer, { inputImages: ["main", "ref"] }));
  assert.throws(() => assertStillImageInputs(transfer, { inputImages: ["main"] }), /needs exactly 2 input images/);
});

test("a prompt is refused by presets that have no prompt field", () => {
  assert.throws(
    () => assertStillImageInputs(upscaler, { inputImages: ["a.png"], prompt: "make it pretty" }),
    /does not take a prompt/,
  );

  const transfer = normalizeStillImageOptions({ categoryId: "qwen-edit", settings: { mode: "reference-transfer" } });
  assert.throws(
    () => assertStillImageInputs(transfer, { inputImages: ["main", "ref"], prompt: "warmer" }),
    /does not take a prompt/,
  );

  // Whitespace is not a prompt, and the form sends "" for an untouched field.
  assert.doesNotThrow(() => assertStillImageInputs(upscaler, { inputImages: ["a.png"], prompt: "   " }));
  assert.doesNotThrow(() => assertStillImageInputs(upscaler, { inputImages: ["a.png"], prompt: "" }));
});

test("a prompt is optional for the presets that do take one", () => {
  const general = normalizeStillImageOptions({ categoryId: "general-enhancement" });
  assert.doesNotThrow(() => assertStillImageInputs(general, { inputImages: ["a.png"] }));
  assert.doesNotThrow(() => assertStillImageInputs(general, { inputImages: ["a.png"], prompt: "keep the brick texture" }));
});

test("animation-only media is refused", () => {
  assert.throws(() => assertStillImageInputs(upscaler, { inputImages: ["a.png"], startFrame: "s.png" }), /start or end frames/);
  assert.throws(() => assertStillImageInputs(upscaler, { inputImages: ["a.png"], endFrame: "e.png" }), /start or end frames/);
  assert.throws(() => assertStillImageInputs(upscaler, { inputImages: ["a.png"], inputVideo: "v.mp4" }), /input video/);
});
