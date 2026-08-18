import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectWorkflowLoadImageNames,
  detectWorkflowLoadVideoNames,
  getWorkflowModel,
  getWorkflowModels,
  loadWorkflowForRunpod,
  loadWorkflowModels,
  loadWorkflowPrompt,
  saveWorkflowSnapshot,
} from "./workflowService.js";
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

test("workflow discovery produces unique, internally consistent production models", () => {
  const models = getWorkflowModels();
  assert.ok(models.length > 0);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);

  for (const model of models) {
    assert.equal(getWorkflowModel(model.id), model);
    assert.ok(path.isAbsolute(model.workflowPath));
    assert.ok(model.supportedResolutions?.length);
    assert.ok(model.supportedResolutions?.includes(model.defaultResolution ?? model.supportedResolutions[0]));
    assert.equal(model.requiresPrompt, model.requiredInputs.includes("prompt"));
    assert.equal(
      model.requiresStartEndFrames,
      model.requiredInputs.includes("start_frame") && model.requiredInputs.includes("end_frame"),
    );
    assert.equal(model.outputType === "video", model.category.includes("video"));
    assert.ok(Number.isFinite(model.estimatedCredits) && model.estimatedCredits >= 0);
    assert.deepEqual(
      model.supportedDurations,
      [...(model.supportedDurations ?? [])].sort((a, b) => a - b),
    );
    if (model.defaultDurationSeconds != null) {
      assert.ok(model.supportedDurations?.includes(model.defaultDurationSeconds));
    }
  }
  assert.equal(getWorkflowModel("workflow_that_does_not_exist"), undefined);
});

test("discovers Flux 3 video workflows with the official limits", () => {
  const firstLast = getWorkflowModel("brick_api_flux3_flf2v");
  const imageToVideo = getWorkflowModel("brick_api_flux3_i2v");
  const expectedDurations = Array.from({ length: 16 }, (_, index) => index + 5);

  assert.equal(firstLast?.category, "first_last_frame_to_video");
  assert.equal(firstLast?.requiresStartEndFrames, true);
  assert.equal(firstLast?.imageSlotCount, 2);
  assert.deepEqual(firstLast?.supportedDurations, expectedDurations);
  assert.deepEqual(firstLast?.supportedResolutions, ["720p", "1080p"]);

  assert.equal(imageToVideo?.category, "image_to_video");
  assert.equal(imageToVideo?.requiresStartEndFrames, false);
  assert.equal(imageToVideo?.imageSlotCount, 1);
  assert.deepEqual(imageToVideo?.supportedDurations, expectedDurations);
  assert.deepEqual(imageToVideo?.supportedResolutions, ["720p", "1080p"]);
  assert.equal(getWorkflowModel("brick_api_flux3_image_editing"), undefined);
});

test("Flux 3 workflows connect keyframes from the zero-based image_0 slot", async () => {
  const firstLast = requiredModel("brick_api_flux3_flf2v");
  const firstLastPrompt = (await loadWorkflowForRunpod(
    firstLast,
    request(firstLast, ["start.png", "end.png"]),
    "0000_ply_graound",
    ["start.png", "end.png"],
  )) as Record<string, any>;
  const firstLastInputs = firstLastPrompt["3"].inputs;
  assert.deepEqual(firstLastInputs["keyframes.image_0"], ["1", 0]);
  assert.deepEqual(firstLastInputs["keyframes.image_1"], ["2", 0]);
  assert.equal(firstLastInputs["keyframes.image_2"], undefined);

  const imageToVideo = requiredModel("brick_api_flux3_i2v");
  const imageToVideoPrompt = (await loadWorkflowForRunpod(
    imageToVideo,
    request(imageToVideo, ["start.png"]),
    "0000_ply_graound",
    ["start.png"],
  )) as Record<string, any>;
  assert.deepEqual(imageToVideoPrompt["2"].inputs["keyframes.image_0"], ["1", 0]);
  assert.equal(imageToVideoPrompt["2"].inputs["keyframes.image_1"], undefined);
});

