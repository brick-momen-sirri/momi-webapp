import test from "node:test";
import assert from "node:assert/strict";

import { normalizeStillImageOptions } from "./stillImageRequest.js";
import {
  buildStillImageWorkflow,
  stillImageInputTransport,
  stillImageWorkflowPath,
  type StillImageGraph,
} from "./stillImageWorkflow.js";

// These run against the real exported graphs in workflow-still-images/, not
// fixtures. That is the point: the node ids are the contract with momi-forge, and
// a re-export that renumbers anything should fail here rather than on a pod.

let seedCounter = 0;
const seeds = () => {
  seedCounter += 1;
  return seedCounter;
};

async function build(categoryId: string, settings: Record<string, unknown>, images: string[], prompt?: string) {
  seedCounter = 0;
  return buildStillImageWorkflow({
    options: normalizeStillImageOptions({ categoryId, settings }),
    images,
    prompt,
    nextSeed: seeds,
  });
}

const link = (graph: StillImageGraph, nodeId: string, input: string) => graph[nodeId]?.inputs?.[input];
const value = (graph: StillImageGraph, nodeId: string, input: string) => graph[nodeId]?.inputs?.[input];

// Slots and a node floor per preset. Driven off STILL_IMAGE_CATEGORY_IDS rather
// than a literal list so adding a preset without a graph fails here.
const PRESET_SHAPE: Record<string, { images: string[]; minNodes: number }> = {
  "general-enhancement": { images: ["a"], minNodes: 30 },
  "pro-upscaler": { images: ["a"], minNodes: 30 },
  "reference-generator": { images: ["a", "b"], minNodes: 30 },
  "qwen-edit": { images: ["a"], minNodes: 30 },
  // Ten nodes, and eight of them are plumbing around one remote call. A floor in
  // the thirties is a sampling graph's shape, not this one's.
  "image-editing": { images: ["a", "b", "c"], minNodes: 8 },
};

test("every preset resolves to a graph file that exists and parses", async () => {
  const { STILL_IMAGE_CATEGORY_IDS } = await import("./stillImageCategories.js");

  for (const categoryId of STILL_IMAGE_CATEGORY_IDS) {
    const shape = PRESET_SHAPE[categoryId];
    assert.ok(shape, `${categoryId} has no entry in PRESET_SHAPE`);
    const built = await build(categoryId, {}, shape.images, "prompt");
    assert.ok(Object.keys(built).length >= shape.minNodes, `${categoryId} graph looks too small`);
    assert.ok(stillImageWorkflowPath(categoryId).endsWith(`${categoryId}.json`));
  }
});

test("Flux 2 Klein Realistic mode resolves the dedicated Forge graph", async () => {
  const graphPath = stillImageWorkflowPath("qwen-edit", { mode: "realistic" });
  assert.ok(graphPath.endsWith("qwen-edit-realistic.json"));
  assert.notEqual(graphPath, stillImageWorkflowPath("qwen-edit"));
});

test("preset graphs live outside every scanned workflow root", async () => {
  // loadWorkflowModels recurses workflowRoots and turns each JSON into a
  // selectable model. If these four ever land inside one, four local-GPU preset
  // graphs appear in the Animation model picker and get dispatched to the shared
  // pod, where they fail on their first loader node.
  const { workflowRoots, stillImageWorkflowRoot } = await import("./config.js");
  const { isPathWithinRoot } = await import("./pathContainment.js");

  for (const root of workflowRoots) {
    assert.equal(
      isPathWithinRoot(stillImageWorkflowRoot, root),
      false,
      `still image graphs must not sit under the scanned root ${root}`,
    );
  }
});

test("every configured binding is satisfied by the real exported graph", async () => {
  // The bindings are the whole safety story for input routing, so they are checked
  // against the actual exports rather than trusted. A re-export that renumbers or
  // renames an input fails here instead of silently dropping an image.
  const { assertStillImageBindings, stillImageInputBindings } = await import("./stillImageWorkflow.js");
  const fs = await import("node:fs/promises");

  const counts: Record<string, number> = {
    "general-enhancement": 1,
    "pro-upscaler": 1,
    "reference-generator": 2,
    "qwen-edit": 3,
    "image-editing": 3,
  };

  for (const [categoryId, imageCount] of Object.entries(counts)) {
    const id = categoryId as keyof typeof counts & Parameters<typeof stillImageInputBindings>[0];
    const graph = JSON.parse(await fs.readFile(stillImageWorkflowPath(id), "utf8"));
    assert.doesNotThrow(() => assertStillImageBindings(graph, id, imageCount), `${categoryId} bindings`);

    for (const binding of stillImageInputBindings(id, imageCount)) {
      assert.ok(graph[binding.nodeId], `${categoryId} slot ${binding.slot} node ${binding.nodeId} exists`);
      assert.ok(
        binding.inputName in graph[binding.nodeId].inputs,
        `${categoryId} slot ${binding.slot} input ${binding.inputName} exists`,
      );
    }
  }
});

