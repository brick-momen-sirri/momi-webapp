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

const flux3ImageToVideo = {
  id: "brick_api_flux3_i2v",
  name: "Api Flux3 I2v",
  category: "image_to_video" as const,
  workflowPath: "workflow/i2v/Brick_api_flux3_i2v.json",
  defaultDurationSeconds: 5,
};

test("Seedance 2.0 first-last estimate uses Comfy price badge token formula", () => {
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, { width: 1280, height: 720, label: "720p" }), 228);
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, { width: 1920, height: 1080, label: "1080p" }), 567);
});

test("Seedance 2.5 is priced above 2.0 at the ratio its billing shows", () => {
  const hd = { width: 1280, height: 720, label: "720p" };
  const fhd = { width: 1920, height: 1080, label: "1080p" };

  // The rates come from official_usage_events: 2.5 runs 1.5446x 2.0 at 720p and
  // 1.5353x at 1080p, so 2.0's figures scale rather than being re-derived.
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, hd, { seedance: { version: "2.5" } }), 352);
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, fhd, { seedance: { version: "2.5" } }), 870);

  // No version, and 2.0 explicitly, both keep 2.0's price.
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, hd), 228);
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, hd, { seedance: { version: "2.0" } }), 228);
});

test("480p is priced as 480p rather than falling through to the 1080p rate", () => {
  const sd = { width: 854, height: 480, label: "480p" };

  // 10044 tokens/s x $0.01001/1k reproduces the $0.1005371/s 2.0 bills at 480p, so a
  // 5s run is well under a tenth of the 1080p figure. Falling back to 1080p, which is
  // what an unmapped label does, would over-quote it by about five times.
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, sd), 106);
  assert.ok(
    estimateWorkflowCredits(seedanceFirstLast, 5, sd) <
      estimateWorkflowCredits(seedanceFirstLast, 5, {
        width: 1280,
        height: 720,
        label: "720p",
      }),
  );

  // Pinned to a real run: a 5s 480p job on 2.5 billed $0.7411, which the tracker
  // recorded as 156.38 credits. Anything else here means the rate drifted.
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 5, sd, { seedance: { version: "2.5" } }), 156);
});

test("Seedance 2.5 can be quoted for a duration 2.0 cannot reach", () => {
  const fhd = { width: 1920, height: 1080, label: "1080p" };

  // 30s is 2.5-only, and the estimate is linear in duration -- 6x the 5s figure to
  // within the single rounding at the end (870 x 6 = 5220).
  assert.equal(estimateWorkflowCredits(seedanceFirstLast, 30, fhd, { seedance: { version: "2.5" } }), 5222);
});

test("Flux 3 estimate follows the Comfy price badge for HD and FHD", () => {
  assert.equal(estimateWorkflowCredits(flux3ImageToVideo, 5, { width: 1280, height: 720, label: "720p" }), 256);
  assert.equal(estimateWorkflowCredits(flux3ImageToVideo, 5, { width: 1920, height: 1080, label: "1080p" }), 438);
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
  assert.equal(estimateWorkflowCredits(exteriorGridGenerator, 5, { width: 1920, height: 1080, label: "1080p" }), 6);
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

// Matches what stillImageWorkflowModels() builds: estimateWorkflowCredits keys
// off the id/name/category/path string, so the id is what routes it here.
const EDIT_STUDIO = {
  id: "still_image-editing",
  name: "Image Editing Studio",
  category: "image_editing",
  workflowPath: "workflow-still-images/image-editing.json",
  estimatedCredits: 18,
} as never;

test("an Image Editing Studio estimate follows the engine, and GPT follows Quality", () => {
  // Quality is what OpenAI actually bills on. Resolution is not: across 38
  // measured Custom renders the charge ran from $0.0142 to $0.7394, so any
  // single flat figure -- including the mean this once used -- is meaningless.
  const gpt = (quality?: string) =>
    estimateWorkflowCredits(EDIT_STUDIO, undefined, undefined, {
      stillImage: { categoryId: "image-editing", settings: { engine: "gpt-image", ...(quality ? { quality } : {}) } },
    } as never);

  assert.ok(gpt("low") < gpt("medium"), "Fast must quote less than Balanced");
  assert.ok(gpt("medium") < gpt("high"), "Balanced must quote less than Best");
  // Balanced is the graph's default, so an unset quality must not quote Fast.
  assert.equal(gpt(), gpt("medium"));

  // Nano Banana stays on its own measured per-resolution rates, which unlike
  // GPT's really do track resolution.
  const nano = (resolution: string) =>
    estimateWorkflowCredits(EDIT_STUDIO, undefined, undefined, {
      stillImage: { categoryId: "image-editing", settings: { engine: "nano-banana", resolution } },
    } as never);
  assert.ok(nano("1K") < nano("2K") && nano("2K") < nano("4K"));
});