test("detects provider image/video field names from API and UI workflow shapes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-workflow-input-names-"));
  try {
    const apiPath = path.join(tempDir, "api.json");
    await fs.writeFile(
      apiPath,
      JSON.stringify({
        "1": { class_type: "LoadImage", inputs: { image: "api-first.png" } },
        "2": { class_type: "LoadImage", inputs: { image: "api-second.png" } },
        "3": { class_type: "LoadVideo", inputs: { file: "api-source.mp4" } },
      }),
    );
    const base = requiredModel("brick_api_kling_v3_video");
    const apiModel = { ...base, workflowPath: apiPath };
    assert.deepEqual(await detectWorkflowLoadImageNames(apiModel), ["api-first.png", "api-second.png"]);
    assert.deepEqual(await detectWorkflowLoadVideoNames(apiModel), ["api-source.mp4"]);

    const uiPath = path.join(tempDir, "ui.json");
    await fs.writeFile(
      uiPath,
      JSON.stringify({
        nodes: [
          { id: 8, type: "LoadImage", widgets_values: ["ui-image.png"] },
          { id: 9, type: "LoadVideo", widgets_values: ["ui-video.mov"] },
        ],
        links: [],
      }),
    );
    const uiModel = { ...base, workflowPath: uiPath };
    assert.deepEqual(await detectWorkflowLoadImageNames(uiModel), ["ui-image.png"]);
    assert.deepEqual(await detectWorkflowLoadVideoNames(uiModel), ["ui-video.mov"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("local Comfy prompt loading survives unavailable object info and maps core inputs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-local-workflow-"));
  const workflowPath = path.join(tempDir, "local.json");
  try {
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        "1": { class_type: "LoadImage", inputs: { image: "old.png" } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "old prompt" } },
        "3": { class_type: "KSampler", inputs: { seed: 1 } },
      }),
    );
    const base = requiredModel("brick_api_openai_gpt_image_2_i2i");
    const model: WorkflowModel = { ...base, workflowPath, imageSlotCount: 1 };
    const prompt = (await loadWorkflowPrompt(
      model,
      { ...request(model, ["new.png"]), prompt: "new prompt" },
      "1234_Project",
      "http://127.0.0.1:1",
    )) as Record<string, any>;

    assert.equal(prompt["1"].inputs.image, "new.png");
    assert.equal(prompt["2"].inputs.text, "new prompt");
    assert.ok(Number.isInteger(prompt["3"].inputs.seed));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("invalid or missing workflow JSON fails explicitly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-invalid-workflow-"));
  try {
    const invalidPath = path.join(tempDir, "invalid.json");
    await fs.writeFile(invalidPath, "{ invalid json", "utf8");
    const base = requiredModel("brick_api_kling_v3_video");

    await assert.rejects(
      loadWorkflowForRunpod({ ...base, workflowPath: invalidPath }, request(base, ["image.png"]), "Project", ["image.png"]),
      SyntaxError,
    );
    await assert.rejects(
      loadWorkflowForRunpod(
        { ...base, workflowPath: path.join(tempDir, "missing.json") },
        request(base, ["image.png"]),
        "Project",
        ["image.png"],
      ),
      /enoent/i,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("workflow snapshots round-trip and redact embedded media payloads", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-workflow-snapshot-"));
  try {
    const snapshotPath = path.join(tempDir, "nested", "workflow.json");
    await saveWorkflowSnapshot(snapshotPath, { node: { inputs: { prompt: "safe" } } });
    assert.deepEqual(JSON.parse(await fs.readFile(snapshotPath, "utf8")), { node: { inputs: { prompt: "safe" } } });

    // Inline-transport still image presets put the input image inside the graph.
    // This used to throw, and the snapshot is written before submission, so the
    // render died before it was ever sent. The payload is replaced instead.
    await saveWorkflowSnapshot(snapshotPath, { image: "data:image/png;base64,AQID" });
    const written = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    assert.match(written.image, /embedded media omitted/);
    assert.ok(!written.image.includes("AQID"), "the payload itself must not survive into the snapshot");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("saving a snapshot leaves the graph it was given untouched", async () => {
  // The caller hands this exact object to the provider immediately afterwards.
  // Redacting in place would submit a graph with no image in it -- a paid run
  // that cannot succeed, and a failure that would look like the provider's.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-workflow-snapshot-mutate-"));
  try {
    const base64 = "A".repeat(200_000);
    const workflow = { "63": { inputs: { image: base64, upscale: 4 } } };
    await saveWorkflowSnapshot(path.join(tempDir, "workflow.json"), workflow);

    assert.equal(workflow["63"].inputs.image, base64, "the in-memory graph must still carry the image");
    assert.equal(workflow["63"].inputs.upscale, 4);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

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
  const gptWorkflow = (await loadWorkflowForRunpod(
    gpt,
    request(gpt, ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"]),
    "0000_ply_graound",
    ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"],
  )) as Record<string, any>;

  assert.deepEqual(gptWorkflow["268"].inputs.image, ["278", 0]);
  assert.deepEqual(gptWorkflow["278"].inputs["images.image0"], ["272", 0]);
  assert.deepEqual(gptWorkflow["278"].inputs["images.image4"], ["277", 0]);
  assert.equal(gptWorkflow["277"].inputs.image, "0005.png");

  const partialGptWorkflow = (await loadWorkflowForRunpod(gpt, request(gpt, ["0001.png", "0002.png"]), "0000_ply_graound", [
    "0001.png",
    "0002.png",
  ])) as Record<string, any>;

  assert.deepEqual(partialGptWorkflow["278"].inputs["images.image0"], ["272", 0]);
  assert.deepEqual(partialGptWorkflow["278"].inputs["images.image1"], ["273", 0]);
  assert.equal("images.image2" in partialGptWorkflow["278"].inputs, false);

  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = (await loadWorkflowForRunpod(
    nano,
    request(nano, ["nano_1.png", "nano_2.png", "nano_3.png", "nano_4.png"]),
    "0000_ply_graound",
    ["nano_1.png", "nano_2.png", "nano_3.png", "nano_4.png"],
  )) as Record<string, any>;

  assert.deepEqual(nanoWorkflow["11"].inputs["images.image0"], ["3", 0]);
  assert.deepEqual(nanoWorkflow["11"].inputs["images.image3"], ["14", 0]);
  assert.equal(nanoWorkflow["14"].inputs.image, "nano_4.png");
});

test("Nano Banana workflow applies the selected output resolution", async () => {
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = (await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png"]),
      resolution: { width: 2048, height: 2048, label: "2K" },
    },
    "0000_ply_graound",
    ["nano_1.png"],
  )) as Record<string, any>;

  assert.equal(nanoWorkflow["1"].inputs.resolution, "2K");
});

test("Nano Banana workflow applies the selected aspect ratio", async () => {
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = (await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png"]),
      workflowOptions: { nanoBanana: { aspectRatio: "16:9" } },
    },
    "0000_ply_graound",
    ["nano_1.png"],
  )) as Record<string, any>;

  assert.equal(nanoWorkflow["1"].inputs.aspect_ratio, "16:9");
});

test("Nano Banana can create two output branches with different seeds", async () => {
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = (await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png", "nano_2.png"]),
      workflowOptions: { nanoBanana: { outputCount: 2 } },
    },
    "0000_ply_graound",
    ["nano_1.png", "nano_2.png"],
  )) as Record<string, any>;

  const generationEntries = Object.entries(nanoWorkflow).filter(([, node]: [string, any]) =>
    String(node.class_type ?? "")
      .toLowerCase()
      .includes("gemininanobanana"),
  );
  const saveEntries = Object.entries(nanoWorkflow).filter(([, node]: [string, any]) =>
    String(node.class_type ?? "")
      .toLowerCase()
      .includes("saveimage"),
  );
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
  const gptWorkflow = (await loadWorkflowForRunpod(
    gpt,
    {
      ...request(gpt, ["gpt_1.png", "gpt_2.png"]),
      resolution: { width: 2048, height: 1152, label: "2048x1152" },
      workflowOptions: { gptImage: { outputCount: 2 } },
    },
    "0000_ply_graound",
    ["gpt_1.png", "gpt_2.png"],
  )) as Record<string, any>;

  const generationEntries = Object.entries(gptWorkflow).filter(([, node]: [string, any]) =>
    String(node.class_type ?? "")
      .toLowerCase()
      .includes("openaigptimage"),
  );
  const saveEntries = Object.entries(gptWorkflow).filter(([, node]: [string, any]) =>
    String(node.class_type ?? "")
      .toLowerCase()
      .includes("saveimage"),
  );
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
  const gptWorkflow = (await loadWorkflowForRunpod(
    gpt,
    {
      ...request(gpt, []),
      workflowOptions: { gptImage: { outputCount: 2 } },
    },
    "0000_ply_graound",
    [],
  )) as Record<string, any>;
  const gptGenerationEntries = Object.entries(gptWorkflow).filter(([, node]: [string, any]) =>
    String(node.class_type ?? "")
      .toLowerCase()
      .includes("openaigptimage"),
  );

  assert.equal(gptGenerationEntries.length, 2);
  assert.ok(gptGenerationEntries.every(([, node]: [string, any]) => !("image" in node.inputs)));
  assert.equal(hasImageInputNodes(gptWorkflow), false);

  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = (await loadWorkflowForRunpod(nano, request(nano, []), "0000_ply_graound", [])) as Record<string, any>;

  assert.equal("images" in nanoWorkflow["1"].inputs, false);
  assert.equal(hasImageInputNodes(nanoWorkflow), false);
});

