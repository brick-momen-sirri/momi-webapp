import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildLtxCqI2vWorkflow,
  LTX_CQ_I2V_DURATIONS,
  ltxCqI2vCredits,
  ltxCqI2vPreset,
  ltxCqI2vSeconds,
  ltxCqI2vWorkflowModel,
  ltxCqI2vWorkflowPath,
  planLtxCqI2v,
} from "./ltxCqImageToVideo.js";

test("the two tested presets plan the tested canvases, 24n+1 frames", () => {
  assert.deepEqual(planLtxCqI2v({ width: 2560, height: 1440, label: "1440p" }, 5), {
    width: 2560,
    height: 1440,
    generationWidth: 2560,
    generationHeight: 1440,
    frames: 121,
    durationSeconds: 5,
  });
  const fullHd = planLtxCqI2v({ width: 1920, height: 1080, label: "1080p" }, 2);
  assert.deepEqual([fullHd.generationWidth, fullHd.generationHeight, fullHd.height, fullHd.frames], [1920, 1088, 1080, 49]);
  for (const seconds of LTX_CQ_I2V_DURATIONS) {
    const frames = planLtxCqI2v({ width: 2560, height: 1440 }, seconds).frames;
    assert.equal((frames - 1) % 8, 0, `${seconds}s -> ${frames}`);
    assert.ok(frames >= 9 && frames <= 121);
  }
});

test("anything outside the tested contract is refused before it can be submitted", () => {
  assert.throws(() => planLtxCqI2v({ width: 3840, height: 2160, label: "4K" }, 5), /1080p and 1440p/);
  assert.throws(() => planLtxCqI2v({ width: 1440, height: 2560 }, 5), /1080p and 1440p/);
  assert.throws(() => planLtxCqI2v({ width: 2560, height: 1440 }, 6), /2, 3, 4, 5 second/);
  assert.throws(() => planLtxCqI2v(undefined, 5), /1080p and 1440p/);
  // A label and a size both name a preset.
  assert.equal(ltxCqI2vPreset("2560x1440")?.generationHeight, 1440);
  assert.equal(ltxCqI2vPreset({ width: 1920, height: 1080 })?.generationHeight, 1088);
});

test("the shipped graph binds both halves of every pair and leaves the recipe as tested", async () => {
  const template = JSON.parse(await fs.readFile(ltxCqI2vWorkflowPath(), "utf8"));
  const graph = buildLtxCqI2vWorkflow(template, {
    plan: planLtxCqI2v({ width: 1920, height: 1080, label: "1080p" }, 2),
    prompt: "A slow dolly toward the marina.",
    imageName: "ltxi2vcq-job_1.png",
    outputPrefix: "momi/job_1/I2V_CQ",
  }) as Record<string, { inputs: Record<string, unknown> }>;

  assert.equal(graph.positive.inputs.text, "A slow dolly toward the marina.");
  assert.equal(graph.load_image.inputs.image, "ltxi2vcq-job_1.png");
  assert.deepEqual([graph.video_latent.inputs.width, graph.video_latent.inputs.height], [1920, 1088]);
  assert.deepEqual([graph.image_resize.inputs.width, graph.image_resize.inputs.height], [1920, 1088]);
  assert.equal(graph.video_latent.inputs.length, 49);
  assert.equal(graph.audio_latent.inputs.frames_number, 49);
  assert.equal(graph.save.inputs.filename_prefix, "momi/job_1/I2V_CQ");

  // Fixed by the handoff for the initial integration.
  assert.equal(graph.sample_noise.inputs.noise_seed, 42);
  assert.equal(graph.sample_guider.inputs.cfg, 1);
  assert.deepEqual(graph.sample_guider.inputs.model, ["cq_lora", 0]);
  assert.equal(graph.image_condition.inputs.strength, 0.7);
  assert.equal(graph.image_preprocess.inputs.img_compression, 18);
  assert.equal(graph.distilled_lora.inputs.strength_model, 1);
  assert.equal(graph.cq_lora.inputs.strength_model, 1);
  assert.equal(graph.conditioning.inputs.frame_rate, 24);
  assert.equal(graph.audio_latent.inputs.frame_rate, 24);
  assert.equal(graph.video.inputs.fps, 24);

  // Each job gets its own copy.
  assert.equal(template.video_latent.inputs.height, 1440);
  assert.equal(template.load_image.inputs.image, "input.png");
});

test("a replaced graph without the expected nodes fails the build", () => {
  assert.throws(
    () =>
      buildLtxCqI2vWorkflow(
        {},
        {
          plan: planLtxCqI2v({ width: 2560, height: 1440 }, 5),
          prompt: "x",
          imageName: "x.png",
          outputPrefix: "p",
        },
      ),
    /CLIPTextEncode node "positive"/,
  );
});

test("the estimate follows the measured runs and the model reads as an image-to-video workflow", () => {
  // Measured execution: 219 s at 2560x1440x121, 110 s at 1920x1088x121, 54 s at 1920x1088x49.
  assert.ok(Math.abs(ltxCqI2vSeconds(2560, 1440, 121) - 60 - 219) < 25);
  assert.ok(Math.abs(ltxCqI2vSeconds(1920, 1088, 121) - 60 - 110) < 25);
  assert.ok(Math.abs(ltxCqI2vSeconds(1920, 1088, 49) - 60 - 54) < 25);
  assert.ok(ltxCqI2vCredits("1080p", 2) < ltxCqI2vCredits("1080p", 5));
  assert.ok(ltxCqI2vCredits("1080p", 5) < ltxCqI2vCredits("1440p", 5));

  const model = ltxCqI2vWorkflowModel();
  assert.equal(model, ltxCqI2vWorkflowModel());
  assert.equal(model.category, "image_to_video");
  assert.deepEqual(model.requiredInputs, ["prompt", "single_image", "resolution"]);
  assert.equal(model.estimatedCredits, ltxCqI2vCredits("1440p", 5));
});
