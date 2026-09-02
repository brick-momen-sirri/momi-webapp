import test from "node:test";
import assert from "node:assert/strict";

import { STILL_IMAGE_CATEGORY_IDS } from "./stillImageCategories.js";
import {
  isStillImageModelId,
  stillImageCategoryIdFromModelId,
  stillImageModelId,
  stillImageWorkflowModel,
  stillImageWorkflowModels,
} from "./stillImageModels.js";
import { getWorkflowModel, getWorkflowModels, loadWorkflowModels } from "./workflowService.js";

test("every preset has a model, and the id round-trips to its category", () => {
  const models = stillImageWorkflowModels();
  assert.equal(models.length, STILL_IMAGE_CATEGORY_IDS.length);

  for (const categoryId of STILL_IMAGE_CATEGORY_IDS) {
    const id = stillImageModelId(categoryId);
    assert.equal(stillImageCategoryIdFromModelId(id), categoryId);
    assert.equal(isStillImageModelId(id), true);
    const model = stillImageWorkflowModel(id);
    assert.ok(model, `${categoryId} resolves`);
    assert.equal(model.outputType, "image");
    assert.equal(model.requiresImage, true);
    assert.equal(model.requiresStartEndFrames, false);
    assert.equal(model.requiresPrompt, false, "prompt rules belong to the preset, not the model");
    assert.ok((model.imageSlotCount ?? 0) >= 1);
    assert.ok(model.workflowPath.endsWith(`${categoryId}.json`));
  }
});

test("an animation model id is not mistaken for a preset", () => {
  assert.equal(stillImageCategoryIdFromModelId("brick_nano_banana_2"), undefined);
  assert.equal(isStillImageModelId("brick_nano_banana_2"), false);
  assert.equal(stillImageWorkflowModel("brick_nano_banana_2"), undefined);
  // Prefix present but the remainder is not a preset.
  assert.equal(stillImageWorkflowModel("still_not_a_preset"), undefined);
  assert.equal(isStillImageModelId("still_"), false);
});

test("models advertise their maximum graph slots", () => {
  assert.equal(stillImageWorkflowModel(stillImageModelId("qwen-edit"))?.imageSlotCount, 3);
  assert.equal(stillImageWorkflowModel(stillImageModelId("reference-generator"))?.imageSlotCount, 2);
  assert.equal(stillImageWorkflowModel(stillImageModelId("pro-upscaler"))?.imageSlotCount, 1);
  // Ordinary enhancement uses one input; the integrated editor activates the
  // graph's dormant second mask binding.
  assert.equal(stillImageWorkflowModel(stillImageModelId("general-enhancement"))?.imageSlotCount, 2);
});

test("presets carry no resolution or duration options", () => {
  // These take their size from the input image. Advertising options would let the
  // client send a resolution that the graph silently ignores.
  for (const model of stillImageWorkflowModels()) {
    assert.equal(model.supportedResolutions, undefined);
    assert.equal(model.supportedDurations, undefined);
    assert.equal(model.defaultDurationSeconds, undefined);
  }
});

test("presets resolve through getWorkflowModel but stay out of the animation list", async () => {
  // The whole point of the fallback: the job pipeline can look a preset up, while
  // GET /api/models -- the Animation picker -- never offers one.
  await loadWorkflowModels();
  const listed = getWorkflowModels().map((model) => model.id);

  for (const categoryId of STILL_IMAGE_CATEGORY_IDS) {
    const id = stillImageModelId(categoryId);
    assert.ok(getWorkflowModel(id), `${id} resolves for the job pipeline`);
    assert.equal(listed.includes(id), false, `${id} must not appear in the model list`);
  }

  assert.ok(listed.length > 0, "the animation list still loaded, so the assertion above means something");
});

test("credit estimates are positive and do not collide with an animation pricing rule", async () => {
  // estimateWorkflowCredits keys off substrings of id/name/category/workflowPath.
  // A preset whose path or name happened to contain "flux3", "kling", "seedance",
  // "nano banana" or "ref_transfer" would silently be priced as that provider.
  const { estimateWorkflowCredits } = await import("./creditEstimator.js");

  for (const model of stillImageWorkflowModels()) {
    const credits = estimateWorkflowCredits(model);
    if (model.id === "still_image-editing") {
      // The one preset with a deliberate rule of its own: it can be run through
      // either Nano Banana or GPT Image, whose rates differ several times over,
      // so a single flat figure on the model cannot answer for both.
      assert.ok(credits > 0, `${model.id} has a positive estimate`);
      continue;
    }
    assert.equal(credits, model.estimatedCredits, `${model.id} fell through to its own estimate`);
    assert.ok(credits > 0, `${model.id} has a positive estimate`);
  }
});