test("video edit workflows inject RunPod video filenames and multi-reference images", async () => {
  const kling = requiredModel("brcik_api_kling_o3_video_edit");
  const klingWorkflow = (await loadWorkflowForRunpod(
    kling,
    request(kling, ["ref_1.png", "ref_2.png", "ref_3.png"], "source.mp4"),
    "0000_ply_graound",
    ["ref_1.png", "ref_2.png", "ref_3.png"],
  )) as Record<string, any>;

  assert.equal(klingWorkflow["25"].inputs.file, "source.mp4");
  assert.deepEqual(klingWorkflow["23"].inputs.reference_images, ["26", 0]);
  assert.deepEqual(klingWorkflow["26"].inputs["images.image2"], ["40", 0]);

  const seedance = requiredModel("brick_api_seedance2_0_r2v");
  const seedanceWorkflow = (await loadWorkflowForRunpod(
    seedance,
    {
      ...request(seedance, ["main.png", "outfit_1.png", "outfit_2.png", "outfit_3.png"], "seedance.mp4"),
      durationSeconds: 9,
    },
    "0000_ply_graound",
    ["main.png", "outfit_1.png", "outfit_2.png", "outfit_3.png"],
  )) as Record<string, any>;

  assert.equal(seedanceWorkflow["364"].inputs.file, "seedance.mp4");
  assert.equal(seedanceWorkflow["356"].inputs.image, "main.png");
  assert.equal(seedanceWorkflow["354"].inputs.image, "outfit_3.png");
  assert.equal(seedanceWorkflow["359"].inputs["model.duration"], 9);

  const partialSeedanceWorkflow = (await loadWorkflowForRunpod(
    seedance,
    request(seedance, ["main.png"], "seedance.mp4"),
    "0000_ply_graound",
    ["main.png"],
  )) as Record<string, any>;

  assert.equal(partialSeedanceWorkflow["356"].inputs.image, "main.png");
  assert.equal("model.reference_images.image_2" in partialSeedanceWorkflow["359"].inputs, false);
});

