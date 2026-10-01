import assert from "node:assert/strict";
import test from "node:test";

import { estimateWorkflowCredits } from "./creditEstimator.js";
import {
  assertTableShape,
  partnerModelFamilies,
  partnerModelResolution,
  partnerModelUsd,
  seedreamMatchedSize,
} from "./partnerModels.js";
import { supportsTextOnlyImageWorkflow } from "./textOnlyImageModels.js";
import type { CreateJobRequest, WorkflowModel } from "./types.js";
import { getWorkflowModel, getWorkflowModels, loadWorkflowForRunpod, loadWorkflowModels } from "./workflowService.js";

await loadWorkflowModels();

function requiredModel(id: string) {
  const model = getWorkflowModel(id);
  assert.ok(model, `Expected ${id} to be discovered from workflow/.`);
  return model;
}

function request(model: WorkflowModel, overrides: Partial<CreateJobRequest> = {}): CreateJobRequest {
  return {
    projectId: "prj_playground",
    modelId: model.id,
    prompt: "a slow dolly across the atrium",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: model.defaultDurationSeconds,
    inputImages: [],
    userId: "usr_test",
    ...overrides,
  };
}

async function build(model: WorkflowModel, overrides: Partial<CreateJobRequest>, aspect?: number) {
  const req = request(model, overrides);
  return (await loadWorkflowForRunpod(model, req, "0000_base", req.inputImages ?? [], {
    firstImageAspect: aspect,
  })) as Record<string, any>;
}

function nodeOf(graph: Record<string, any>, classType: string) {
  const entry = Object.entries(graph).find(([, node]) => node.class_type === classType);
  assert.ok(entry, `Expected a ${classType} node.`);
  return { id: entry[0], inputs: entry[1].inputs as Record<string, any> };
}

test("every variant in partnerModels.json names a workflow that exists", () => {
  const discovered = new Set(getWorkflowModels().map((model) => model.id));
  for (const family of partnerModelFamilies) {
    for (const variant of family.variants) {
      assert.ok(discovered.has(variant.modelId), `${family.id}: no workflow file produces ${variant.modelId}.`);
    }
  }
});

test("no variant offers more reference images than its graph has slots for", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const family of partnerModelFamilies) {
    for (const variant of family.variants) {
      if (!variant.maxReferenceImages) continue;
      const graph = JSON.parse(await readFile(requiredModel(variant.modelId).workflowPath, "utf8")) as Record<string, any>;
      const loaders = Object.values(graph).filter((node: any) => node?.class_type === "LoadImage").length;
      assert.ok(
        variant.maxReferenceImages <= loaders,
        `${variant.modelId} offers ${variant.maxReferenceImages} images but its graph loads ${loaders}.`,
      );
    }
  }
});

test("each family marks one default per task category", () => {
  for (const family of partnerModelFamilies) {
    const defaultsByCategory = new Map<string, number>();
    const categories = new Set<string>();
    for (const variant of family.variants) {
      const category = requiredModel(variant.modelId).category;
      categories.add(category);
      if (variant.default) defaultsByCategory.set(category, (defaultsByCategory.get(category) ?? 0) + 1);
    }
    for (const category of categories) {
      assert.equal(defaultsByCategory.get(category), 1, `${family.id} needs exactly one default for ${category}.`);
    }
  }
});

test("the table validator refuses a variant priced two ways or with no fallback rate", () => {
  const base = { id: "f", label: "F", provider: "p" };
  const variant = { modelId: "some_model", label: "V", hint: "h" };
  assert.throws(
    () => assertTableShape({ families: [{ ...base, variants: [{ ...variant, pricing: { perImageUsd: { "1K": 1 } } }] }] }),
    /no "\*" fallback/,
  );
  assert.throws(
    () =>
      assertTableShape({
        families: [{ ...base, variants: [{ ...variant, pricing: { perImageUsd: { "*": 1 }, perSecondUsd: { "*": 1 } } }] }],
      }),
    /both per image and per second/,
  );
  assert.throws(() => assertTableShape({ families: [{ ...base, variants: [{ ...variant, modelId: "Has Spaces" }] }] }), /slug/);
});