test("a binding pointing at a missing node is a configuration error", async () => {
  // Mutation check for assertStillImageBindings: without it, the binding pass would
  // throw an unrelated TypeError deep in the build, or worse, write nothing.
  const { assertStillImageBindings } = await import("./stillImageWorkflow.js");
  assert.throws(
    () => assertStillImageBindings({ "999": { inputs: {} } }, "pro-upscaler", 1),
    /binds slot 1 to node 99, which the workflow does not contain/,
  );
  assert.throws(
    () => assertStillImageBindings({ "99": { inputs: { unrelated: 1 } } }, "pro-upscaler", 1),
    /binds slot 1 to 99\.image, which that node does not have/,
  );
});

test("the dead LoadImage in general enhancement is never a slot", async () => {
  // Node 81 sits in the disconnected drawn-mask branch. Class-name scanning finds
  // it; the explicit bindings must not.
  const { stillImageInputBindings } = await import("./stillImageWorkflow.js");
  const bindings = stillImageInputBindings("general-enhancement", 1);
  assert.deepEqual(
    bindings.map((binding) => binding.nodeId),
    ["63"],
  );
  assert.equal(
    bindings.some((binding) => binding.nodeId === "81"),
    false,
  );

  const graph = await build("general-enhancement", {}, ["BASE64DATA"]);
  assert.equal(value(graph, "63", "image"), "BASE64DATA");
  assert.notEqual(value(graph, "81", "image"), "BASE64DATA", "the dead node must keep its exported value");
});

test("ETN_LoadImageBase64 nodes are bound as base64, never as filename slots", async () => {
  const { stillImageInputBindings } = await import("./stillImageWorkflow.js");
  const fs = await import("node:fs/promises");

  for (const [categoryId, imageCount] of [
    ["general-enhancement", 1],
    ["reference-generator", 2],
  ] as const) {
    const graph = JSON.parse(await fs.readFile(stillImageWorkflowPath(categoryId), "utf8"));
    for (const binding of stillImageInputBindings(categoryId, imageCount)) {
      const classType = String(graph[binding.nodeId].class_type).toLowerCase();
      assert.match(classType, /etn_loadimagebase64/, `${categoryId} slot ${binding.slot}`);
      assert.equal(binding.mode, "base64", "a base64 node must be bound in base64 mode");
    }
  }

  // And the converse: the LoadImage presets are bound in filename mode.
  for (const [categoryId, imageCount] of [
    ["pro-upscaler", 1],
    ["qwen-edit", 3],
  ] as const) {
    const graph = JSON.parse(await fs.readFile(stillImageWorkflowPath(categoryId), "utf8"));
    for (const binding of stillImageInputBindings(categoryId, imageCount)) {
      assert.equal(String(graph[binding.nodeId].class_type), "LoadImage", `${categoryId} slot ${binding.slot}`);
      assert.equal(binding.mode, "load-image");
    }
  }
});

test("the qwen bindings give distinct nodes and distinct filenames", async () => {
  // Mutation check for the collision fix: nodes 121 and 165 hold the same exported
  // value, so only the per-slot filenames keep them apart.
  const { stillImageInputBindings } = await import("./stillImageWorkflow.js");
  const bindings = stillImageInputBindings("qwen-edit", 3);
  const nodeIds = bindings.map((binding) => binding.nodeId);
  const filenames = bindings.map((binding) => (binding.mode === "load-image" ? binding.filename : ""));

  assert.deepEqual(nodeIds, ["76", "121", "165"]);
  assert.equal(new Set(nodeIds).size, 3);
  assert.equal(new Set(filenames).size, 3, "each slot has its own destination filename");
});

test("image transport differs per preset, matching the node each graph carries", () => {
  // ETN_LoadImageBase64 presets need the bytes in the node; LoadImage presets need
  // a filename and the bytes in the RunPod payload.
  assert.equal(stillImageInputTransport("general-enhancement"), "inline_base64");
  assert.equal(stillImageInputTransport("reference-generator"), "inline_base64");
  assert.equal(stillImageInputTransport("pro-upscaler"), "load_image_name");
  assert.equal(stillImageInputTransport("qwen-edit"), "load_image_name");
});

test("the wrong number of images is refused before any mutation", async () => {
  await assert.rejects(() => build("reference-generator", {}, ["only-one"]), /expects 2 input image\(s\); received 1/);
  await assert.rejects(() => build("pro-upscaler", {}, []), /expects 1 input image\(s\); received 0/);
  await assert.rejects(() => build("pro-upscaler", {}, [""]), /empty input image slot/);
});

// -- general enhancement -----------------------------------------------------

test("general enhancement writes each slider to its own node", async () => {
  const graph = await build(
    "general-enhancement",
    {
      details: 1.5,
      generalDenoise: 0.2,
      advancedDetails: true,
      detailPass: 0.5,
      sharpen: 0.6,
      bodyEnhance: true,
      bodyDenoise: 0.25,
      faceDenoise: 0.15,
    },
    ["BASE64DATA"],
    "keep the brickwork",
  );

  assert.equal(value(graph, "37", "strength_model"), 1.5, "details -> detail LoRA");
  assert.equal(value(graph, "32", "denoise"), 0.2, "generalDenoise -> KSampler");
  assert.equal(value(graph, "23", "denoise"), 0.5, "detailPass -> BasicScheduler");
  assert.equal(value(graph, "74", "blend_factor"), 0.6, "sharpen -> Blend");
  assert.equal(value(graph, "52", "denoise"), 0.25, "bodyDenoise -> body FaceDetailerPipe");
  assert.equal(value(graph, "54", "denoise"), 0.15, "faceDenoise -> face FaceDetailerPipe");
});