test("Seedance workflows apply the selected output ratio to both node types", async () => {
  const reference = requiredModel("brick_api_seedance2_0_r2v");
  const referenceWorkflow = (await loadWorkflowForRunpod(
    reference,
    {
      ...request(reference, ["main.png"], "seedance.mp4"),
      workflowOptions: { seedance: { ratio: "9:16" } },
    },
    "0000_ply_graound",
    ["main.png"],
  )) as Record<string, any>;

  assert.equal(referenceWorkflow["359"].inputs["model.ratio"], "9:16");

  const firstLast = requiredModel("brick_api_seedance_2_0flf2v");
  const firstLastWorkflow = (await loadWorkflowForRunpod(
    firstLast,
    {
      ...request(firstLast, ["start.png", "end.png"]),
      workflowOptions: { seedance: { ratio: "adaptive" } },
    },
    "0000_ply_graound",
    ["start.png", "end.png"],
  )) as Record<string, any>;

  assert.equal(firstLastWorkflow["1"].inputs["model.ratio"], "adaptive");
});

test("Seedance workflows keep their saved ratio when none is selected or the value is unknown", async () => {
  const firstLast = requiredModel("brick_api_seedance_2_0flf2v");
  const untouched = (await loadWorkflowForRunpod(
    firstLast,
    request(firstLast, ["start.png", "end.png"]),
    "0000_ply_graound",
    ["start.png", "end.png"],
  )) as Record<string, any>;

  assert.equal(untouched["1"].inputs["model.ratio"], "16:9");

  const rejected = (await loadWorkflowForRunpod(
    firstLast,
    {
      ...request(firstLast, ["start.png", "end.png"]),
      workflowOptions: { seedance: { ratio: "banana:9" } },
    },
    "0000_ply_graound",
    ["start.png", "end.png"],
  )) as Record<string, any>;

  assert.equal(rejected["1"].inputs["model.ratio"], "16:9");
});