test("a variant's declared limits replace what the file name would have inferred", () => {
  const h3 = requiredModel("brick_api_minimax_h3_i2v");
  assert.equal(h3.category, "image_to_video");
  assert.equal(h3.name, "MiniMax H3 Image to Video");
  assert.deepEqual(h3.supportedResolutions, ["768P", "2K"]);
  assert.equal(h3.defaultResolution, "768P");
  assert.deepEqual(h3.supportedDurations, Array.from({ length: 12 }, (_, index) => index + 4));

  const turbo = requiredModel("brick_api_minimax_h3_max_turbo_flf2v");
  assert.equal(turbo.category, "first_last_frame_to_video");
  assert.equal(turbo.requiresStartEndFrames, true);
  assert.deepEqual(turbo.supportedResolutions, ["480P", "768P"]);
  assert.equal(turbo.supportedDurations?.[0], 5);

  const reference = requiredModel("brick_api_minimax_h3_max_r2v");
  assert.equal(reference.category, "video_editing");
  assert.ok(reference.requiredInputs.includes("video"));

  const seedream = requiredModel("brick_api_seedream_5_0_flash");
  assert.equal(seedream.category, "image_editing");
  assert.equal(seedream.imageSlotCount, 5);
  assert.equal(seedream.defaultResolution, "auto");
  assert.ok(supportsTextOnlyImageWorkflow(seedream));

  // Grouping-only rows leave the older members exactly as they were.
  const gpt2 = requiredModel("brick_api_openai_gpt_image_2_i2i");
  assert.equal(gpt2.imageSlotCount, 5);
  assert.equal(gpt2.defaultResolution, "auto");
});

test("prices come from each node's own badge rates", () => {
  assert.equal(partnerModelUsd("brick_api_openai_gpt_image_2_5_flare_i2i", { resolutionLabel: "1024x1024" }), 0.0753);
  // Two references at $0.0176, and the pair doubled for two outputs.
  assert.equal(
    Number(
      partnerModelUsd("brick_api_openai_gpt_image_2_5_sunburst_i2i", {
        resolutionLabel: "3840x2160",
        referenceImageCount: 2,
        outputCount: 2,
      })?.toFixed(4),
    ),
    Number(((0.1431 + 2 * 0.0176) * 2).toFixed(4)),
  );
  assert.equal(partnerModelUsd("brick_nano_banana_pro", { resolutionLabel: "4K" }), 0.288);
  assert.equal(partnerModelUsd("brick_nano_banana_pro", { resolutionLabel: "2K" }), 0.1608);
  assert.equal(partnerModelUsd("brick_api_seedream_5_0_flash", { resolutionLabel: "2K 16:9" }), 0.02574);
  assert.equal(partnerModelUsd("brick_api_seedream_5_0_pro", { resolutionLabel: "1K 1:1" }), 0.045);
  assert.equal(partnerModelUsd("brick_api_seedream_5_0_pro", { resolutionLabel: "auto" }), 0.09);
  assert.equal(
    Number(partnerModelUsd("brick_api_minimax_h3_max_turbo_i2v", { resolutionLabel: "480P", durationSeconds: 5 })?.toFixed(5)),
    0.17875,
  );
  // A reference clip adds its upper bound; without one the estimate is the base.
  const withClip = partnerModelUsd("brick_api_minimax_h3_r2v", { resolutionLabel: "768P", durationSeconds: 5 }) ?? 0;
  const withoutClip =
    partnerModelUsd("brick_api_minimax_h3_r2v", { resolutionLabel: "768P", durationSeconds: 5, hasReferenceVideo: false }) ?? 0;
  assert.equal(Number(withoutClip.toFixed(4)), Number((0.1287 * 5).toFixed(4)));
  assert.ok(withClip > withoutClip);
  // Unpriced grouping rows fall through to the caller's own rule.
  assert.equal(partnerModelUsd("brick_nano_banana_2", { resolutionLabel: "1K" }), undefined);
});