test("general enhancement puts base64 in the node and the prompt in both places", async () => {
  const graph = await build("general-enhancement", {}, ["BASE64DATA"], "  keep the brickwork  ");

  assert.equal(value(graph, "63", "image"), "BASE64DATA");
  assert.equal(value(graph, "35", "text_a"), "keep the brickwork", "trimmed");
  assert.equal(value(graph, "33", "custom_prompt"), "keep the brickwork");
});

test("general enhancement always takes the generated mask route", async () => {
  // This UI has no mask editor, so the drawn-mask branch must never be selected.
  const graph = await build("general-enhancement", {}, ["BASE64DATA"]);
  assert.deepEqual(link(graph, "13", "mask"), ["85", 0]);
});

// -- reproducibility ---------------------------------------------------------
//
// The tests below build without injecting nextSeed, which is what production
// does: the draws come from the job's own master seed.

test("the same job seed rebuilds the same graph seeds", async () => {
  const options = normalizeStillImageOptions({ categoryId: "general-enhancement", settings: {} }, () => 9_876_543);
  const seedNodes: Array<[string, string]> = [
    ["32", "seed"],
    ["26", "noise_seed"],
    ["52", "seed"],
    ["54", "seed"],
  ];

  const first = await buildStillImageWorkflow({ options, images: ["a"], prompt: "p" });
  const second = await buildStillImageWorkflow({ options, images: ["a"], prompt: "p" });

  assert.deepEqual(
    seedNodes.map(([node, input]) => value(first, node, input)),
    seedNodes.map(([node, input]) => value(second, node, input)),
    "re-rendering a saved seed must reproduce the render, not roll a new one",
  );
});

test("a different job seed renders differently", async () => {
  const build = async (seed: number) =>
    buildStillImageWorkflow({
      options: normalizeStillImageOptions({ categoryId: "qwen-edit", settings: {} }, () => seed),
      images: ["a"],
      prompt: "p",
    });

  assert.notEqual(value(await build(11), "141", "noise_seed"), value(await build(12), "141", "noise_seed"));
});

test("a job recorded before seeds existed still renders", async () => {
  // Everything already on disk looks like this. It cannot be reproduced -- there
  // is nothing to reproduce it from -- but it must not fail to build.
  const graph = await buildStillImageWorkflow({
    options: { categoryId: "qwen-edit", settings: { mode: "edit", imageCount: "1" } },
    images: ["a"],
    prompt: "p",
  });
  assert.equal(typeof value(graph, "141", "noise_seed"), "number");
});

test("general enhancement randomizes all four seeds", async () => {
  const graph = await build("general-enhancement", {}, ["BASE64DATA"]);
  assert.deepEqual(
    [value(graph, "32", "seed"), value(graph, "26", "noise_seed"), value(graph, "52", "seed"), value(graph, "54", "seed")],
    [1, 2, 3, 4],
    "each seed comes from a fresh draw, so repeat runs differ",
  );
});

test("editor enhancement loads the painted mask and activates the drawn-mask route", async () => {
  const edit = editMetadata("enhance", []);
  const graph = await buildStillImageWorkflow({
    options: normalizeStillImageOptions({ categoryId: "general-enhancement", settings: {}, edit }),
    images: ["SOURCE_BASE64", "MASK_BASE64"],
    prompt: "enhance the stone detail",
    nextSeed: seeds,
  });

  assert.equal(value(graph, "63", "image"), "SOURCE_BASE64");
  assert.equal(value(graph, "86", "image"), "MASK_BASE64");
  assert.deepEqual(link(graph, "13", "mask"), ["88", 0]);
});

test("reference generator randomizes its sampler seeds but not the captioner", async () => {
  // The exported graph ships both pipeKSamplers on seed 77, so before this the
  // same two inputs always produced the same image and re-rendering for a
  // different take was a no-op.
  const graph = await build("reference-generator", {}, ["BASE64A", "BASE64B"]);
  assert.deepEqual(
    [value(graph, "11", "seed"), value(graph, "12", "seed"), value(graph, "16", "seed"), value(graph, "139", "noise_seed")],
    [1, 2, 3, 4],
    "each seed comes from a fresh draw, so repeat runs differ",
  );

  // Node 53 is the AILab_QwenVL captioner. general-enhancement and qwen-edit
  // both leave their equivalent fixed; varying it changes the description of the
  // input rather than the render, which is not what a new seed means here.
  assert.equal(value(graph, "53", "seed"), 78, "the captioner seed stays as exported");
});

test("hidden sliders leave the graph default rather than writing undefined", async () => {
  // generalDenoise is dropped by the normalizer when its branch is off. Writing
  // it anyway would put `undefined` into a live node input.
  const graph = await build("general-enhancement", { generalEnhance: false }, ["BASE64DATA"]);
  assert.equal(value(graph, "32", "denoise"), 0.1, "the graph's own default survives");
  assert.notEqual(value(graph, "32", "denoise"), undefined);
});

