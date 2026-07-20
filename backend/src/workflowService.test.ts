import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getWorkflowModels, loadWorkflowForRunpod, loadWorkflowModels } from "./workflowService.js";
import type { CreateJobRequest, WorkflowModel } from "./types.js";

await loadWorkflowModels();

const gptResolutionOptions = [
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840",
];

test("new serverless workflows are discovered with multi-image and video requirements", () => {
  const gpt = requiredModel("brick_api_openai_gpt_image_2_i2i");
  const nano = requiredModel("brick_nano_banana_2");
  const klingEdit = requiredModel("brcik_api_kling_o3_video_edit");
  const seedanceEdit = requiredModel("brick_api_seedance2_0_r2v");

  assert.equal(gpt.category, "image_editing");
  assert.equal(gpt.imageSlotCount, 5);
  assert.deepEqual(gpt.supportedResolutions, gptResolutionOptions);
  assert.equal(gpt.defaultResolution, "auto");
  assert.equal(nano.category, "image_editing");
  assert.equal(nano.imageSlotCount, 4);
  assert.deepEqual(nano.supportedResolutions, ["1K", "2K", "4K"]);
  assert.equal(nano.defaultResolution, "1K");

  assert.equal(klingEdit.category, "video_editing");
  assert.equal(klingEdit.requiredInputs.includes("video"), true);
  assert.equal(klingEdit.outputType, "video");
  assert.equal(klingEdit.imageSlotCount, 3);

  assert.equal(seedanceEdit.category, "video_editing");
  assert.equal(seedanceEdit.requiredInputs.includes("video"), true);
  assert.equal(seedanceEdit.outputType, "video");
  assert.equal(seedanceEdit.imageSlotCount, 4);
});

test("GPT and Nano Banana workflows wire all provided LoadImage nodes into their batch inputs", async () => {
  const gpt = requiredModel("brick_api_openai_gpt_image_2_i2i");
  const gptWorkflow = await loadWorkflowForRunpod(
    gpt,
    request(gpt, ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"]),
    "0000_ply_graound",
    ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"],
  ) as Record<string, any>;

  assert.deepEqual(gptWorkflow["268"].inputs.image, ["278", 0]);
  assert.deepEqual(gptWorkflow["278"].inputs["images.image0"], ["272", 0]);
  assert.deepEqual(gptWorkflow["278"].inputs["images.image4"], ["277", 0]);
  assert.equal(gptWorkflow["277"].inputs.image, "0005.png");

  const partialGptWorkflow = await loadWorkflowForRunpod(
    gpt,
    request(gpt, ["0001.png", "0002.png"]),
    "0000_ply_graound",
    ["0001.png", "0002.png"],
  ) as Record<string, any>;

  assert.deepEqual(partialGptWorkflow["278"].inputs["images.image0"], ["272", 0]);
  assert.deepEqual(partialGptWorkflow["278"].inputs["images.image1"], ["273", 0]);
  assert.equal("images.image2" in partialGptWorkflow["278"].inputs, false);

  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = await loadWorkflowForRunpod(
    nano,
    request(nano, ["nano_1.png", "nano_2.png", "nano_3.png", "nano_4.png"]),
    "0000_ply_graound",
    ["nano_1.png", "nano_2.png", "nano_3.png", "nano_4.png"],
  ) as Record<string, any>;

  assert.deepEqual(nanoWorkflow["11"].inputs["images.image0"], ["3", 0]);
  assert.deepEqual(nanoWorkflow["11"].inputs["images.image3"], ["14", 0]);
  assert.equal(nanoWorkflow["14"].inputs.image, "nano_4.png");
});

test("Nano Banana workflow applies the selected output resolution", async () => {
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png"]),
      resolution: { width: 2048, height: 2048, label: "2K" },
    },
    "0000_ply_graound",
    ["nano_1.png"],
  ) as Record<string, any>;

  assert.equal(nanoWorkflow["1"].inputs.resolution, "2K");
});

test("Nano Banana workflow applies the selected aspect ratio", async () => {
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png"]),
      workflowOptions: { nanoBanana: { aspectRatio: "16:9" } },
    },
    "0000_ply_graound",
    ["nano_1.png"],
  ) as Record<string, any>;

  assert.equal(nanoWorkflow["1"].inputs.aspect_ratio, "16:9");
});

