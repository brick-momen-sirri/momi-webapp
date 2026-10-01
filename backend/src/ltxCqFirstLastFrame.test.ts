import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  assertLtxCqFlfCanvas,
  assertLtxCqFlfDelivered,
  assertLtxCqFlfGuideChain,
  compileLtxCqFlfWorkflow,
  isLtxCqPodModelId,
  LTX_CQ_FLF_DURATIONS,
  LTX_CQ_FLF_MODE,
  ltxCqFlfCredits,
  ltxCqFlfManifestMode,
  ltxCqFlfManifestPath,
  ltxCqFlfSeconds,
  ltxCqFlfWorkflowModel,
  ltxCqFlfWorkflowPath,
  planLtxCqFlf,
  type LtxCqFlfManifestMode,
} from "./ltxCqFirstLastFrame.js";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const template = JSON.parse(await fs.readFile(ltxCqFlfWorkflowPath(), "utf8")) as Graph;
const mode = ltxCqFlfManifestMode(JSON.parse(await fs.readFile(ltxCqFlfManifestPath(), "utf8")));

function compile(graph: unknown = template, manifest: LtxCqFlfManifestMode = mode, label = "1080p", seconds = 5) {
  return compileLtxCqFlfWorkflow(graph, manifest, {
    plan: planLtxCqFlf({ width: 0, height: 0, label }, seconds),
    prompt: "The camera glides from the lobby to the terrace.",
    firstImageName: "ltxflfcq-job_1-first.png",
    lastImageName: "ltxflfcq-job_1-last.png",
    outputPrefix: "momi/job_1/FLF_CQ",
  }) as Graph;
}

test("the shipped graph and manifest are the tested export, byte for byte", async () => {
  const { createHash } = await import("node:crypto");
  const sha = async (file: string) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
  // brick-momen-sirri/worker-comfyui-LTX-2.5 @ 1bdcbcf, workflows/experimental/.
  assert.equal(await sha(ltxCqFlfWorkflowPath()), "d517af3e6cae6ec97ca99c80b1ff8ac795209778d32030244e7ebae90931308c");
  assert.equal(await sha(ltxCqFlfManifestPath()), "493afcba6ccb357cf2c31a6999a9c87a554f77cb8bd1ff74a4477699cea33e14");
});

test("the three presets generate on the 32 px grid and deliver 720, 1080 and 1440", () => {
  const plans = ["720p", "1080p", "1440p"].map((label) => planLtxCqFlf({ width: 0, height: 0, label }, undefined));
  assert.deepEqual(
    plans.map((plan) => [plan.generationWidth, plan.generationHeight, plan.width, plan.height, plan.frames]),
    [
      [1280, 736, 1280, 720, 121],
      [1920, 1088, 1920, 1080, 121],
      [2560, 1440, 2560, 1440, 121],
    ],
  );
  // 121 frames at 24 fps by default: ~5.04 s.
  assert.equal(plans[0].durationSeconds, 5);
  for (const seconds of LTX_CQ_FLF_DURATIONS) {
    const frames = planLtxCqFlf({ width: 2560, height: 1440 }, seconds).frames;
    assert.equal((frames - 1) % 8, 0, `${seconds}s -> ${frames}`);
  }
  // By size as well as label.
  assert.equal(planLtxCqFlf({ width: 1280, height: 720 }, 5).generationHeight, 736);
});