test("general enhancement routing matrix", async () => {
  // The eight cases from GENERAL_ENHANCEMENT_WORKFLOW_README.md. Each asserts
  // where the save node reads from, which is what decides the delivered image.
  const cases: Array<{
    name: string;
    settings: Record<string, unknown>;
    save: string;
    batch?: string;
    bodySource?: string;
  }> = [
    {
      name: "1: general only",
      settings: { generalEnhance: true, advancedDetails: false, bodyEnhance: false },
      save: "82",
      batch: "64",
    },
    {
      name: "2: advanced only",
      settings: { generalEnhance: false, advancedDetails: true, bodyEnhance: false },
      save: "82",
      batch: "21",
    },
    {
      name: "3: body only",
      settings: { generalEnhance: false, advancedDetails: false, bodyEnhance: true },
      save: "54",
      bodySource: "63",
    },
    {
      name: "4: general + advanced",
      settings: { generalEnhance: true, advancedDetails: true, bodyEnhance: false },
      save: "82",
      batch: "21",
    },
    {
      name: "5: general + body",
      settings: { generalEnhance: true, advancedDetails: false, bodyEnhance: true },
      save: "54",
      batch: "64",
      bodySource: "82",
    },
    {
      name: "6: advanced + body",
      settings: { generalEnhance: false, advancedDetails: true, bodyEnhance: true },
      save: "54",
      batch: "21",
      bodySource: "82",
    },
    {
      name: "7: all three",
      settings: { generalEnhance: true, advancedDetails: true, bodyEnhance: true },
      save: "54",
      batch: "21",
      bodySource: "82",
    },
    { name: "8: none", settings: { generalEnhance: false, advancedDetails: false, bodyEnhance: false }, save: "63" },
  ];

  for (const entry of cases) {
    const graph = await build("general-enhancement", entry.settings, ["BASE64DATA"]);
    assert.deepEqual(link(graph, "83", "images"), [entry.save, 0], `${entry.name}: save source`);
    if (entry.batch) assert.deepEqual(link(graph, "12", "images"), [entry.batch, 0], `${entry.name}: batch source`);
    if (entry.bodySource) assert.deepEqual(link(graph, "53", "image"), [entry.bodySource, 0], `${entry.name}: body source`);
  }
});

test("general enhancement chains general into advanced when both are on", async () => {
  const graph = await build("general-enhancement", { generalEnhance: true, advancedDetails: true }, ["BASE64DATA"]);
  assert.deepEqual(link(graph, "66", "image"), ["79", 0]);
  assert.deepEqual(link(graph, "69", "image"), ["64", 0], "advanced reads the general enhancement decode");
});

test("advanced-only reads the prep node, not the general enhancement decode", async () => {
  const graph = await build("general-enhancement", { generalEnhance: false, advancedDetails: true }, ["BASE64DATA"]);
  assert.deepEqual(link(graph, "69", "image"), ["79", 0]);
});

test("the Qwen caption is dropped only in body-only mode", async () => {
  const bodyOnly = await build("general-enhancement", { generalEnhance: false, advancedDetails: false, bodyEnhance: true }, [
    "B",
  ]);
  assert.equal(value(bodyOnly, "30", "text_c"), "", "no prompt-driven branch runs, so the caption is disconnected");

  const withGeneral = await build("general-enhancement", { generalEnhance: true, bodyEnhance: true }, ["B"]);
  assert.deepEqual(link(withGeneral, "30", "text_c"), ["33", 0], "still connected when a prompt branch runs");
});

// -- pro upscaler ------------------------------------------------------------

test("pro upscaler sets the filename, seed and creativity", async () => {
  const graph = await build("pro-upscaler", { creativity: 35 }, ["source.png"]);
  assert.equal(value(graph, "99", "image"), "source.png");
  assert.equal(value(graph, "80:29", "noise_seed"), 1);
  assert.equal(value(graph, "80:84", "value"), 35);
});

test("pro upscaler routing matrix", async () => {
  // The six cases from PRO_UPSCALER_WORKFLOW_README.md, including the inverted
  // scale semantics: Super Fast x2 scales the x4 model output back down.
  const cases: Array<{
    name: string;
    settings: Record<string, unknown>;
    save: string;
    scaleNode: string;
    scale: number;
  }> = [
    { name: "super fast x2", settings: { engine: "super-fast", upscale: "x2" }, save: "104", scaleNode: "104", scale: 0.5 },
    { name: "super fast x4", settings: { engine: "super-fast", upscale: "x4" }, save: "104", scaleNode: "104", scale: 1 },
    {
      name: "normal x2, no enhancement",
      settings: { engine: "normal", upscale: "x2", enhancement: false },
      save: "81:13",
      scaleNode: "96:85",
      scale: 2,
    },
    {
      name: "normal x4, no enhancement",
      settings: { engine: "normal", upscale: "x4", enhancement: false },
      save: "81:13",
      scaleNode: "96:85",
      scale: 4,
    },
    {
      name: "normal x2, enhancement",
      settings: { engine: "normal", upscale: "x2", enhancement: true },
      save: "81:13",
      scaleNode: "96:85",
      scale: 2,
    },
    {
      name: "normal x4, enhancement",
      settings: { engine: "normal", upscale: "x4", enhancement: true },
      save: "81:13",
      scaleNode: "96:85",
      scale: 4,
    },
  ];

  for (const entry of cases) {
    const graph = await build("pro-upscaler", entry.settings, ["source.png"]);
    assert.deepEqual(link(graph, "97", "images"), [entry.save, 0], `${entry.name}: save source`);
    assert.equal(value(graph, entry.scaleNode, "scale_by"), entry.scale, `${entry.name}: scale`);
  }
});