test("Nano Banana can create two output branches with different seeds", async () => {
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png", "nano_2.png"]),
      workflowOptions: { nanoBanana: { outputCount: 2 } },
    },
    "0000_ply_graound",
    ["nano_1.png", "nano_2.png"],
  ) as Record<string, any>;

  const generationEntries = Object.entries(nanoWorkflow)
    .filter(([, node]: [string, any]) => String(node.class_type ?? "").toLowerCase().includes("gemininanobanana"));
  const saveEntries = Object.entries(nanoWorkflow)
    .filter(([, node]: [string, any]) => String(node.class_type ?? "").toLowerCase().includes("saveimage"));
  const seeds = generationEntries.map(([, node]: [string, any]) => node.inputs.seed);

  assert.equal(generationEntries.length, 2);
  assert.equal(saveEntries.length, 2);
  assert.equal(new Set(seeds).size, 2);

  const generationIds = generationEntries.map(([id]) => id);
  for (const id of generationIds) {
    assert.ok(saveEntries.some(([, node]: [string, any]) => Array.isArray(node.inputs.images) && node.inputs.images[0] === id));
  }
  assert.deepEqual(generationEntries[0][1].inputs.images, generationEntries[1][1].inputs.images);
});

test("GPT image workflow can create two output branches with different seeds", async () => {
  const gpt = requiredModel("brick_api_openai_gpt_image_2_i2i");
  const gptWorkflow = await loadWorkflowForRunpod(
    gpt,
    {
      ...request(gpt, ["gpt_1.png", "gpt_2.png"]),
      resolution: { width: 2048, height: 1152, label: "2048x1152" },
      workflowOptions: { gptImage: { outputCount: 2 } },
    },
    "0000_ply_graound",
    ["gpt_1.png", "gpt_2.png"],
  ) as Record<string, any>;

  const generationEntries = Object.entries(gptWorkflow)
    .filter(([, node]: [string, any]) => String(node.class_type ?? "").toLowerCase().includes("openaigptimage"));
  const saveEntries = Object.entries(gptWorkflow)
    .filter(([, node]: [string, any]) => String(node.class_type ?? "").toLowerCase().includes("saveimage"));
  const seeds = generationEntries.map(([, node]: [string, any]) => node.inputs.seed);

  assert.equal(generationEntries.length, 2);
  assert.equal(saveEntries.length, 2);
  assert.equal(new Set(seeds).size, 2);
  assert.ok(seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 2147483647));
  assert.equal(generationEntries[0][1].inputs.size, "2048x1152");
  assert.equal(generationEntries[1][1].inputs.size, "2048x1152");
  assert.deepEqual(generationEntries[0][1].inputs.image, generationEntries[1][1].inputs.image);

  const generationIds = generationEntries.map(([id]) => id);
  for (const id of generationIds) {
    assert.ok(saveEntries.some(([, node]: [string, any]) => Array.isArray(node.inputs.images) && node.inputs.images[0] === id));
  }
});

test("GPT and Nano Banana workflows switch to text-only mode when no images are provided", async () => {
  const gpt = requiredModel("brick_api_openai_gpt_image_2_i2i");
  const gptWorkflow = await loadWorkflowForRunpod(
    gpt,
    {
      ...request(gpt, []),
      workflowOptions: { gptImage: { outputCount: 2 } },
    },
    "0000_ply_graound",
    [],
  ) as Record<string, any>;
  const gptGenerationEntries = Object.entries(gptWorkflow)
    .filter(([, node]: [string, any]) => String(node.class_type ?? "").toLowerCase().includes("openaigptimage"));

  assert.equal(gptGenerationEntries.length, 2);
  assert.ok(gptGenerationEntries.every(([, node]: [string, any]) => !("image" in node.inputs)));
  assert.equal(hasImageInputNodes(gptWorkflow), false);

  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = await loadWorkflowForRunpod(
    nano,
    request(nano, []),
    "0000_ply_graound",
    [],
  ) as Record<string, any>;

  assert.equal("images" in nanoWorkflow["1"].inputs, false);
  assert.equal(hasImageInputNodes(nanoWorkflow), false);
});

test("video edit workflows inject RunPod video filenames and multi-reference images", async () => {
  const kling = requiredModel("brcik_api_kling_o3_video_edit");
  const klingWorkflow = await loadWorkflowForRunpod(
    kling,
    request(kling, ["ref_1.png", "ref_2.png", "ref_3.png"], "source.mp4"),
    "0000_ply_graound",
    ["ref_1.png", "ref_2.png", "ref_3.png"],
  ) as Record<string, any>;

  assert.equal(klingWorkflow["25"].inputs.file, "source.mp4");
  assert.deepEqual(klingWorkflow["23"].inputs.reference_images, ["26", 0]);
  assert.deepEqual(klingWorkflow["26"].inputs["images.image2"], ["40", 0]);

  const seedance = requiredModel("brick_api_seedance2_0_r2v");
  const seedanceWorkflow = await loadWorkflowForRunpod(
    seedance,
    {
      ...request(seedance, ["main.png", "outfit_1.png", "outfit_2.png", "outfit_3.png"], "seedance.mp4"),
      durationSeconds: 9,
    },
    "0000_ply_graound",
    ["main.png", "outfit_1.png", "outfit_2.png", "outfit_3.png"],
  ) as Record<string, any>;

  assert.equal(seedanceWorkflow["364"].inputs.file, "seedance.mp4");
  assert.equal(seedanceWorkflow["356"].inputs.image, "main.png");
  assert.equal(seedanceWorkflow["354"].inputs.image, "outfit_3.png");
  assert.equal(seedanceWorkflow["359"].inputs["model.duration"], 9);

  const partialSeedanceWorkflow = await loadWorkflowForRunpod(
    seedance,
    request(seedance, ["main.png"], "seedance.mp4"),
    "0000_ply_graound",
    ["main.png"],
  ) as Record<string, any>;

  assert.equal(partialSeedanceWorkflow["356"].inputs.image, "main.png");
  assert.equal("model.reference_images.image_2" in partialSeedanceWorkflow["359"].inputs, false);
});