test("invalid settings are refused before anything can be submitted", () => {
  assert.throws(() => planLtxCqFlf({ width: 3840, height: 2160, label: "4K" }, 5), /720p, 1080p, 1440p only/);
  assert.throws(() => planLtxCqFlf({ width: 1080, height: 1920 }, 5), /720p, 1080p, 1440p only/);
  assert.throws(() => planLtxCqFlf(undefined, 5), /only/);
  assert.throws(() => planLtxCqFlf({ width: 1920, height: 1080, label: "1080p" }, 6), /2, 3, 4, 5 second/);
  assert.throws(() => planLtxCqFlf({ width: 1920, height: 1080, label: "1080p" }, 0), /second/);

  assert.doesNotThrow(() => assertLtxCqFlfCanvas(2560, 1440, 121));
  assert.doesNotThrow(() => assertLtxCqFlfCanvas(256, 256, 9));
  assert.throws(() => assertLtxCqFlfCanvas(1920, 1080, 121), /32 px grid/);
  assert.throws(() => assertLtxCqFlfCanvas(1290, 736, 121), /32 px grid/);
  assert.throws(() => assertLtxCqFlfCanvas(2592, 1440, 121), /at most 2560x1440/);
  assert.throws(() => assertLtxCqFlfCanvas(2560, 1472, 121), /at most 2560x1440/);
  for (const frames of [1, 8, 10, 120, 129, 241, 121.5]) {
    assert.throws(() => assertLtxCqFlfCanvas(1280, 736, frames), /9-121 frames of the form 8n\+1/, String(frames));
  }
});

test("every value goes through the manifest's bindings, consistently across each pair", () => {
  const graph = compile(template, mode, "720p", 2);

  assert.equal(graph.positive.inputs.text, "The camera glides from the lobby to the terrace.");
  for (const node of ["video_latent", "first_frame_resize", "last_frame_resize"]) {
    assert.deepEqual([graph[node].inputs.width, graph[node].inputs.height], [1280, 736], node);
  }
  assert.equal(graph.video_latent.inputs.length, 49);
  assert.equal(graph.audio_latent.inputs.frames_number, 49);
  assert.equal(graph.load_first_frame.inputs.image, "ltxflfcq-job_1-first.png");
  assert.equal(graph.load_last_frame.inputs.image, "ltxflfcq-job_1-last.png");
  assert.equal(graph.save.inputs.filename_prefix, "momi/job_1/FLF_CQ");

  // The tested recipe.
  assert.equal(graph.first_frame_condition.inputs.strength, 0.7);
  assert.equal(graph.last_frame_condition.inputs.strength, 0.7);
  assert.equal(graph.first_frame_preprocess.inputs.img_compression, 18);
  assert.equal(graph.last_frame_preprocess.inputs.img_compression, 18);
  assert.equal(graph.sample_noise.inputs.noise_seed, 42);
  assert.deepEqual([graph.sample_guider.inputs.video_cfg, graph.sample_guider.inputs.audio_cfg], [1, 1]);
  assert.equal(graph.distilled_lora.inputs.strength_model, 1);
  assert.equal(graph.cq_lora.inputs.strength_model, 1);
  assert.deepEqual(
    [graph.conditioning.inputs.frame_rate, graph.audio_latent.inputs.frame_rate, graph.video.inputs.fps],
    [24, 24, 24],
  );

  // The model stack, sampler, sigma schedule, VAE and decoder are the graph's own.
  assert.equal(graph.model.inputs.unet_name, "ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors");
  assert.deepEqual(graph.distilled_lora.inputs.model, ["model", 0]);
  assert.deepEqual(graph.cq_lora.inputs.model, ["distilled_lora", 0]);
  assert.deepEqual(graph.sample_guider.inputs.model, ["cq_lora", 0]);
  assert.equal(graph.video_vae.inputs.vae_name, "ltx-2.5-video-vae-conv-bf16.safetensors");
  assert.equal(String(graph.sample_sigmas.inputs.sigmas).split(",").length - 1, 8, "eight steps");
  assert.equal(graph.decode_video.class_type, "VAEDecode");

  // The app's mode name is never sent, and each job gets its own copy.
  assert.ok(!JSON.stringify(graph).includes(LTX_CQ_FLF_MODE));
  assert.equal(template.video_latent.inputs.height, 736);
  assert.equal(template.load_first_frame.inputs.image, "first_frame.png");
});