test("super fast sends the input to the model upscale, normal to the tiled prep", async () => {
  const fast = await build("pro-upscaler", { engine: "super-fast" }, ["source.png"]);
  assert.deepEqual(link(fast, "102", "image"), ["99", 0]);

  const normal = await build("pro-upscaler", { engine: "normal" }, ["source.png"]);
  assert.deepEqual(link(normal, "96:82", "image"), ["99", 0]);
});

test("the enhancement toggle rewires the final resize around the Flux stage", async () => {
  const on = await build("pro-upscaler", { engine: "normal", enhancement: true }, ["source.png"]);
  assert.deepEqual(link(on, "80:83", "image"), ["77:78", 0], "SeedVR feeds Flux");
  assert.deepEqual(link(on, "81:38", "image"), ["80:14", 0], "final resize reads the Flux output");

  const off = await build("pro-upscaler", { engine: "normal", enhancement: false }, ["source.png"]);
  assert.deepEqual(link(off, "81:38", "image"), ["77:78", 0], "final resize reads SeedVR directly");
});

test("super fast ignores the enhancement toggle", async () => {
  // forge documents this explicitly: the Super Fast route always bypasses SeedVR
  // and Flux, so the checkbox cannot reach it.
  const on = await build("pro-upscaler", { engine: "super-fast", enhancement: true }, ["source.png"]);
  const off = await build("pro-upscaler", { engine: "super-fast", enhancement: false }, ["source.png"]);
  assert.deepEqual(link(on, "97", "images"), ["104", 0]);
  assert.deepEqual(link(off, "97", "images"), ["104", 0]);
});

// -- reference generator -----------------------------------------------------

test("reference generator maps its three sliders to the documented nodes", async () => {
  const graph = await build("reference-generator", { colorStrength: 0.7, creativity: 0.4, structureStrength: 0.9 }, [
    "MAIN64",
    "REF64",
  ]);

  assert.equal(value(graph, "42", "image"), "MAIN64", "main image");
  assert.equal(value(graph, "43", "image"), "REF64", "reference image");
  assert.equal(value(graph, "30", "weight"), 0.7, "colorStrength -> IPAdapter weight");
  assert.equal(value(graph, "12", "denoise"), 0.4, "creativity -> base sampler denoise");
  assert.equal(value(graph, "20", "strength"), 0.9, "structureStrength -> ControlNet strength");
});

test("reference generator save routing is three-way", async () => {
  const bypass = await build("reference-generator", { enhancement: false }, ["M", "R"]);
  assert.deepEqual(link(bypass, "153", "images"), ["182", 0], "enhancement off bypasses the refine stage");

  const matched = await build("reference-generator", { enhancement: true, colorMatch: true }, ["M", "R"]);
  assert.deepEqual(link(matched, "153", "images"), ["149", 0], "colour matched");

  const direct = await build("reference-generator", { enhancement: true, colorMatch: false }, ["M", "R"]);
  assert.deepEqual(link(direct, "153", "images"), ["147", 0], "refined without colour match");
});

// -- qwen edit ---------------------------------------------------------------

test("qwen edit edit-mode uses the base model and the user prompt", async () => {
  const graph = await build("qwen-edit", { mode: "edit", imageCount: "1" }, ["one.png"], "swap the cladding");
  assert.deepEqual(link(graph, "145", "model"), ["142", 0], "no LoRA in Edit mode");
  assert.equal(value(graph, "154", "text"), "swap the cladding");
  assert.equal(value(graph, "161", "text"), "");
  assert.equal(value(graph, "141", "noise_seed"), 1);
});

test("each qwen mode loads its own LoRA through the guider", async () => {
  const expected: Array<[string, string]> = [
    ["reference-transfer", "Klein_ref_transfer_02.safetensors"],
    ["consistency", "Klein-consistency.safetensors"],
    ["raw-enhancement", "Klein_9B_bvfinish_v01.safetensors"],
  ];

  for (const [mode, lora] of expected) {
    const images = mode === "reference-transfer" ? ["main.png", "ref.png"] : ["main.png"];
    const graph = await build("qwen-edit", { mode }, images, "ignored where unused");
    assert.equal(value(graph, "167", "lora_name"), lora, `${mode} LoRA`);
    assert.deepEqual(link(graph, "145", "model"), ["167", 0], `${mode} routes the guider through the LoRA`);
  }
});

test("realistic mode uses Forge's one-image graph, prompt, seed, and LoRA strength", async () => {
  const graph = await build("qwen-edit", { mode: "realistic", realisticStrength: 0.7 }, ["main.png"], "soft natural daylight");

  assert.equal(value(graph, "76", "image"), "main.png");
  assert.equal(value(graph, "163", "text"), "soft natural daylight");
  assert.equal(value(graph, "176", "noise_seed"), 1);
  assert.equal(value(graph, "179", "lora_name"), "realistic.safetensors");
  assert.equal(value(graph, "179", "strength_model"), 0.7);
  assert.deepEqual(link(graph, "160", "images"), ["181", 0]);
  assert.equal(graph["145"], undefined, "the multi-image edit graph must not be mixed into Realistic mode");
});

