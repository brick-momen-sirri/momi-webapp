import assert from "node:assert/strict";
import test from "node:test";
import { estimateSeedanceCreditRange, estimateWorkflowCredits } from "./creditEstimator.js";

const seedanceFirstLast = {
  id: "brick_api_seedance2_0_flf2v",
  name: "Api Seedance 2.0 F2V",
  category: "first_last_frame_to_video" as const,
  workflowPath: "workflow/flf2v/Brick_api_Seedance 2.0flf2v.json",
  defaultDurationSeconds: 5,
};

const seedanceImageToVideo = {
  id: "brick_api_seedance2_0_i2v",
  name: "Api Seedance 2.0 I2V",
  category: "image_to_video" as const,
  workflowPath: "workflow/i2v/Brick_api_seedance2_0_i2v.json",
  defaultDurationSeconds: 5,
};

const seedanceReferenceToVideo = {
  id: "brick_api_seedance2_0_r2v",
  name: "Api Seedance 2.0 R2V",
  category: "video_editing" as const,
  workflowPath: "workflow/video_edit/Brick_api_seedance2_0_r2v.json",
  defaultDurationSeconds: 5,
};

const exteriorGridGenerator = {
  id: "brick_exteriorgrid_generator",
  name: "ExteriorGrid Generator",
  category: "image_editing" as const,
  workflowPath: "workflow/image_editing/Brick_ExteriorGrid_Generator.json",
  defaultDurationSeconds: 5,
  estimatedCredits: 4,
};

const nanoBanana = {
  id: "brick_nano_banana_2",
  name: "Nano Banana 2",
  category: "image_editing" as const,
  workflowPath: "workflow/image_editing/Brick_Nano Banana 2.json",
  defaultDurationSeconds: 5,
  estimatedCredits: 15,
};

const gptImage = {
  id: "brick_api_openai_gpt_image_2_i2i",
  name: "Api Openai Gpt Image 2 I2i",
  category: "image_editing" as const,
  workflowPath: "workflow/image_editing/Brick_api_openai_gpt_image_2_i2i.json",
  defaultDurationSeconds: 5,
  estimatedCredits: 141,
};

test("Seedance 2.0 first-last estimate uses Comfy price badge token formula", () => {
  assert.equal(
    estimateWorkflowCredits(seedanceFirstLast, 5, { width: 1280, height: 720, label: "720p" }),
    228,
  );
  assert.equal(
    estimateWorkflowCredits(seedanceFirstLast, 5, { width: 1920, height: 1080, label: "1080p" }),
    567,
  );
});

test("Seedance 2.0 image-to-video does not use the input-video range", () => {
  const range = estimateSeedanceCreditRange(seedanceImageToVideo, 5, { width: 1280, height: 720, label: "720p" });

  assert.equal(range.minCredits, 228);
  assert.equal(range.maxCredits, 228);
});

test("Seedance 2.0 reference-video edit exposes the conservative input-video range", () => {
  const range = estimateSeedanceCreditRange(seedanceReferenceToVideo, 5, { width: 1280, height: 720, label: "720p" });

  assert.equal(range.minCredits, 252);
  assert.equal(range.maxCredits, 560);
  assert.equal(estimateWorkflowCredits(seedanceReferenceToVideo, 5, { width: 1280, height: 720, label: "720p" }), 560);
});

test("ExteriorGrid Generator estimate matches observed low-cost grid usage", () => {
  assert.equal(
    estimateWorkflowCredits(exteriorGridGenerator, 5, { width: 1920, height: 1080, label: "1080p" }),
    6,
  );
});

test("Nano Banana estimate doubles when two output images are requested", () => {
  const single = estimateWorkflowCredits(nanoBanana, 5, { width: 1024, height: 1024, label: "1K" });
  const double = estimateWorkflowCredits(
    nanoBanana,
    5,
    { width: 1024, height: 1024, label: "1K" },
    { nanoBanana: { outputCount: 2 } },
  );

  assert.equal(double, single * 2);
});

test("GPT image estimate doubles when two output images are requested", () => {
  const single = estimateWorkflowCredits(gptImage, 5, { width: 1024, height: 1024, label: "1K" });
  const double = estimateWorkflowCredits(
    gptImage,
    5,
    { width: 1024, height: 1024, label: "1K" },
    { gptImage: { outputCount: 2 } },
  );

  assert.equal(double, single * 2);
});