test("Kling video workflows randomize fixed seeds and preserve long prompts for RunPod submission", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.123456;
  try {
    const kling = requiredModel("brick_api_kling_v3_video");
    const longPrompt = "A".repeat(518);
    const klingWorkflow = (await loadWorkflowForRunpod(
      kling,
      {
        ...request(kling, ["start.png"]),
        prompt: longPrompt,
        resolution: { width: 3840, height: 2160, label: "4K" },
        durationSeconds: 7,
      },
      "0000_ply_graound",
      ["start.png"],
    )) as Record<string, any>;

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
  const veoWorkflow = (await loadWorkflowForRunpod(
    veo,
    {
      ...request(veo, ["start.png"]),
      durationSeconds: 6,
    },
    "0000_ply_graound",
    ["start.png"],
  )) as Record<string, any>;

  assert.equal(veoWorkflow["1"].inputs.duration_seconds, 6);
});

// Every shipped graph, checked for widget values whose type contradicts the input
// they sit in.
//
// Brick_api_veo3_i2v.json carried "negative_prompt": 8 and "duration_seconds": true
// from the initial import, so every Veo3 image-to-video render ever submitted sent
// the provider a negative prompt of 8. Nothing caught it: the graph parses, the
// worker accepted it, and duration_seconds is overwritten at submit so its type was
// invisible. Only reading the JSON by hand found it.
//
// A duration may legitimately be a string on some API nodes -- Flux3 ships
// "duration": "5" and injectInputs preserves whichever type it finds -- so the rule
// is "not a boolean" rather than "a number".
test("no shipped workflow holds a widget value of the wrong type", async () => {
  const suspects: string[] = [];

  for (const model of getWorkflowModels()) {
    if (!model.workflowPath) continue;
    let graph: Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }>;
    try {
      graph = JSON.parse(await fs.readFile(model.workflowPath, "utf8"));
    } catch {
      continue;
    }

    for (const [nodeId, node] of Object.entries(graph)) {
      for (const [name, value] of Object.entries(node?.inputs ?? {})) {
        // An array is a link to another node's output, not a widget value.
        if (Array.isArray(value)) continue;
        const where = `${path.basename(model.workflowPath)} node ${nodeId} ${String(node?.class_type)} ${name}`;
        const leaf = name.toLowerCase().split(".").at(-1) ?? "";

        if (/negative/.test(name.toLowerCase()) && /prompt/.test(name.toLowerCase()) && typeof value !== "string") {
          suspects.push(`${where} = ${JSON.stringify(value)} (want a string)`);
        }
        if (["prompt", "text", "positive_prompt"].includes(leaf) && typeof value !== "string") {
          suspects.push(`${where} = ${JSON.stringify(value)} (want a string)`);
        }
        if (["duration", "duration_seconds", "video_duration", "length_seconds"].includes(leaf)) {
          if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string")) {
            suspects.push(`${where} = ${JSON.stringify(value)} (want a number or a numeric string)`);
          }
        }
        if (leaf === "seed" && typeof value !== "number") {
          suspects.push(`${where} = ${JSON.stringify(value)} (want a number)`);
        }
      }
    }
  }

  assert.deepEqual(suspects, [], `Widget values contradict their inputs:\n  ${suspects.join("\n  ")}`);
});