test("reference transfer builds its prompt from the VLM instead of the user", async () => {
  const graph = await build("qwen-edit", { mode: "reference-transfer" }, ["main.png", "ref.png"]);

  assert.deepEqual(link(graph, "154", "text"), ["169", 0], "positive text comes from the template");
  assert.equal(value(graph, "169", "text_a"), "Change the mood and lighting of Image 1 to ");
  assert.match(String(value(graph, "169", "text_c")), /light direction, shadows, and contrast/);
  assert.deepEqual(link(graph, "169", "text_b"), ["168", 0], "the VLM description is spliced in");
  assert.match(String(value(graph, "168", "custom_prompt")), /Mood: one word/);
  assert.deepEqual(link(graph, "168", "image"), ["178", 0], "the VLM reads the padded reference image");
});

test("raw enhancement drives itself from the VLM caption", async () => {
  const graph = await build("qwen-edit", { mode: "raw-enhancement" }, ["render.png"], "this prompt is unused");
  assert.deepEqual(link(graph, "154", "text"), ["168", 0]);
  assert.match(String(value(graph, "168", "custom_prompt")), /photoreal finish/);
  assert.deepEqual(link(graph, "168", "image"), ["174", 0], "the VLM reads the padded main image");
});

test("consistency clears the VLM prompt and uses the user prompt", async () => {
  const graph = await build("qwen-edit", { mode: "consistency" }, ["one.png"], "cooler light");
  assert.equal(value(graph, "168", "custom_prompt"), "");
  assert.equal(value(graph, "154", "text"), "cooler light");
});

test("qwen conditioning chains one reference latent pair per image", async () => {
  const one = await build("qwen-edit", { mode: "edit", imageCount: "1" }, ["a.png"], "p");
  assert.deepEqual(link(one, "145", "positive"), ["150", 0]);
  assert.deepEqual(link(one, "145", "negative"), ["148", 0]);

  const two = await build("qwen-edit", { mode: "edit", imageCount: "2" }, ["a.png", "b.png"], "p");
  assert.deepEqual(link(two, "145", "positive"), ["159", 0]);
  assert.deepEqual(link(two, "159", "conditioning"), ["150", 0]);
  assert.deepEqual(link(two, "157", "conditioning"), ["148", 0]);

  const three = await build("qwen-edit", { mode: "edit", imageCount: "3" }, ["a.png", "b.png", "c.png"], "p");
  assert.deepEqual(link(three, "145", "positive"), ["164", 0]);
  assert.deepEqual(link(three, "164", "conditioning"), ["159", 0]);
  assert.deepEqual(link(three, "162", "conditioning"), ["157", 0]);
});

test("qwen edit assigns images to slots in order and leaves unused slots alone", async () => {
  const graph = await build("qwen-edit", { mode: "edit", imageCount: "2" }, ["first.png", "second.png"], "p");
  assert.equal(value(graph, "76", "image"), "first.png");
  assert.equal(value(graph, "121", "image"), "second.png");
  // Slot three keeps whatever the export had; it is not in the conditioning chain.
  assert.notEqual(value(graph, "165", "image"), undefined);
});

test("qwen edit always saves through the final crop", async () => {
  const graph = await build("qwen-edit", { mode: "edit", imageCount: "1" }, ["a.png"], "p");
  assert.deepEqual(link(graph, "137", "images"), ["182", 0]);
  assert.deepEqual(link(graph, "182", "image"), ["140", 0]);
  assert.equal(value(graph, "182", "multiple_of"), 1);
});

test("image editing fills the source, mask and guide slots in that order", async () => {
  // Slot order is the whole reason markRegion can drop one input without
  // disturbing the others, so it is asserted on the real graph rather than
  // inferred from the binding table that produced it.
  const graph = await build("image-editing", {}, ["src.png", "mask.png", "guide.png"], "make it brick");

  assert.equal(value(graph, "3", "image"), "src.png");
  assert.equal(value(graph, "20", "image"), "mask.png");
  assert.equal(value(graph, "12", "image"), "guide.png");
});

test("image editing sends the prompt, seed and model options to the Nano Banana node", async () => {
  const graph = await build("image-editing", { resolution: "4K", thinking: "HIGH" }, ["a", "b", "c"], "  add a window  ");

  assert.equal(value(graph, "1", "prompt"), "add a window");
  assert.equal(value(graph, "1", "seed"), 1);
  assert.equal(value(graph, "1", "resolution"), "4K");
  assert.equal(value(graph, "1", "thinking_level"), "HIGH");
  // auto is what keeps the returned framing matching the source, which the
  // composite then relies on. Nothing may write over it.
  assert.equal(value(graph, "1", "aspect_ratio"), "auto");
});

test("image editing batches the guide in behind the source, and drops it when unmarked", async () => {
  const marked = await build("image-editing", { markRegion: true }, ["a", "b", "c"], "p");
  assert.deepEqual(link(marked, "11", "images.image0"), ["3", 0]);
  assert.deepEqual(link(marked, "11", "images.image1"), ["12", 0]);

  const plain = await build("image-editing", { markRegion: false }, ["a", "b"], "p");
  assert.deepEqual(link(plain, "11", "images.image0"), ["3", 0]);
  // Left connected, the batch would point at a LoadImage holding a filename
  // nothing was uploaded for, and the graph would fail inside ComfyUI.
  assert.equal("images.image1" in (plain["11"].inputs ?? {}), false);
});