test("both guides are wired as tested: frame 0 then frame -1, into the sampler, cropped before decode", () => {
  const graph = compile();
  assert.deepEqual(
    [graph.first_frame_condition.class_type, graph.first_frame_condition.inputs.frame_idx],
    ["LTXVAddGuide", 0],
  );
  assert.deepEqual([graph.last_frame_condition.class_type, graph.last_frame_condition.inputs.frame_idx], ["LTXVAddGuide", -1]);
  assert.deepEqual(graph.last_frame_condition.inputs.latent, ["first_frame_condition", 2]);
  assert.deepEqual(graph.sample_av.inputs.video_latent, ["last_frame_condition", 2]);
  assert.deepEqual(graph.sample_guider.inputs.positive, ["last_frame_condition", 0]);
  assert.deepEqual(graph.sample_crop.inputs.latent, ["sample_split", 0]);
  assert.deepEqual(graph.decode_video.inputs.samples, ["sample_crop", 2]);
  assert.deepEqual(graph.video.inputs.images, ["decode_video", 0]);
  assert.doesNotThrow(() => assertLtxCqFlfGuideChain(graph, mode));
});

test("a graph that breaks the guide chain fails the build", () => {
  const broken = (why: string, edit: (graph: Graph) => void, expected: RegExp) => {
    const graph = structuredClone(template);
    edit(graph);
    assert.throws(() => compile(graph), expected, why);
  };

  broken("guide positions swapped", (g) => {
    g.first_frame_condition.inputs.frame_idx = -1;
    g.last_frame_condition.inputs.frame_idx = 0;
  }, /first-frame guide is at frame -1/);
  broken("images swapped", (g) => {
    g.first_frame_resize.inputs.image = ["load_last_frame", 0];
    g.last_frame_resize.inputs.image = ["load_first_frame", 0];
  }, /first-frame guide is at frame -1|first_frame image/);
  broken("one image feeding both guides", (g) => {
    g.last_frame_preprocess.inputs.image = ["first_frame_resize", 0];
  }, /exactly one guide/);
  broken("guides in parallel rather than chained", (g) => {
    g.last_frame_condition.inputs.latent = ["video_latent", 0];
  }, /last guide's latent/);
  broken("the last guide dropped", (g) => {
    g.sample_av.inputs.video_latent = ["first_frame_condition", 2];
    g.sample_guider.inputs.positive = ["first_frame_condition", 0];
    delete (g as Record<string, unknown>).last_frame_condition;
  }, /last_frame_condition/);
  broken("the guider skipping the guided conditioning", (g) => {
    g.sample_guider.inputs.positive = ["conditioning", 0];
  }, /guider's conditioning/);
  broken("decoded without cropping the guides", (g) => {
    g.decode_video.inputs.samples = ["sample_split", 0];
  }, /not decoded straight from the cropped latent/);
  broken("an image composited onto the result", (g) => {
    g.paste = { class_type: "ImageCompositeMasked", inputs: { destination: ["decode_video", 0], source: ["load_first_frame", 0] } };
    g.video.inputs.images = ["paste", 0];
  }, /not decoded straight from the cropped latent/);
});

test("the manifest is the only source of bindings, and its constraints hold", () => {
  const withBindings = (bindings: LtxCqFlfManifestMode["bindings"]) => ({ ...mode, bindings });

  const { width, ...noWidth } = mode.bindings;
  assert.ok(width.length === 3);
  assert.throws(() => compile(template, withBindings(noWidth)), /no binding for width/);
  assert.throws(
    () => compile(template, withBindings({ ...mode.bindings, height: [...mode.bindings.height, { node_id: "missing", input: "height" }] })),
    /binds height to missing.height/,
  );
  assert.throws(
    () => compile(template, { ...mode, media: { ...mode.media, last_frame: { ...mode.media.last_frame, node_id: "nope" } } }),
    /last_frame to nope.image/,
  );
  // A tighter manifest wins over the app's presets.
  assert.throws(
    () => compile(template, { ...mode, constraints: { ...mode.constraints, width: { type: "integer", maximum: 1920, multiple_of: 32 } } }, "1440p"),
    /width 2560 is above 1920/,
  );
  assert.throws(
    () =>
      compileLtxCqFlfWorkflow(template, mode, {
        plan: planLtxCqFlf({ width: 1920, height: 1080 }, 5),
        prompt: "x".repeat(12_001),
        firstImageName: "a.png",
        lastImageName: "b.png",
        outputPrefix: "p",
      }),
    /prompt is over 12000 characters/,
  );
  assert.throws(
    () =>
      compileLtxCqFlfWorkflow(template, mode, {
        plan: planLtxCqFlf({ width: 1920, height: 1080 }, 5),
        prompt: "x",
        firstImageName: "same.png",
        lastImageName: "same.png",
        outputPrefix: "p",
      }),
    /distinct filenames/,
  );
  assert.throws(() => ltxCqFlfManifestMode({ modes: {} }), /no complete first_last_frame_cq_experimental mode/);
});

test("the job completes only with a stored video", () => {
  assert.doesNotThrow(() => assertLtxCqFlfDelivered([{ assetType: "video", filePath: "C:/out/flf.mp4" }]));
  assert.throws(() => assertLtxCqFlfDelivered([]), /without returning a video/);
  assert.throws(() => assertLtxCqFlfDelivered([{ assetType: "image", filePath: "C:/out/a.png" }]), /without returning a video/);
  assert.throws(
    () => assertLtxCqFlfDelivered([{ assetType: "video", error: "the delivered file has 120 frames, expected 121" }]),
    /could not be saved: the delivered file has 120 frames/,
  );
  assert.throws(() => assertLtxCqFlfDelivered([{ assetType: "video" }]), /not written to the project/);
});

test("the model is an experimental first/last-frame workflow on the CQ pod", () => {
  const model = ltxCqFlfWorkflowModel();
  assert.equal(model, ltxCqFlfWorkflowModel());
  assert.equal(model.category, "first_last_frame_to_video");
  assert.deepEqual(model.requiredInputs, ["prompt", "start_frame", "end_frame", "resolution"]);
  assert.equal(model.requiresStartEndFrames, true);
  assert.equal(model.imageSlotCount, 2);
  assert.deepEqual(model.supportedResolutions, ["720p", "1080p", "1440p"]);
  assert.equal(model.defaultDurationSeconds, 5);
  assert.match(model.name, /Experimental/);
  assert.match(model.description ?? "", /exact geometry is not preserved/);
  assert.ok(isLtxCqPodModelId(model.id));
  assert.ok(isLtxCqPodModelId("ltx25_cq_i2v"));
  assert.ok(!isLtxCqPodModelId("brick_api_kling_v3_flf2v"));

  // Pinned to the same figures as the form's quote (src/utils/creditEstimator.test.ts).
  assert.deepEqual([ltxCqFlfCredits("720p", 5), ltxCqFlfCredits("1080p", 5), ltxCqFlfCredits("1440p", 5)], [12, 18, 34]);
  assert.ok(ltxCqFlfCredits("720p", 5) < ltxCqFlfCredits("1080p", 5));
  assert.ok(ltxCqFlfCredits("1080p", 5) < ltxCqFlfCredits("1440p", 5));
  assert.ok(ltxCqFlfCredits("1080p", 2) < ltxCqFlfCredits("1080p", 5));
  assert.equal(model.estimatedCredits, ltxCqFlfCredits("1080p", 5));
  // The measured runs, plus the minute of overhead: 59 s, 118 s, 280.5 s at 121 frames.
  assert.equal(ltxCqFlfSeconds("1440p", 121), 340.5);
  assert.ok(Math.abs(ltxCqFlfSeconds("1080p", 49) - (60 + 118.4 * (49 / 121))) < 1e-9);
});
