import assert from "node:assert/strict";
import test from "node:test";

import type { ComfyNode } from "./comfyGraph.js";
import {
  applySeedanceModelInputs,
  DEFAULT_SEEDANCE_VERSION,
  seedanceDurations,
  seedanceEffectiveModel,
  seedanceSupportsRatio,
  seedanceVersion,
  seedanceVersionIdFromOptions,
  seedanceVersions,
} from "./seedanceVersions.js";
import type { ModelCategory, WorkflowModel } from "./types.js";

/**
 * The version table is what both sides read, so these assert the *rules* rather
 * than the numbers -- the numbers are transcribed from GET /object_info on the
 * ComfyUI the workers run.
 *
 * The frontend mirrors the same expectations in
 * src/features/generation/seedanceVersions.test.ts, because the two packages can
 * share the JSON but not the code that interprets it.
 */

function model(category: ModelCategory, id = "brick_api_seedance2_0_i2v"): WorkflowModel {
  return {
    id,
    name: "Api Seedance2 0 I2v",
    category,
    workflowPath: `C:/Momi-Animation/workflow/i2v/${id}.json`,
    requiredInputs: ["prompt", "single_image"],
    supportedResolutions: ["720p", "1080p", "4K"],
    defaultResolution: "1080p",
    supportedDurations: [4, 5, 6],
    defaultDurationSeconds: 5,
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    outputType: "video",
  };
}

test("the shipped table describes exactly the two versions the picker offers", () => {
  assert.deepEqual(
    seedanceVersions.map((version) => version.id),
    ["2.0", "2.5"],
  );
  assert.equal(DEFAULT_SEEDANCE_VERSION, "2.0");
});

test("2.5 raises the duration ceiling and gives up 4K", () => {
  const twoZero = seedanceVersion("2.0");
  const twoFive = seedanceVersion("2.5");

  // 480p is on both combos; 4K is the only resolution the versions disagree about.
  assert.deepEqual(twoZero.resolutions, ["480p", "720p", "1080p", "4K"]);
  assert.deepEqual(twoFive.resolutions, ["480p", "720p", "1080p"]);
  assert.equal(seedanceDurations(twoZero).at(-1), 15);
  assert.equal(seedanceDurations(twoFive).at(-1), 30);
  assert.equal(seedanceDurations(twoFive).at(0), 4);
  assert.equal(twoZero.outputFormat, null);
  assert.equal(twoFive.outputFormat, "mp4");
  assert.equal(twoZero.supportsVideoEditing, false);
  assert.equal(twoFive.supportsVideoEditing, true);
});

test("an unknown or missing version reads as the default rather than throwing", () => {
  assert.equal(seedanceVersion("3.0").id, DEFAULT_SEEDANCE_VERSION);
  assert.equal(seedanceVersion(undefined).id, DEFAULT_SEEDANCE_VERSION);
  assert.equal(seedanceVersionIdFromOptions(undefined), DEFAULT_SEEDANCE_VERSION);
  assert.equal(seedanceVersionIdFromOptions({ seedance: { version: "2.5" } }), "2.5");
  assert.equal(seedanceVersionIdFromOptions({ seedance: { version: "banana" } }), DEFAULT_SEEDANCE_VERSION);
});

test("only 2.5's first-last-frame node lacks a ratio input", () => {
  const reference = model("image_to_video");
  const firstLast = model("first_last_frame_to_video", "brick_api_seedance_2_0flf2v");

  assert.equal(seedanceSupportsRatio(reference, seedanceVersion("2.0")), true);
  assert.equal(seedanceSupportsRatio(reference, seedanceVersion("2.5")), true);
  assert.equal(seedanceSupportsRatio(firstLast, seedanceVersion("2.0")), true);
  assert.equal(seedanceSupportsRatio(firstLast, seedanceVersion("2.5")), false);
});

test("a non-Seedance model has no Seedance ratio and is not re-limited", () => {
  const kling: WorkflowModel = { ...model("image_to_video", "brick_api_kling_v3_video"), name: "Api Kling V3 Video" };
  assert.equal(seedanceSupportsRatio(kling, seedanceVersion("2.5")), false);
  assert.deepEqual(seedanceEffectiveModel(kling, { seedance: { version: "2.5" } }), kling);
});