test("Veo3 image-to-video sends no negative prompt unless one is asked for", async () => {
  const veo = requiredModel("brick_api_veo3_i2v");
  const veoWorkflow = (await loadWorkflowForRunpod(
    veo,
    request(veo, ["start.png"]),
    "0000_ply_graound",
    ["start.png"],
  )) as Record<string, any>;

  // Empty, and specifically not the request's own prompt: isEditablePromptInput
  // excludes anything containing "negative", which is what makes an empty string
  // safe to store here.
  assert.equal(veoWorkflow["1"].inputs.negative_prompt, "");
  assert.notEqual(veoWorkflow["1"].inputs.prompt, "");
});

// Two node families share the `resolution` input and disagree about one option:
// GeminiNanoBanana2 offers 1K/2K/4K, the Veo3 nodes offer 720p/1080p/4k. Sending
// "4K" to a Veo3 node is refused by the worker before it renders anything, which is
// what every 4K Veo3 submission did:
//
//   resolution: '4K' not in ['720p', '1080p', '4k']
test("Veo3 takes 4K in the lower case its node actually offers", async () => {
  const veo = requiredModel("brick_api_veo3_i2v");
  const veoWorkflow = (await loadWorkflowForRunpod(
    veo,
    {
      ...request(veo, ["start.png"]),
      resolution: { width: 3840, height: 2160, label: "4K" },
    },
    "0000_ply_graound",
    ["start.png"],
  )) as Record<string, any>;

  assert.equal(veoWorkflow["1"].inputs.resolution, "4k");
});

test("Veo3 still takes the resolutions that were never in dispute", async () => {
  const veo = requiredModel("brick_api_veo3_i2v");
  for (const label of ["720p", "1080p"]) {
    const veoWorkflow = (await loadWorkflowForRunpod(
      veo,
      {
        ...request(veo, ["start.png"]),
        resolution: { width: 1920, height: 1080, label },
      },
      "0000_ply_graound",
      ["start.png"],
    )) as Record<string, any>;

    assert.equal(veoWorkflow["1"].inputs.resolution, label);
  }
});

test("Nano Banana keeps the upper case its own node offers", async () => {
  // The other vocabulary, and the reason this cannot simply be lower-cased: the
  // node ships holding "1K", which is how the graph declares which scale it speaks.
  const nano = requiredModel("brick_nano_banana_2");
  const nanoWorkflow = (await loadWorkflowForRunpod(
    nano,
    {
      ...request(nano, ["nano_1.png"]),
      resolution: { width: 4096, height: 4096, label: "4K" },
    },
    "0000_ply_graound",
    ["nano_1.png"],
  )) as Record<string, any>;

  assert.equal(nanoWorkflow["1"].inputs.resolution, "4K");
});

test("RunPod loading rejects UI workflows containing widget-bearing node types without an input mapping", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-workflow-test-"));
  const workflowPath = path.join(tempDir, "unsupported_ui_workflow.json");
  try {
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          { id: 1, type: "LoadImage", widgets_values: ["input.png", "image"] },
          { id: 2, type: "SomeBrandNewVideoNode", widgets_values: ["a prompt", "1080p", 5] },
        ],
        links: [],
      }),
      "utf8",
    );

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
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          { id: 1, type: "LoadImage", widgets_values: ["input.png", "image"] },
          { id: 2, type: "Note", widgets_values: ["reminder for the artist"] },
        ],
        links: [],
      }),
      "utf8",
    );

    const base = requiredModel("brcik_api_kling_o3_video_edit");
    const model: WorkflowModel = { ...base, workflowPath };

    const workflow = (await loadWorkflowForRunpod(model, request(model, ["input.png"]), "0000_ply_graound", [
      "input.png",
    ])) as Record<string, any>;
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