test("image editing appends reference images to Nano Banana conditioning in order", async () => {
  const edit = editMetadata("inpaint", ["ref-one.png", "ref-two.png"]);
  const graph = await buildStillImageWorkflow({
    options: normalizeStillImageOptions({ categoryId: "image-editing", settings: {}, edit }),
    images: ["source.png", "mask.png", "guide.png", "ref-one.png", "ref-two.png"],
    prompt: "match the reference chair",
    nextSeed: seeds,
  });

  assert.equal(value(graph, "30", "image"), "ref-one.png");
  assert.equal(value(graph, "31", "image"), "ref-two.png");
  assert.deepEqual(link(graph, "11", "images.image2"), ["30", 0]);
  assert.deepEqual(link(graph, "11", "images.image3"), ["31", 0]);
  assert.equal("images.image4" in (graph["11"].inputs ?? {}), false);
});

test("image editing pastes the result back through the painted mask", async () => {
  const graph = await build("image-editing", { preserveUnmasked: true }, ["a", "b", "c"], "p");

  assert.deepEqual(link(graph, "10", "images"), ["24", 0]);
  assert.deepEqual(link(graph, "24", "destination"), ["3", 0]);
  assert.deepEqual(link(graph, "24", "source"), ["22", 0]);
  assert.deepEqual(link(graph, "24", "mask"), ["23", 0]);
  // The mask comes from the painted slot, and the composite source is the model
  // output resized to the source's own dimensions -- both are what make every
  // pixel outside the region identical to the input.
  assert.deepEqual(link(graph, "23", "image"), ["20", 0]);
  assert.deepEqual(link(graph, "22", "image"), ["1", 0]);
  assert.deepEqual(link(graph, "22", "width"), ["21", 0]);
  assert.deepEqual(link(graph, "22", "height"), ["21", 1]);
  assert.deepEqual(link(graph, "21", "image"), ["3", 0]);
  assert.equal(value(graph, "24", "resize_source"), false);
});

test("image editing can save the raw model output instead of the composite", async () => {
  const graph = await build("image-editing", { preserveUnmasked: false }, ["a", "b", "c"], "p");
  assert.deepEqual(link(graph, "10", "images"), ["1", 0]);
});

test("image editing runs on the shared endpoint and the GPU presets do not", async () => {
  const { stillImageRunsOnSharedEndpoint } = await import("./stillImageWorkflow.js");

  assert.equal(stillImageRunsOnSharedEndpoint("image-editing"), true);
  for (const categoryId of ["general-enhancement", "pro-upscaler", "reference-generator", "qwen-edit"] as const) {
    assert.equal(stillImageRunsOnSharedEndpoint(categoryId), false, categoryId);
  }
});

test("every progress label points at a node the real graph contains", async () => {
  // The labels are keyed by ComfyUI node id, which is a contract with the
  // exported graph exactly like the input bindings are. A re-export that
  // renumbers a node leaves its label unreachable, and the only symptom is a
  // step quietly missing from the progress trail -- nothing throws. This is the
  // check that turns that into a failure here instead.
  const { stillImageLabelledNodeIds, stillImageNodeStatusLabel } = await import("./stillImageWorkflow.js");
  const fs = await import("node:fs/promises");

  for (const categoryId of ["general-enhancement", "pro-upscaler", "reference-generator", "qwen-edit"] as const) {
    const graph = JSON.parse(await fs.readFile(stillImageWorkflowPath(categoryId), "utf8"));
    const labelled = stillImageLabelledNodeIds(categoryId);
    assert.ok(labelled.length > 0, `${categoryId} should label at least some nodes`);

    for (const nodeId of labelled) {
      assert.ok(graph[nodeId], `${categoryId} labels node ${nodeId}, which the exported graph does not contain`);
      assert.ok(stillImageNodeStatusLabel(categoryId, nodeId), `${categoryId} node ${nodeId} resolves to a label`);
    }
  }

  const realisticSettings = { mode: "realistic" };
  const realisticGraph = JSON.parse(await fs.readFile(stillImageWorkflowPath("qwen-edit", realisticSettings), "utf8"));
  for (const nodeId of stillImageLabelledNodeIds("qwen-edit", realisticSettings)) {
    assert.ok(realisticGraph[nodeId], `qwen-edit realistic labels node ${nodeId}, which the exported graph does not contain`);
    assert.ok(stillImageNodeStatusLabel("qwen-edit", nodeId, realisticSettings));
  }
});

test("a subgraph node id resolves through its outer id when unlabelled", async () => {
  const { stillImageNodeStatusLabel } = await import("./stillImageWorkflow.js");
  // Nested ids arrive as "80:12". The exact id wins when it is listed...
  assert.equal(stillImageNodeStatusLabel("pro-upscaler", "80:12"), "Sampling tiles");
  // ...and an unlisted nested id falls back to its outer node rather than
  // reporting nothing, which is how a re-nested graph degrades gracefully.
  assert.equal(stillImageNodeStatusLabel("general-enhancement", "32:9"), "Sampling tiles");
  assert.equal(stillImageNodeStatusLabel("general-enhancement", "9999"), undefined);
});