test("the estimate uses the variant's rate instead of its older sibling's", () => {
  const gpt25 = requiredModel("brick_api_openai_gpt_image_2_5_flare_i2i");
  const gpt2 = requiredModel("brick_api_openai_gpt_image_2_i2i");
  const size = { width: 1024, height: 1024, label: "1024x1024" };
  assert.equal(estimateWorkflowCredits(gpt25, undefined, size), Math.round(0.0753 * 211));
  assert.ok(estimateWorkflowCredits(gpt2, undefined, size) > estimateWorkflowCredits(gpt25, undefined, size));

  const nanoPro = requiredModel("brick_nano_banana_pro");
  assert.equal(
    estimateWorkflowCredits(nanoPro, undefined, { width: 3840, height: 2160, label: "4K" }, { nanoBanana: { outputCount: 2 } }),
    Math.round(0.288 * 2 * 211),
  );
});

test("a Seedream size matched to the input keeps its shape inside the node's limits", () => {
  const wide = seedreamMatchedSize(2048 * 2048, 16 / 9);
  assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.01);
  assert.ok(wide.width * wide.height <= 4_624_220 && wide.width * wide.height >= 921_600);
  assert.equal(wide.width % 2, 0);
  assert.equal(wide.height % 2, 0);

  // A panorama keeps its short side at the node's 1024 minimum.
  const panorama = seedreamMatchedSize(2048 * 2048, 6);
  assert.equal(panorama.height, 1024);
  assert.ok(panorama.width <= 4514);

  const tall = seedreamMatchedSize(2048 * 2048, 0.75);
  assert.ok(tall.height > tall.width);
});

test("MiniMax H3 sends the node's own resolution value, the frames in order, and a fresh seed", async () => {
  const h3 = requiredModel("brick_api_minimax_h3_flf2v");
  const graph = await build(h3, {
    resolution: { width: 2560, height: 1440, label: "2K" },
    durationSeconds: 12,
    inputImages: ["start.png", "end.png"],
    startFrame: "start.png",
    endFrame: "end.png",
  });
  const node = nodeOf(graph, "MinimaxHailuo03FirstLastFrameNode");
  assert.equal(node.inputs.model, "MiniMax H3");
  assert.equal(node.inputs["model.resolution"], "2K");
  assert.equal(node.inputs["model.duration"], 12);
  assert.equal(node.inputs["model.prompt"], "a slow dolly across the atrium");
  assert.equal(graph[node.inputs.first_frame[0]].inputs.image, "start.png");
  assert.equal(graph[node.inputs.last_frame[0]].inputs.image, "end.png");
  assert.equal(typeof node.inputs.seed, "number");
  assert.ok(node.inputs.seed < 2 ** 31);

  const turbo = requiredModel("brick_api_minimax_h3_max_turbo_i2v");
  const turboGraph = await build(turbo, {
    resolution: { width: 854, height: 480, label: "480P" },
    durationSeconds: 5,
    inputImages: ["frame.png"],
  });
  const turboNode = nodeOf(turboGraph, "MinimaxHailuo03FirstLastFrameNode");
  // Capital P: "480p" is not in the node's combo.
  assert.equal(turboNode.inputs["model.resolution"], "480P");
  assert.equal(turboNode.inputs["model.prompt_expansion_mode"], "balanced");
  assert.ok(!("last_frame" in turboNode.inputs));
});

test("MiniMax H3 reference wires the reference image and clip", async () => {
  const reference = requiredModel("brick_api_minimax_h3_r2v");
  const graph = await build(reference, {
    resolution: { width: 1366, height: 768, label: "768P" },
    inputImages: ["subject.png"],
    inputVideo: "motion.mp4",
  });
  const node = nodeOf(graph, "MinimaxHailuo03ReferenceNode");
  assert.equal(node.inputs["model.resolution"], "768P");
  assert.equal(graph[node.inputs["model.reference_images.image_1"][0]].inputs.image, "subject.png");
  assert.equal(graph[node.inputs["model.reference_videos.video_1"][0]].inputs.file, "motion.mp4");
});