test("Kling video workflows randomize fixed seeds and preserve long prompts for RunPod submission", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.123456;
  try {
    const kling = requiredModel("brick_api_kling_v3_video");
    const longPrompt = "A".repeat(518);
    const klingWorkflow = await loadWorkflowForRunpod(
      kling,
      {
        ...request(kling, ["start.png"]),
        prompt: longPrompt,
        resolution: { width: 3840, height: 2160, label: "4K" },
        durationSeconds: 7,
      },
      "0000_ply_graound",
      ["start.png"],
    ) as Record<string, any>;

    assert.equal(klingWorkflow["3"].inputs.seed, Math.floor(0.123456 * 2_147_483_647));
    assert.notEqual(klingWorkflow["3"].inputs.seed, 0);
    assert.equal(klingWorkflow["3"].inputs["model.resolution"], "4k");
    assert.equal(klingWorkflow["3"].inputs["multi_shot.duration"], 7);
    assert.equal(klingWorkflow["3"].inputs["multi_shot.prompt"], longPrompt);
    assert.equal(klingWorkflow["3"].inputs["multi_shot.negative_prompt"], "");
  } finally {
    Math.random = originalRandom;
  }
});

test("Veo3 image-to-video workflow applies selected duration over scalar defaults", async () => {
  const veo = requiredModel("brick_api_veo3_i2v");
  const veoWorkflow = await loadWorkflowForRunpod(
    veo,
    {
      ...request(veo, ["start.png"]),
      durationSeconds: 6,
    },
    "0000_ply_graound",
    ["start.png"],
  ) as Record<string, any>;

  assert.equal(veoWorkflow["1"].inputs.duration_seconds, 6);
});

test("RunPod loading rejects UI workflows containing widget-bearing node types without an input mapping", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-workflow-test-"));
  const workflowPath = path.join(tempDir, "unsupported_ui_workflow.json");
  try {
    await fs.writeFile(workflowPath, JSON.stringify({
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["input.png", "image"] },
        { id: 2, type: "SomeBrandNewVideoNode", widgets_values: ["a prompt", "1080p", 5] },
      ],
      links: [],
    }), "utf8");

    const base = requiredModel("brcik_api_kling_o3_video_edit");
    const model: WorkflowModel = { ...base, workflowPath };

    await assert.rejects(
      loadWorkflowForRunpod(model, request(model, ["input.png"]), "0000_ply_graound", ["input.png"]),
      /SomeBrandNewVideoNode.*fallbackWidgetInputSpecs/s,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("RunPod loading ignores widget values on inert note nodes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-workflow-test-"));
  const workflowPath = path.join(tempDir, "noted_ui_workflow.json");
  try {
    await fs.writeFile(workflowPath, JSON.stringify({
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["input.png", "image"] },
        { id: 2, type: "Note", widgets_values: ["reminder for the artist"] },
      ],
      links: [],
    }), "utf8");

    const base = requiredModel("brcik_api_kling_o3_video_edit");
    const model: WorkflowModel = { ...base, workflowPath };

    const workflow = await loadWorkflowForRunpod(
      model,
      request(model, ["input.png"]),
      "0000_ply_graound",
      ["input.png"],
    ) as Record<string, any>;
    assert.equal(workflow["1"].inputs.image, "input.png");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function requiredModel(id: string) {
  const model = getWorkflowModels().find((item) => item.id === id);
  assert.ok(model, `Expected workflow model ${id} to be discovered.`);
  return model;
}

function hasImageInputNodes(workflow: Record<string, any>) {
  return Object.values(workflow).some((node: any) => {
    const classType = String(node.class_type ?? "").toLowerCase();
    return classType.includes("loadimage") || classType.includes("batchimagesnode") || classType.includes("imagebatchmulti");
  });
}

function request(model: WorkflowModel, inputImages: string[], inputVideo?: string): CreateJobRequest {
  return {
    projectId: "prj_playground",
    modelId: model.id,
    prompt: "make it cinematic",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: model.defaultDurationSeconds,
    inputImages,
    inputVideo,
    userId: "usr_momen",
  };
}
