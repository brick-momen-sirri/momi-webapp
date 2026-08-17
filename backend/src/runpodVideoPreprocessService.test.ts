import assert from "node:assert/strict";
import test from "node:test";
import {
  displayResolution,
  hasSquarePixels,
  isKlingO3VideoEditModel,
  isSeedance2ReferenceVideoModel,
  normalizedKlingVideoDimensions,
  normalizedSeedance2ReferenceVideoDimensions,
  parseSampleAspectRatio,
} from "./runpodVideoPreprocessService.js";

test("Kling O3 video edit models enable input normalization", () => {
  assert.equal(
    isKlingO3VideoEditModel({
      id: "brcik_api_kling_o3_video_edit",
      name: "Kling O3 Video Edit",
      workflowPath: "workflow/video_edit/Brcik_api_kling_o3_video_edit.json",
    }),
    true,
  );
  assert.equal(
    isKlingO3VideoEditModel({
      id: "brick_api_kling_v3_video",
      name: "Kling V3 Video",
      workflowPath: "workflow/i2v/Brick_api_kling_v3_video.json",
    }),
    false,
  );
});

test("4K landscape video is reduced to Kling O3's maximum dimension", () => {
  assert.deepEqual(normalizedKlingVideoDimensions({ width: 3840, height: 2160 }), {
    width: 2160,
    height: 1216,
  });
});

test("small video is enlarged to Kling O3's minimum dimension", () => {
  assert.deepEqual(normalizedKlingVideoDimensions({ width: 640, height: 360 }), {
    width: 1280,
    height: 720,
  });
});

test("valid Kling O3 video dimensions are preserved", () => {
  assert.deepEqual(normalizedKlingVideoDimensions({ width: 1920, height: 1080 }), {
    width: 1920,
    height: 1080,
  });
});

test("extreme aspect ratios fail before a paid RunPod request", () => {
  assert.throws(() => normalizedKlingVideoDimensions({ width: 4000, height: 500 }), /cannot fit within Kling O3's/);
});

test("an undeclared or zero sample aspect ratio counts as square pixels", () => {
  assert.deepEqual(parseSampleAspectRatio(undefined), { sarNumerator: 1, sarDenominator: 1 });
  assert.deepEqual(parseSampleAspectRatio("N/A"), { sarNumerator: 1, sarDenominator: 1 });
  assert.deepEqual(parseSampleAspectRatio("0:1"), { sarNumerator: 1, sarDenominator: 1 });
  assert.deepEqual(parseSampleAspectRatio("1:1"), { sarNumerator: 1, sarDenominator: 1 });
  assert.deepEqual(parseSampleAspectRatio(" 4:3 "), { sarNumerator: 4, sarDenominator: 3 });
});

test("anamorphic video is measured by what it displays, not what it stores", () => {
  // DVCPRO HD: 1440x1080 stored, 16:9 on screen. This is the shape that made
  // Kling's VideoNormalize fail instead of just producing a squashed render.
  const geometry = { width: 1440, height: 1080, sarNumerator: 4, sarDenominator: 3 };
  assert.equal(hasSquarePixels(geometry), false);
  assert.deepEqual(displayResolution(geometry), { width: 1920, height: 1080 });
  assert.deepEqual(normalizedKlingVideoDimensions(displayResolution(geometry)), { width: 1920, height: 1080 });
});

test("square-pixel video keeps its stored dimensions", () => {
  const geometry = { width: 1920, height: 1080, sarNumerator: 1, sarDenominator: 1 };
  assert.equal(hasSquarePixels(geometry), true);
  assert.deepEqual(displayResolution(geometry), { width: 1920, height: 1080 });
});

test("Seedance 2.0 R2V models enable reference-video normalization", () => {
  assert.equal(
    isSeedance2ReferenceVideoModel({
      id: "brick_api_seedance2_0_r2v",
      name: "Api Seedance2 0 R2v",
      workflowPath: "workflow/video_edit/Brick_api_seedance2_0_r2v.json",
    }),
    true,
  );
  assert.equal(
    isSeedance2ReferenceVideoModel({
      id: "brick_api_seedance2_0_i2v",
      name: "Seedance 2.0 Image to Video",
      workflowPath: "workflow/i2v/Brick_api_seedance2_0_i2v.json",
    }),
    false,
  );
});

test("4K Seedance reference video is reduced to the model's 1080p pixel limit", () => {
  assert.deepEqual(normalizedSeedance2ReferenceVideoDimensions({ width: 3840, height: 2160 }), { width: 1920, height: 1080 });
});

test("portrait Seedance reference video preserves its aspect ratio at the pixel limit", () => {
  assert.deepEqual(normalizedSeedance2ReferenceVideoDimensions({ width: 2160, height: 3840 }), { width: 1080, height: 1920 });
});

test("valid Seedance reference video dimensions are preserved", () => {
  assert.deepEqual(normalizedSeedance2ReferenceVideoDimensions({ width: 1280, height: 720 }), { width: 1280, height: 720 });
});