test("GPT Image 2.5 keeps each reference in its own slot and unlinks the unused ones", async () => {
  const gpt = requiredModel("brick_api_openai_gpt_image_2_5_flare_i2i");
  const graph = await build(gpt, {
    resolution: { width: 2048, height: 1152, label: "2048x1152" },
    inputImages: ["source.png", "material.png"],
  });
  const node = nodeOf(graph, "OpenAIGPTImageNodeV2");
  assert.equal(node.inputs.model, "gpt-image-2.5-flare");
  assert.equal(node.inputs["model.size"], "2048x1152");
  assert.ok(!("size" in node.inputs), "a flat size would be dropped by the V2 node");
  assert.equal(graph[node.inputs["model.images.image_1"][0]].inputs.image, "source.png");
  assert.equal(graph[node.inputs["model.images.image_2"][0]].inputs.image, "material.png");
  for (const slot of [3, 4, 5]) assert.ok(!(`model.images.image_${slot}` in node.inputs));
  assert.ok(!Object.values(graph).some((item: any) => item.class_type === "BatchImagesNode"));
});

test("GPT Image 2.5 and Seedream run from a prompt alone with every loader gone", async () => {
  for (const id of ["brick_api_openai_gpt_image_2_5_sunburst_i2i", "brick_api_seedream_5_0_pro"]) {
    const model = requiredModel(id);
    const graph = await build(model, { resolution: { width: 2048, height: 2048, label: "auto" } });
    assert.ok(!Object.values(graph).some((node: any) => node.class_type === "LoadImage"), id);
    const generation = Object.values(graph).find((node: any) => /GPTImageNodeV2|SeedreamNodeV3/.test(node.class_type)) as any;
    assert.ok(!Object.keys(generation.inputs).some((key) => key.includes("images.image_")), id);
  }
});

test("Seedream sends a preset by label, and matches the input's shape on Auto", async () => {
  const pro = requiredModel("brick_api_seedream_5_0_pro");
  const preset = nodeOf(
    await build(pro, { resolution: { width: 2848, height: 1600, label: "2K 16:9" }, inputImages: ["a.png"] }),
    "ByteDanceSeedreamNodeV3",
  );
  assert.equal(preset.inputs["model.size_preset"], "(2K) 2848x1600 (16:9)");
  assert.equal(typeof preset.inputs["model.seed"], "number");

  const matched = nodeOf(
    await build(pro, { resolution: { width: 2048, height: 2048, label: "auto" }, inputImages: ["a.png"] }, 4608 / 5120),
    "ByteDanceSeedreamNodeV3",
  );
  assert.equal(matched.inputs["model.size_preset"], "Custom");
  assert.ok(Math.abs(matched.inputs["model.width"] / matched.inputs["model.height"] - 0.9) < 0.01);

  // No input to match: the variant's fixed preset rather than a guess.
  const flash = requiredModel("brick_api_seedream_5_0_flash");
  const fallback = nodeOf(await build(flash, { resolution: { width: 2048, height: 2048, label: "auto" } }), "ByteDanceSeedreamNodeV3");
  assert.equal(fallback.inputs["model.size_preset"], partnerModelResolution(flash.id, "auto")?.fallbackSizePreset);
});

test("Nano Banana Pro gets Nano Banana's aspect ratio, resolution and second variation", async () => {
  const pro = requiredModel("brick_nano_banana_pro");
  assert.deepEqual(pro.supportedResolutions, ["1K", "2K", "4K"]);
  const graph = await build(pro, {
    resolution: { width: 3840, height: 2160, label: "4K" },
    inputImages: ["source.png"],
    workflowOptions: { nanoBanana: { aspectRatio: "16:9", outputCount: 2 } },
  });
  const nodes = Object.values(graph).filter((node: any) => node.class_type === "GeminiImage2Node") as any[];
  assert.equal(nodes.length, 2);
  for (const node of nodes) {
    assert.equal(node.inputs.model, "gemini-3-pro-image-preview");
    assert.equal(node.inputs.resolution, "4K");
    assert.equal(node.inputs.aspect_ratio, "16:9");
  }
  assert.notEqual(nodes[0].inputs.seed, nodes[1].inputs.seed);
});