function editMetadata(mode: "inpaint" | "enhance", referenceSourceUrls: string[]) {
  return {
    layerId: "edit_12345678",
    operation: "create",
    mode,
    documentId: "editdoc_12345678",
    crop: { x: 100, y: 50, size: 400, sourceWidth: 1200, sourceHeight: 800 },
    mask: { width: 1200, height: 800, softness: 20, strokes: [] },
    originalSourceUrl: "/api/media?path=original.png",
    maskSourceUrl: "/api/media?path=mask.png",
    baseLayerIds: [],
    baseLayers: [],
    referenceSourceUrls,
  };
}

// -- image editing through GPT Image ------------------------------------------
//
// The same preset, the same 13-node graph, a different provider at node 1. What
// these assert is that the switch changes only the call: the plumbing that makes
// the edit behave like an inpaint has to survive it intact, or a GPT edit would
// quietly repaint the whole picture.

function editFixture(crop: { size: number; width?: number; height?: number }) {
  return {
    layerId: "edit_12345678",
    operation: "create" as const,
    mode: "inpaint" as const,
    documentId: "editdoc_12345678",
    crop: { x: 0, y: 0, sourceWidth: 4000, sourceHeight: 3000, ...crop },
    mask: { width: 4000, height: 3000, softness: 20, strokes: [] },
    originalSourceUrl: "/api/media?path=original.png",
    maskSourceUrl: "/api/media?path=mask.png",
    baseLayerIds: [],
    baseLayers: [],
  };
}

async function buildGptEdit(settings: Record<string, unknown>, crop: { size: number; width?: number; height?: number }) {
  seedCounter = 0;
  return buildStillImageWorkflow({
    options: normalizeStillImageOptions({
      categoryId: "image-editing",
      settings: { engine: "gpt-image", ...settings },
      edit: editFixture(crop),
    }),
    images: ["src.png", "mask.png", "guide.png"],
    prompt: "  add a window  ",
    nextSeed: seeds,
  });
}

test("choosing GPT Image loads the GPT graph, not Nano Banana's", async () => {
  const graph = await buildGptEdit({}, { size: 1024 });
  assert.equal(graph["1"].class_type, "OpenAIGPTImage1");
  assert.equal(value(graph, "1", "model"), "gpt-image-2");
  assert.equal(value(graph, "1", "seed"), 1);
  assert.equal(value(graph, "1", "quality"), "medium");
});

test("the region instruction leads the prompt, because GPT has no system prompt", async () => {
  // Nano Banana carries this in system_prompt. Lose it on the GPT path and the
  // magenta region marker gets painted into the result as part of the scene.
  const graph = await buildGptEdit({}, { size: 1024 });
  const prompt = String(value(graph, "1", "prompt"));
  assert.match(prompt, /translucent magenta wash marking the region/);
  assert.ok(prompt.trimEnd().endsWith("add a window"), "the artist's own prompt must come last");
});

test("the requested size is Custom, sized from the crop and legal", async () => {
  // 4:3 crop. The node rejects the whole prompt on any of its Custom rules, so
  // what matters is that what the builder writes would actually be accepted.
  const graph = await buildGptEdit({}, { size: 0, width: 1600, height: 1200 });
  assert.equal(value(graph, "1", "size"), "Custom");
  const width = Number(value(graph, "1", "custom_width"));
  const height = Number(value(graph, "1", "custom_height"));
  assert.equal(width % 16, 0);
  assert.equal(height % 16, 0);
  assert.ok(Math.max(width, height) <= 3840);
  assert.ok(width * height >= 655_360 && width * height <= 8_294_400);
  assert.ok(Math.abs(width / height - 4 / 3) < 0.02, `${width}x${height} lost the crop's shape`);
});

test("a region far below the pixel floor is still sized legally", async () => {
  const graph = await buildGptEdit({}, { size: 256 });
  const width = Number(value(graph, "1", "custom_width"));
  const height = Number(value(graph, "1", "custom_height"));
  assert.ok(width * height >= 655_360, `${width}x${height} is under the floor the node enforces`);
});

test("the GPT graph keeps the plumbing that makes the edit an inpaint", async () => {
  const graph = await buildGptEdit({}, { size: 1024 });

  // batch -> call -> scale to source -> paste through the mask -> save.
  assert.deepEqual(link(graph, "1", "image"), ["11", 0]);
  assert.deepEqual(link(graph, "22", "image"), ["1", 0]);
  assert.deepEqual(link(graph, "24", "source"), ["22", 0]);
  assert.deepEqual(link(graph, "24", "destination"), ["3", 0]);
  assert.deepEqual(link(graph, "24", "mask"), ["23", 0]);

  // The node accepts a mask, but refuses one alongside a multi-image batch --
  // and the composite above is the stronger guarantee anyway.
  assert.equal("mask" in (graph["1"].inputs ?? {}), false);
});

test("Nano Banana stays the default, so an existing request is unaffected", async () => {
  const graph = await build("image-editing", {}, ["a", "b", "c"], "p");
  assert.equal(graph["1"].class_type, "GeminiNanoBanana2");
});