test("the effective model carries the picked version's limits, not the workflow file's", () => {
  const reference = model("image_to_video");

  const twoZero = seedanceEffectiveModel(reference, { seedance: { version: "2.0" } });
  assert.deepEqual(twoZero.supportedResolutions, ["480p", "720p", "1080p", "4K"]);
  assert.equal(twoZero.supportedDurations?.at(-1), 15);
  // The file's own default survives when the version still offers it.
  assert.equal(twoZero.defaultDurationSeconds, 5);
  assert.equal(twoZero.defaultResolution, "1080p");

  const twoFive = seedanceEffectiveModel(reference, { seedance: { version: "2.5" } });
  assert.deepEqual(twoFive.supportedResolutions, ["480p", "720p", "1080p"]);
  assert.equal(twoFive.supportedDurations?.at(-1), 30);

  // A model whose file default the version cannot produce falls back to the
  // version's own, rather than keeping a duration the node would refuse.
  const longDefault = { ...reference, defaultDurationSeconds: 20 };
  assert.equal(seedanceEffectiveModel(longDefault, { seedance: { version: "2.0" } }).defaultDurationSeconds, 5);
  assert.equal(seedanceEffectiveModel(longDefault, { seedance: { version: "2.5" } }).defaultDurationSeconds, 20);
});

test("2.5 writes the inputs its option requires and clears 2.0's", () => {
  const inputs: ComfyNode = {
    model: "Seedance 2.0",
    "model.prompt": "",
    "model.resolution": "1080p",
    "model.ratio": "16:9",
    "model.duration": 5,
    "model.generate_audio": true,
  };
  applySeedanceModelInputs(inputs, model("video_editing", "brick_api_seedance2_0_r2v"), {
    seedance: { version: "2.5", ratio: "3:4", videoEditing: true },
  });

  assert.equal(inputs.model, "Seedance 2.5");
  assert.equal(inputs["model.ratio"], "3:4");
  assert.equal(inputs["model.output_format"], "mp4");
  assert.equal(inputs["model.video_editing"], true);
});

test("a 2.5 reference job still sends video_editing when nobody asked for it", () => {
  // The 2.5 option declares it required whether or not a clip is connected, so
  // leaving it out fails validation before the render starts.
  const inputs: ComfyNode = { model: "Seedance 2.0", "model.ratio": "16:9" };
  applySeedanceModelInputs(inputs, model("image_to_video"), { seedance: { version: "2.5" } });

  assert.equal(inputs["model.video_editing"], false);
});

test("switching back to 2.0 removes the keys 2.0 has no input for", () => {
  const inputs: ComfyNode = {
    model: "Seedance 2.5",
    "model.ratio": "16:9",
    "model.output_format": "mp4",
    "model.video_editing": true,
  };
  applySeedanceModelInputs(inputs, model("video_editing", "brick_api_seedance2_0_r2v"), {
    seedance: { version: "2.0", ratio: "1:1" },
  });

  assert.equal(inputs.model, "Seedance 2.0");
  assert.equal(inputs["model.ratio"], "1:1");
  assert.ok(!("model.output_format" in inputs));
  assert.ok(!("model.video_editing" in inputs));
});

test("2.5 first-last-frame loses the ratio and never gains an edit switch", () => {
  const inputs: ComfyNode = { model: "Seedance 2.0", "model.ratio": "16:9", "model.duration": 7 };
  applySeedanceModelInputs(inputs, model("first_last_frame_to_video", "brick_api_seedance_2_0flf2v"), {
    seedance: { version: "2.5", ratio: "9:16", videoEditing: true },
  });

  assert.ok(!("model.ratio" in inputs));
  assert.ok(!("model.video_editing" in inputs));
  assert.equal(inputs["model.output_format"], "mp4");
});

test("a graph spelling the ratio without the model prefix keeps its own spelling", () => {
  const inputs: ComfyNode = { model: "Seedance 2.0", ratio: "16:9" };
  applySeedanceModelInputs(inputs, model("image_to_video"), { seedance: { version: "2.0", ratio: "21:9" } });

  assert.equal(inputs.ratio, "21:9");
  assert.ok(!("model.ratio" in inputs), "A second, ignored key would be left behind.");
});

test("an unrecognised ratio keeps whatever the workflow was saved with", () => {
  const inputs: ComfyNode = { model: "Seedance 2.0", "model.ratio": "4:3" };
  applySeedanceModelInputs(inputs, model("image_to_video"), { seedance: { version: "2.0", ratio: "banana:9" } });

  assert.equal(inputs["model.ratio"], "4:3");
});

test("no Seedance options at all leaves the node untouched", () => {
  // Jobs recorded before the picker existed, and clients that send no options, ran
  // on the graph as saved. Imposing a default here would change what they produce.
  const inputs: ComfyNode = { model: "Seedance 2.0", "model.ratio": "4:3" };
  applySeedanceModelInputs(inputs, model("image_to_video"), { save: { shotNumber: "0001" } });

  assert.deepEqual(inputs, { model: "Seedance 2.0", "model.ratio": "4:3" });
});
