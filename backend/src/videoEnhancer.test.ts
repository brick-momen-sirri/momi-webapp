import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildVideoEnhancerWorkflow,
  enhancedDimensions,
  normalizeVideoEnhancerOptions,
  planVideoEnhancement,
  VIDEO_ENHANCER_MAX_PIXELS,
  videoEnhancerCredits,
  videoEnhancerRunpodPolicy,
  videoEnhancerSeconds,
  videoEnhancerWorkflowPath,
  type VideoEnhancerSourceProbe,
} from "./videoEnhancer.js";

const kling5s: VideoEnhancerSourceProbe = {
  width: 1920,
  height: 1076,
  fps: "24/1",
  frames: 121,
  durationSeconds: 121 / 24,
  hasAudio: false,
};

test("a 5 s Kling clip plans the verified 2560x1440 / 121-frame run, retimed", () => {
  assert.deepEqual(planVideoEnhancement(kling5s, 2560), {
    width: 2560,
    height: 1440,
    frames: 121,
    sourceWidth: 1920,
    sourceHeight: 1076,
    sourceFps: "24/1",
    timing: "retime",
    outputFps: "24/1",
    sourceHasAudio: false,
  });
});

test("a longer clip is capped at 121 frames, a shorter one drops to the nearest 8n+1", () => {
  assert.equal(planVideoEnhancement({ ...kling5s, frames: 241, durationSeconds: 241 / 24 }, 2560).frames, 121);
  assert.equal(planVideoEnhancement({ ...kling5s, frames: 100, durationSeconds: 100 / 24 }, 2560).frames, 97);
  assert.throws(() => planVideoEnhancement({ ...kling5s, frames: 8, durationSeconds: 8 / 24 }, 2560), /at least 9 frames/);
});

test("sources outside the retime band are resampled to 30 fps and delivered at 30", () => {
  const plan = planVideoEnhancement({ ...kling5s, fps: "60/1", frames: 600, durationSeconds: 10 }, 2560);
  assert.equal(plan.timing, "resample");
  assert.equal(plan.outputFps, "30/1");
  assert.equal(plan.frames, 121);
  // Two seconds at 60 fps is 60 frames once resampled, so 57 -- not 113.
  assert.equal(planVideoEnhancement({ ...kling5s, fps: "60/1", frames: 120, durationSeconds: 2 }, 2560).frames, 57);
  assert.equal(planVideoEnhancement({ ...kling5s, fps: "30000/1001" }, 2560).timing, "retime");
  assert.equal(planVideoEnhancement({ ...kling5s, fps: "25/1" }, 2560).outputFps, "25/1");
});

test("frame sizes follow the source aspect on a 32 px grid within the verified area", () => {
  assert.deepEqual(enhancedDimensions(1920, 1080, 2560), { width: 2560, height: 1440 });
  assert.deepEqual(enhancedDimensions(1080, 1920, 2560), { width: 1440, height: 2560 });
  assert.deepEqual(enhancedDimensions(1920, 1080, 1920), { width: 1920, height: 1088 });
  assert.deepEqual(enhancedDimensions(1376, 768, 1280), { width: 1280, height: 704 });
  // Square is held to the 2560x1440 area rather than 2560x2560.
  const square = enhancedDimensions(1024, 1024, 2560);
  assert.equal(square.width, square.height);
  assert.ok(square.width * square.height <= VIDEO_ENHANCER_MAX_PIXELS);
  for (const [w, h] of [
    [4096, 1716],
    [1440, 1080],
    [720, 1280],
    [3840, 2160],
  ]) {
    for (const longSide of [1280, 1920, 2560]) {
      const size = enhancedDimensions(w, h, longSide);
      assert.equal(size.width % 32, 0);
      assert.equal(size.height % 32, 0);
      assert.ok(Math.max(size.width, size.height) <= longSide, `${w}x${h}@${longSide}`);
      assert.ok(size.width * size.height <= VIDEO_ENHANCER_MAX_PIXELS);
    }
  }
});

test("options keep only the long side and seed a client may set", () => {
  assert.deepEqual(normalizeVideoEnhancerOptions(undefined), { longSide: 2560 });
  assert.deepEqual(normalizeVideoEnhancerOptions({ longSide: 1920, seed: 7, plan: { width: 9999 } }), {
    longSide: 1920,
    seed: 7,
  });
  assert.throws(() => normalizeVideoEnhancerOptions({ longSide: 3840 }), /longSide/);
  assert.throws(() => normalizeVideoEnhancerOptions({ seed: -1 }), /seed/);
});

test("the shipped graph binds every value the plan sets, and nothing else changes", async () => {
  const template = JSON.parse(await fs.readFile(videoEnhancerWorkflowPath(), "utf8"));
  const plan = planVideoEnhancement(kling5s, 2560);
  const graph = buildVideoEnhancerWorkflow(template, {
    plan,
    videoName: "momi_job_cq_input.mp4",
    seed: 42,
    outputPrefix: "momi/job/video_enhancer",
  }) as Record<string, { inputs: Record<string, unknown> }>;

  assert.equal(graph.load_video.inputs.file, "momi_job_cq_input.mp4");
  assert.deepEqual(
    [graph.video_latent.inputs.width, graph.video_latent.inputs.height, graph.video_latent.inputs.length],
    [2560, 1440, 121],
  );
  assert.equal(graph.audio_latent.inputs.frames_number, 121);
  assert.equal(graph.save.inputs.filename_prefix, "momi/job/video_enhancer");
  // The publisher's recipe stays as shipped: 30 fps, CFG 1, both LoRA strengths.
  assert.equal(graph.conditioning.inputs.frame_rate, 30);
  assert.equal(graph.video.inputs.fps, 30);
  assert.equal(graph.guider.inputs.cfg, 1);
  assert.equal(graph.distilled_lora.inputs.strength_model, 0.5);
  assert.equal(graph.cq_lora.inputs.strength_model, 1);
  // The template itself is untouched.
  assert.equal(template.video_latent.inputs.length, 153);
});

test("a replaced graph without the expected nodes fails the build", () => {
  const plan = planVideoEnhancement(kling5s, 2560);
  assert.throws(
    () => buildVideoEnhancerWorkflow({}, { plan, videoName: "x.mp4", seed: 1, outputPrefix: "p" }),
    /LoadVideo node "load_video"/,
  );
});

test("the estimate tracks the measured run and the policy outlasts it", () => {
  // 2026-09-30: 688 s execution, 714 s billed at $0.000462/s = $0.33.
  const seconds = videoEnhancerSeconds(2560, 1440, 121);
  assert.ok(seconds > 680 && seconds < 760, String(seconds));
  assert.equal(videoEnhancerCredits(2560), videoEnhancerCredits(2560, 2560, 1440, 121));
  assert.ok(videoEnhancerCredits(1280) < videoEnhancerCredits(1920));
  assert.ok(videoEnhancerCredits(1920) < videoEnhancerCredits(2560));

  const policy = videoEnhancerRunpodPolicy();
  assert.ok(policy.executionTimeout > seconds * 1000 * 2);
  assert.ok(policy.ttl > policy.executionTimeout);
});
