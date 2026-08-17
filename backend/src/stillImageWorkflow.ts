// Turning a Still Images preset into a ComfyUI prompt.
//
// Ported from momi-forge, which is the working implementation of these four
// graphs: General_Enhancement_v04.py, server_upscaler_with_flux_enhancement.py,
// reference_generator.py and flux2_klein_image_edit_9b_distilled.py, plus the two
// specs in GENERAL_ENHANCEMENT_WORKFLOW_README.md and PRO_UPSCALER_WORKFLOW_README.md.
// Node ids below are that project's; they are also what the exported graphs in
// stillImageWorkflowRoot contain.
//
// This is deliberately not the table-driven mapping the Animation side uses
// (workflow-mappings.json -> injectInputs). These presets need three kinds of
// mutation and only the first fits a table:
//
//   1. Scalar writes      node.inputs.field = value
//   2. Link rewrites      node.inputs.field = [sourceNode, 0]
//   3. Conditional writes the same UI value writes a different node, or a
//                         different number, depending on another setting
//
// Every checkbox here is case 2: it re-routes which branch reaches the save node.
// General Enhancement has an eight-case matrix, Pro Upscaler six. So each preset
// gets a function, not a row in a config file.

import fs from "node:fs/promises";
import path from "node:path";

import { stillImageWorkflowRoot } from "./config.js";
import {
  getStillImageCategory,
  stillImageSlotCount,
  type StillImageCategoryId,
  type StillImageOptions,
  type StillImageSettingValue,
} from "./stillImageCategories.js";
import { randomStillImageSeed, stillImageSeedSequence } from "./stillImageSeed.js";

export type StillImageGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

/**
 * How a preset receives its input images.
 *
 * "load_image_name" presets carry a `LoadImage` node whose `image` is a filename;
 * the bytes travel separately in the RunPod payload's `images[]` array, which is
 * what the Animation pipeline already does.
 *
 * "inline_base64" presets carry an `ETN_LoadImageBase64` node and the image data
 * goes straight into `inputs.image`. These must not be sent by URL, so the caller
 * has to have the base64 in hand.
 */
export type StillImageInputTransport = "load_image_name" | "inline_base64";

/**
 * Where one logical image slot goes in the graph.
 *
 * Explicit on purpose. Nothing here may be inferred from the export, because both
 * of the obvious heuristics are wrong for these graphs:
 *
 *   - Scanning for LoadImage-ish class names picks up general-enhancement's node
 *     81, which sits in the disconnected drawn-mask branch and is never executed,
 *     and it also matches ETN_LoadImageBase64 on a substring, so a filename would
 *     be written where base64 content belongs.
 *   - Taking destination filenames from the export collides: qwen-edit's nodes 121
 *     and 165 were both saved holding "0001 (1).png", so slots 2 and 3 would
 *     overwrite each other and one image would be silently ignored.
 *
 * `filename` is the deterministic per-slot destination name, never the exported
 * value and never anything derived from what the user uploaded.
 */
export type StillImageInputBinding = {
  /** 1-based logical slot, matching the order the UI collects images in. */
  slot: number;
  nodeId: string;
  inputName: string;
} & ({ mode: "base64" } | { mode: "load-image"; filename: string });

export type StillImagePreset = {
  categoryId: StillImageCategoryId;
  workflowFile: string;
  inputTransport: StillImageInputTransport;
  inputBindings: readonly StillImageInputBinding[];
  apply: (graph: StillImageGraph, input: ResolvedBuildInput) => void;
};

export type StillImageBuildInput = {
  options: StillImageOptions;
  prompt?: string;
  /**
   * One entry per image slot, in slot order: a filename for load_image_name
   * presets, raw base64 for inline_base64 ones.
   */
  images: string[];
  /**
   * Overrides the seed sequence the job's master seed would produce. Injected so
   * tests can assert on seeds directly; production leaves it unset so the render
   * stays reproducible from what is persisted on the job.
   */
  nextSeed?: () => number;
};

type ResolvedBuildInput = {
  settings: Record<string, StillImageSettingValue>;
  prompt: string;
  images: string[];
  imageCount: number;
  nextSeed: () => number;
};

export function stillImagePreset(categoryId: StillImageCategoryId): StillImagePreset {
  const preset = PRESETS[categoryId];
  if (!preset) throw new Error(`No still image workflow is registered for ${categoryId}.`);
  return preset;
}

export function stillImageWorkflowPath(categoryId: StillImageCategoryId) {
  return path.join(stillImageWorkflowRoot, stillImagePreset(categoryId).workflowFile);
}

export function stillImageInputTransport(categoryId: StillImageCategoryId) {
  return stillImagePreset(categoryId).inputTransport;
}

/**
 * The deterministic destination filename for a load-image slot.
 *
 * Derived from the slot index alone: not from the user's upload, not from the
 * exported graph value. That makes it stable across a retry or a dispatcher
 * failover without storing anything, and unique by construction, which is what
 * keeps qwen-edit's three slots from colliding.
 *
 * Not job-scoped: names only have to be unique within one RunPod request, and
 * every request writes every slot it uses, so there is nothing to collide with.
 */
export function stillImageSlotFilename(slot: number) {
  return `momi_still_${String(slot).padStart(2, "0")}.png`;
}

/**
 * Bindings for the slots a request actually uses, in slot order.
 *
 * Qwen Edit varies between one and three images, so the preset declares all three
 * and the request's resolved count decides how many are live. Unused slots keep
 * whatever the export held and stay out of the conditioning chain.
 */
export function stillImageInputBindings(categoryId: StillImageCategoryId, imageCount: number) {
  const preset = stillImagePreset(categoryId);
  const bindings = preset.inputBindings.filter((binding) => binding.slot <= imageCount);
  if (bindings.length !== imageCount) {
    throw new Error(
      `Still image preset ${categoryId} declares ${preset.inputBindings.length} input binding(s) but ${imageCount} were requested.`,
    );
  }
  return [...bindings].sort((left, right) => left.slot - right.slot);
}

/**
 * Check the preset's bindings against a real graph.
 *
 * A binding pointing at a node the export no longer has would otherwise mean an
 * image silently never reaches the graph, so this is a configuration error rather
 * than something to route around.
 */
export function assertStillImageBindings(graph: StillImageGraph, categoryId: StillImageCategoryId, imageCount: number) {
  for (const binding of stillImageInputBindings(categoryId, imageCount)) {
    const node = graph[binding.nodeId];
    if (!node?.inputs || typeof node.inputs !== "object") {
      throw new Error(
        `Still image preset ${categoryId} binds slot ${binding.slot} to node ${binding.nodeId}, which the workflow does not contain.`,
      );
    }
    if (!(binding.inputName in node.inputs)) {
      throw new Error(
        `Still image preset ${categoryId} binds slot ${binding.slot} to ${binding.nodeId}.${binding.inputName}, which that node does not have.`,
      );
    }
  }
}

/**
 * Load a preset's graph and apply the request to it.
 *
 * Read fresh per call rather than cached: apply() mutates the graph in place, and
 * a shared cached object would leak one job's settings into the next.
 */
export async function buildStillImageWorkflow(input: StillImageBuildInput): Promise<StillImageGraph> {
  const preset = stillImagePreset(input.options.categoryId);
  const category = getStillImageCategory(input.options.categoryId);
  const graph = JSON.parse(await fs.readFile(stillImageWorkflowPath(preset.categoryId), "utf8")) as StillImageGraph;

  const imageCount = stillImageSlotCount(category, input.options.settings);
  if (input.images.length !== imageCount) {
    throw new Error(`${preset.categoryId} expects ${imageCount} input image(s); received ${input.images.length}.`);
  }
  if (input.images.some((value) => !value)) {
    throw new Error(`${preset.categoryId} received an empty input image slot.`);
  }

  // Bindings are checked and written here rather than inside each apply(), so
  // every preset gets the same guarantee: one explicit node per slot, no slot
  // silently skipped, and a loud failure if an export drifted.
  assertStillImageBindings(graph, preset.categoryId, imageCount);
  for (const binding of stillImageInputBindings(preset.categoryId, imageCount)) {
    graph[binding.nodeId].inputs![binding.inputName] = input.images[binding.slot - 1];
  }

  preset.apply(graph, {
    settings: input.options.settings,
    prompt: (input.prompt ?? "").trim(),
    images: input.images,
    imageCount,
    // Derived from the job's own master seed, so resubmitting that seed with the
    // same settings and inputs reproduces this render. A job recorded before
    // seeds were persisted has none; those keep the old behaviour of a fresh
    // roll per run.
    nextSeed: input.nextSeed ?? stillImageSeedSequence(input.options.seed ?? randomStillImageSeed()),
  });

  return graph;
}

// -- graph helpers -----------------------------------------------------------
//
// Both throw on a missing node or input. A preset re-exported from ComfyUI can
// renumber nodes, and a silent no-op there produces a graph that runs and returns
// something plausible with the slider ignored -- far worse than a failed job.

function nodeInputs(graph: StillImageGraph, nodeId: string) {
  const node = graph[nodeId];
  if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") {
    throw new Error(`Still image workflow is missing node ${nodeId}, or it has no inputs.`);
  }
  return node.inputs;
}

/**
 * Write a scalar. The input must already exist.
 *
 * A slider whose target field has been renamed is a silent no-op otherwise: the
 * job runs, returns a plausible image, and ignores the control.
 */
function set(graph: StillImageGraph, nodeId: string, input: string, value: unknown) {
  const inputs = nodeInputs(graph, nodeId);
  if (!(input in inputs)) {
    throw new Error(`Still image workflow node ${nodeId} has no "${input}" input.`);
  }
  inputs[input] = value;
}

/**
 * target.input <- source, the link shape ComfyUI stores on the receiving node.
 *
 * Unlike set(), this creates the input when it is absent. It has to: a graph
 * exported with a branch disconnected simply has no key for that input -- node
 * 102's `image` in pro-upscaler.json is exactly this -- and establishing the link
 * is the whole point of routing. Both endpoints are still checked to exist, which
 * is what catches a re-export that renumbers nodes.
 */
function connect(graph: StillImageGraph, targetId: string, input: string, sourceId: string, outputIndex = 0) {
  nodeInputs(graph, sourceId);
  nodeInputs(graph, targetId)[input] = [sourceId, outputIndex];
}

/**
 * Read a slider that may legitimately be absent.
 *
 * normalizeStillImageOptions drops settings the UI had hidden, so a value whose
 * branch is switched off never arrives. Leaving the graph's own default in place
 * is correct: that branch is about to be routed out of the path anyway.
 */
function optionalNumber(settings: Record<string, StillImageSettingValue>, id: string) {
  const value = settings[id];
  return typeof value === "number" ? value : undefined;
}

function flag(settings: Record<string, StillImageSettingValue>, id: string) {
  return settings[id] === true;
}

function choice(settings: Record<string, StillImageSettingValue>, id: string, fallback: string) {
  const value = settings[id];
  return typeof value === "string" && value ? value : fallback;
}

function setIfNumber(
  graph: StillImageGraph,
  settings: Record<string, StillImageSettingValue>,
  settingId: string,
  nodeId: string,
  input: string,
) {
  const value = optionalNumber(settings, settingId);
  if (value !== undefined) set(graph, nodeId, input, value);
}

// -- general enhancement -----------------------------------------------------

const GENERAL = {
  imageInput: "63",
  maskRouter: "13",
  maskRouteGenerated: "85",
  promptText: "35",
  qwenPrompt: "33",
  qwenMerge: "30",
  sdSampler: "32",
  fluxNoise: "26",
  bodySampler: "52",
  faceSampler: "54",
  detailLora: "37",
  fluxScheduler: "23",
  fluxBlend: "74",
  sdPass: "66",
  advPass: "69",
  advPrep: "79",
  sdDecode: "64",
  fluxDecode: "21",
  imageBatch: "12",
  bodyResize: "53",
  stitch: "82",
  saveImage: "83",
} as const;

function applyGeneralEnhancement(graph: StillImageGraph, input: ResolvedBuildInput) {
  const { settings, prompt } = input;

  // The input image is written by the binding pass in buildStillImageWorkflow.

  // No mask surface in this UI, so always the generated-mask route. Equivalent to
  // forge's has_drawn_mask = false; the drawn-mask branch (nodes 86/88) is left
  // unreferenced and never executes.
  connect(graph, GENERAL.maskRouter, "mask", GENERAL.maskRouteGenerated);

  set(graph, GENERAL.promptText, "text_a", prompt);
  set(graph, GENERAL.qwenPrompt, "custom_prompt", prompt);

  set(graph, GENERAL.sdSampler, "seed", input.nextSeed());
  set(graph, GENERAL.fluxNoise, "noise_seed", input.nextSeed());
  set(graph, GENERAL.bodySampler, "seed", input.nextSeed());
  set(graph, GENERAL.faceSampler, "seed", input.nextSeed());

  setIfNumber(graph, settings, "details", GENERAL.detailLora, "strength_model");
  setIfNumber(graph, settings, "generalDenoise", GENERAL.sdSampler, "denoise");
  setIfNumber(graph, settings, "detailPass", GENERAL.fluxScheduler, "denoise");
  setIfNumber(graph, settings, "sharpen", GENERAL.fluxBlend, "blend_factor");
  setIfNumber(graph, settings, "bodyDenoise", GENERAL.bodySampler, "denoise");
  setIfNumber(graph, settings, "faceDenoise", GENERAL.faceSampler, "denoise");

  applyGeneralBranchRouting(graph, {
    generalEnhance: flag(settings, "generalEnhance"),
    advancedDetails: flag(settings, "advancedDetails"),
    bodyEnhance: flag(settings, "bodyEnhance"),
  });
}

/**
 * The eight-case routing matrix.
 *
 * Each branch decides two things: which node feeds the tile batch, and which node
 * the save node reads. Enabling a branch is a rewire, not a boolean on a node.
 */
function applyGeneralBranchRouting(
  graph: StillImageGraph,
  branches: { generalEnhance: boolean; advancedDetails: boolean; bodyEnhance: boolean },
) {
  const { generalEnhance, advancedDetails, bodyEnhance } = branches;

  // Keep the Qwen caption merged in unless the body-only case drops it.
  connect(graph, GENERAL.qwenMerge, "text_c", GENERAL.qwenPrompt);

  if (!generalEnhance && !advancedDetails && !bodyEnhance) {
    // Nothing enabled: save the input untouched.
    connect(graph, GENERAL.saveImage, "images", GENERAL.imageInput);
    return;
  }

  if (!generalEnhance && !advancedDetails && bodyEnhance) {
    // Body only: the original image goes straight to the detailer, and the
    // caption path is dropped because no prompt-driven branch runs.
    connect(graph, GENERAL.bodyResize, "image", GENERAL.imageInput);
    connect(graph, GENERAL.saveImage, "images", GENERAL.faceSampler);
    set(graph, GENERAL.qwenMerge, "text_c", "");
    return;
  }

  if (generalEnhance) connect(graph, GENERAL.sdPass, "image", GENERAL.advPrep);
  if (advancedDetails) connect(graph, GENERAL.advPass, "image", generalEnhance ? GENERAL.sdDecode : GENERAL.advPrep);

  // With both on, general enhancement feeds advanced details and the batch comes
  // from the Flux decode; otherwise from whichever single branch ran.
  connect(graph, GENERAL.imageBatch, "images", advancedDetails ? GENERAL.fluxDecode : GENERAL.sdDecode);

  if (bodyEnhance) {
    connect(graph, GENERAL.bodyResize, "image", GENERAL.stitch);
    connect(graph, GENERAL.saveImage, "images", GENERAL.faceSampler);
    return;
  }
  connect(graph, GENERAL.saveImage, "images", GENERAL.stitch);
}

// -- pro upscaler ------------------------------------------------------------

const UPSCALER = {
  imageInput: "99",
  fastUpscale: "102",
  fastScale: "104",
  normalPrep: "96:82",
  normalScale: "96:85",
  seedVr: "77:78",
  fluxNoise: "80:29",
  creativity: "80:84",
  fluxIn: "80:83",
  fluxOut: "80:14",
  finalResize: "81:38",
  untile: "81:13",
  saveImage: "97",
} as const;

function applyProUpscaler(graph: StillImageGraph, input: ResolvedBuildInput) {
  const { settings } = input;

  set(graph, UPSCALER.fluxNoise, "noise_seed", input.nextSeed());
  setIfNumber(graph, settings, "creativity", UPSCALER.creativity, "value");

  const doubling = choice(settings, "upscale", "x2") === "x2";

  if (choice(settings, "engine", "normal") === "super-fast") {
    // Super Fast bypasses SeedVR and Flux entirely, so `enhancement` is ignored
    // here exactly as forge ignores it.
    connect(graph, UPSCALER.fastUpscale, "image", UPSCALER.imageInput);
    connect(graph, UPSCALER.saveImage, "images", UPSCALER.fastScale);
    // The model upscale is already x4, so x2 means scaling back down by half.
    set(graph, UPSCALER.fastScale, "scale_by", doubling ? 0.5 : 1);
    return;
  }

  connect(graph, UPSCALER.normalPrep, "image", UPSCALER.imageInput);
  connect(graph, UPSCALER.saveImage, "images", UPSCALER.untile);
  set(graph, UPSCALER.normalScale, "scale_by", doubling ? 2 : 4);

  if (flag(settings, "enhancement")) {
    connect(graph, UPSCALER.fluxIn, "image", UPSCALER.seedVr);
    connect(graph, UPSCALER.finalResize, "image", UPSCALER.fluxOut);
    return;
  }
  connect(graph, UPSCALER.finalResize, "image", UPSCALER.seedVr);
}

// -- reference generator -----------------------------------------------------

const REFERENCE = {
  mainImage: "42",
  referenceImage: "43",
  ipAdapter: "30",
  pipeLoader: "11",
  baseSampler: "12",
  upscaleSampler: "16",
  fluxNoise: "139",
  controlNet: "20",
  saveImage: "153",
  colorMatched: "149",
  enhanced: "147",
  bypass: "182",
} as const;

function applyReferenceGenerator(graph: StillImageGraph, input: ResolvedBuildInput) {
  const { settings } = input;

  // Both samplers ship with seed 77 in the saved graph, so without this every
  // run of a given input produced the identical image and re-rendering to get a
  // different take did nothing. The loader's seed goes down the ttN pipe, so it
  // is set alongside the samplers that consume it.
  //
  // The AILab_QwenVL captioner (node 53) is deliberately left fixed, matching
  // general-enhancement and qwen-edit: randomising a sampler varies the render,
  // randomising the captioner varies the prompt describing the input, which is
  // a different thing and not what "new seed" is asking for.
  set(graph, REFERENCE.pipeLoader, "seed", input.nextSeed());
  set(graph, REFERENCE.baseSampler, "seed", input.nextSeed());
  set(graph, REFERENCE.upscaleSampler, "seed", input.nextSeed());
  set(graph, REFERENCE.fluxNoise, "noise_seed", input.nextSeed());

  setIfNumber(graph, settings, "colorStrength", REFERENCE.ipAdapter, "weight");
  setIfNumber(graph, settings, "creativity", REFERENCE.baseSampler, "denoise");
  setIfNumber(graph, settings, "structureStrength", REFERENCE.controlNet, "strength");

  // Three-way: bypass the Klein refine stage entirely, or take its output either
  // through the colour match or straight.
  if (!flag(settings, "enhancement")) {
    connect(graph, REFERENCE.saveImage, "images", REFERENCE.bypass);
    return;
  }
  connect(graph, REFERENCE.saveImage, "images", flag(settings, "colorMatch") ? REFERENCE.colorMatched : REFERENCE.enhanced);
}

// -- qwen edit ---------------------------------------------------------------

const QWEN = {
  image1: "76",
  image2: "121",
  image3: "165",
  cfgGuider: "145",
  positive1: "150",
  negative1: "148",
  positive2: "159",
  negative2: "157",
  positive3: "164",
  negative3: "162",
  baseModel: "142",
  positiveText: "154",
  negativeText: "161",
  lora: "167",
  qwen: "168",
  stringFunction: "169",
  noise: "141",
  mainScale: "151",
  referenceScale: "160",
  thirdScale: "166",
  padded1: "174",
  padded2: "178",
  padded3: "180",
  finalCrop: "182",
  saveImage: "137",
  vaeDecode: "140",
} as const;

// Each non-Edit mode swaps the LoRA and repoints the guider at it; Edit runs the
// base model with no LoRA.
const QWEN_MODE_LORA: Record<string, string> = {
  "reference-transfer": "Klein_ref_transfer_02.safetensors",
  consistency: "Klein-consistency.safetensors",
  "raw-enhancement": "Klein_9B_bvfinish_v01.safetensors",
};

const REFERENCE_TRANSFER_QWEN_PROMPT = [
  "Your task is to describe the image in three parts:",
  "",
  "Mood: one word (e.g., sunset, night, overcast, rainy)",
  "",
  "Sky: two words",
  "",
  "Lighting: two words",
  "",
  "Format: mood, sky sky, light light",
  "",
  "Example: sunset, clear desaturated, golden soft",
].join("\n");

const REFERENCE_TRANSFER_PREFIX = "Change the mood and lighting of Image 1 to ";
const REFERENCE_TRANSFER_SUFFIX =
  " to match Image 2, specifically the light direction, shadows, and contrast, " +
  "while keeping all details in Image 1 exactly the same.";

function applyQwenEdit(graph: StillImageGraph, input: ResolvedBuildInput) {
  const mode = choice(input.settings, "mode", "edit");

  set(graph, QWEN.noise, "noise_seed", input.nextSeed());

  applyQwenConditioning(graph, input.imageCount);
  applyQwenMode(graph, mode, input.prompt);
  applyQwenPaddingCrop(graph, mode, input.imageCount);
}

/**
 * Chain one ReferenceLatent pair per supplied image.
 *
 * The graph carries three pairs; with fewer images the unused ones are left out
 * of the chain rather than fed an absent image.
 */
function applyQwenConditioning(graph: StillImageGraph, imageCount: number) {
  if (imageCount <= 1) {
    connect(graph, QWEN.cfgGuider, "positive", QWEN.positive1);
    connect(graph, QWEN.cfgGuider, "negative", QWEN.negative1);
    return;
  }

  connect(graph, QWEN.positive2, "conditioning", QWEN.positive1);
  connect(graph, QWEN.negative2, "conditioning", QWEN.negative1);

  if (imageCount === 2) {
    connect(graph, QWEN.cfgGuider, "positive", QWEN.positive2);
    connect(graph, QWEN.cfgGuider, "negative", QWEN.negative2);
    return;
  }

  connect(graph, QWEN.positive3, "conditioning", QWEN.positive2);
  connect(graph, QWEN.negative3, "conditioning", QWEN.negative2);
  connect(graph, QWEN.cfgGuider, "positive", QWEN.positive3);
  connect(graph, QWEN.cfgGuider, "negative", QWEN.negative3);
}

function applyQwenMode(graph: StillImageGraph, mode: string, prompt: string) {
  set(graph, QWEN.negativeText, "text", "");
  connect(graph, QWEN.qwen, "image", QWEN.mainScale);

  if (mode === "edit") {
    connect(graph, QWEN.cfgGuider, "model", QWEN.baseModel);
    set(graph, QWEN.positiveText, "text", prompt);
    return;
  }

  const lora = QWEN_MODE_LORA[mode];
  if (!lora) throw new Error(`Unknown Qwen Edit mode: ${mode}.`);
  set(graph, QWEN.lora, "lora_name", lora);
  connect(graph, QWEN.cfgGuider, "model", QWEN.lora);

  if (mode === "reference-transfer") {
    // No user prompt: the VLM describes the reference image's mood and lighting
    // and that description is spliced into a fixed instruction template.
    connect(graph, QWEN.qwen, "image", QWEN.referenceScale);
    set(graph, QWEN.qwen, "custom_prompt", REFERENCE_TRANSFER_QWEN_PROMPT);
    set(graph, QWEN.stringFunction, "text_a", REFERENCE_TRANSFER_PREFIX);
    connect(graph, QWEN.stringFunction, "text_b", QWEN.qwen);
    set(graph, QWEN.stringFunction, "text_c", REFERENCE_TRANSFER_SUFFIX);
    connect(graph, QWEN.positiveText, "text", QWEN.stringFunction);
    return;
  }

  if (mode === "consistency") {
    set(graph, QWEN.qwen, "custom_prompt", "");
    set(graph, QWEN.positiveText, "text", prompt);
    return;
  }

  // Raw enhancement drives itself from the VLM caption, ignoring any prompt.
  set(graph, QWEN.qwen, "custom_prompt", RAW_ENHANCEMENT_QWEN_PROMPT);
  connect(graph, QWEN.positiveText, "text", QWEN.qwen);
}

function applyQwenPaddingCrop(graph: StillImageGraph, mode: string, imageCount: number) {
  connect(graph, QWEN.mainScale, "image", QWEN.image1);
  connect(graph, "170", "image", QWEN.mainScale);
  connect(graph, QWEN.padded1, "image", QWEN.image1);
  connect(graph, "147", "image", QWEN.padded1);
  connect(graph, "149", "pixels", QWEN.padded1);

  if (imageCount >= 2) {
    connect(graph, QWEN.referenceScale, "image", QWEN.image2);
    connect(graph, "177", "image", QWEN.referenceScale);
    connect(graph, QWEN.padded2, "image", QWEN.image2);
    connect(graph, "158", "pixels", QWEN.padded2);
  }
  if (imageCount >= 3) {
    connect(graph, QWEN.thirdScale, "image", QWEN.image3);
    connect(graph, "179", "image", QWEN.thirdScale);
    connect(graph, QWEN.padded3, "image", QWEN.image3);
    connect(graph, "163", "pixels", QWEN.padded3);
  }

  // The VLM reads the reference image in transfer mode and the main image
  // everywhere else -- re-applied here because padding replaces the scale nodes
  // that applyQwenMode pointed at.
  const qwenSource = mode === "reference-transfer" && imageCount >= 2 ? QWEN.padded2 : QWEN.padded1;
  connect(graph, QWEN.qwen, "image", qwenSource);

  connect(graph, "181", "image", QWEN.image1);
  connect(graph, QWEN.finalCrop, "image", QWEN.vaeDecode);
  set(graph, QWEN.finalCrop, "multiple_of", 1);
  connect(graph, QWEN.saveImage, "images", QWEN.finalCrop);
}

const RAW_ENHANCEMENT_QWEN_PROMPT = [
  "You are generating captions for training a LoRA that enhances raw architectural renders into high-quality, photorealistic architectural visualizations.",
  "",
  "Your task is to describe the final enhanced image as a polished architectural result, not the editing process.",
  "",
  "Instructions:",
  "",
  "1. Describe the architectural scene clearly and concisely:",
  "   - building type, such as modern villa, apartment complex, office interior",
  "   - view type, such as exterior, interior, aerial, street-level, courtyard, lobby",
  "   - key materials, such as concrete, glass, wood, stone",
  "   - environment, such as landscaped garden, urban street, vegetation, furniture",
  "   - lighting and time of day, such as soft daylight, overcast, dusk, warm interior lighting",
  "   - sky color, such as blue sky, white sky, black starless sky",
  "",
  "2. Always describe the image as a high-quality final architectural visualization, using consistent phrases such as:",
  "   - polished architectural visualization",
  "   - photoreal finish",
  "   - natural color grading",
  "   - realistic materials",
  "   - believable lighting",
  "   - refined vegetation",
  "   - premium archviz quality",
].join("\n");

/**
 * What each ComfyUI node means, for the waiting UI.
 *
 * The workers prefix their progress chunks with the node id that produced them,
 * so this turns "32 ..." into something a person can read. Ported from
 * momi-forge's NODE_STATUS_HINTS, which is where these labels were worked out
 * against the real graphs.
 *
 * Only labelled nodes are reported. An unlabelled node leaves the phase text as
 * it was rather than showing a bare number, and a graph re-export that renumbers
 * things degrades to that rather than lying about the stage.
 */
const NODE_STATUS_LABELS: Partial<Record<StillImageCategoryId, Readonly<Record<string, string>>>> = {
  "general-enhancement": {
    // The first block is taken from a live worker log rather than from forge's
    // table, which covered only the sampling nodes -- so most of a run reported
    // nothing and the card sat on whichever label it had last seen.
    "63": "Loading the input image",
    "34": "Resizing the image",
    "85": "Building the mask",
    "65": "Converting the mask",
    "76": "Softening the mask",
    "68": "Preparing the mask",
    "12": "Collecting the tiles",
    "13": "Preparing masked tiles",
    "66": "Preparing tiles",
    "32": "Sampling tiles",
    "64": "Decoding tiles",
    "79": "Advance details - preparing tiles",
    "69": "Advance details - preparing tiles",
    "22": "Advance details - sampling tiles",
    "21": "Advance details - decoding tiles",
    "53": "Body enhancement - preparing detections",
    "52": "Body enhancement - sampling detected persons",
    "54": "Face enhancement - sampling detected faces",
    "82": "Compositing result",
    "83": "Saving final image",
  },
  // Derived from the exported graph rather than from forge, which has no table
  // for this preset -- it drives a coarse three-stage bar off the profile in
  // workflow_profiles.json instead. Only the nodes worth naming are listed;
  // loaders and arithmetic helpers would make the trail noise.
  "pro-upscaler": {
    "99": "Loading the input image",
    "105": "Resizing the image",
    "77:77": "Loading the upscaler",
    "77:79": "Loading the upscaler",
    "77:78": "Upscaling with SeedVR",
    "96:93": "Splitting into tiles",
    "80:19": "Encoding tiles",
    "80:12": "Sampling tiles",
    "80:20": "Decoding tiles",
    "80:14": "Collecting the tiles",
    "81:13": "Reassembling the image",
    "81:38": "Resizing the result",
    "103": "Loading the upscale model",
    "102": "Upscaling the image",
    "97": "Saving final image",
  },
  "qwen-edit": {
    "76": "Loading image 1",
    "121": "Loading image 2",
    "165": "Loading image 3",
    "168": "Reading the image",
    "142": "Loading the model",
    "167": "Loading the LoRA",
    "151": "Scaling image 1",
    "160": "Scaling image 2",
    "166": "Scaling image 3",
    "149": "Encoding image 1",
    "158": "Encoding image 2",
    "163": "Encoding image 3",
    "154": "Reading the prompt",
    "161": "Reading the prompt",
    "139": "Sampling",
    "140": "Decoding the image",
    "182": "Resizing the result",
    "137": "Saving final image",
  },
  "reference-generator": {
    "42": "Loading main image",
    "43": "Loading reference image",
    "35": "Resizing main image",
    "36": "Resizing reference image",
    "44": "Preparing depth guidance",
    "19": "Building edge guidance",
    "20": "Applying structure guidance",
    "22": "Preparing reference features",
    "30": "Applying colour reference",
    "14": "Encoding latent input",
    "17": "Combining guidance",
    "29": "Preparing styled prompt",
    "12": "Running base sampler",
    "16": "Running upscale sampler",
    "182": "Resizing enhanced result",
    "151": "Normalizing enhancement input",
    "136": "Running enhancement sampler",
    "147": "Decoding enhanced image",
    "149": "Matching colours",
    "153": "Saving final image",
  },
};

/**
 * The nodes a preset has labels for. Exported so a test can hold them against
 * the real graph: a re-export that renumbers a node would otherwise leave the
 * label silently unreachable, and the trail would quietly go blank for that step
 * with nothing failing.
 */
export function stillImageLabelledNodeIds(categoryId: StillImageCategoryId) {
  return Object.keys(NODE_STATUS_LABELS[categoryId] ?? {});
}

/** The human label for a node a worker is reporting on, if it has one. */
export function stillImageNodeStatusLabel(categoryId: string, nodeId: string | undefined) {
  if (!nodeId) return undefined;
  const labels = NODE_STATUS_LABELS[categoryId as StillImageCategoryId];
  // Subgraph nodes arrive as "80:29"; the outer id is the one that is labelled.
  return labels?.[nodeId] ?? labels?.[nodeId.split(":")[0]];
}

const PRESETS: Record<StillImageCategoryId, StillImagePreset> = {
  "general-enhancement": {
    categoryId: "general-enhancement",
    workflowFile: "general-enhancement.json",
    inputTransport: "inline_base64",
    // Node 63 only. Node 81 in this graph is also a LoadImage but sits in the
    // disconnected drawn-mask branch, and node 86 is the mask's own base64 loader;
    // neither is an input slot. This is the graph that makes class-name scanning
    // unusable.
    inputBindings: [{ slot: 1, mode: "base64", nodeId: "63", inputName: "image" }],
    apply: applyGeneralEnhancement,
  },
  "pro-upscaler": {
    categoryId: "pro-upscaler",
    workflowFile: "pro-upscaler.json",
    inputTransport: "load_image_name",
    inputBindings: [{ slot: 1, mode: "load-image", nodeId: "99", inputName: "image", filename: stillImageSlotFilename(1) }],
    apply: applyProUpscaler,
  },
  "reference-generator": {
    categoryId: "reference-generator",
    workflowFile: "reference-generator.json",
    inputTransport: "inline_base64",
    inputBindings: [
      { slot: 1, mode: "base64", nodeId: "42", inputName: "image" },
      { slot: 2, mode: "base64", nodeId: "43", inputName: "image" },
    ],
    apply: applyReferenceGenerator,
  },
  "qwen-edit": {
    categoryId: "qwen-edit",
    workflowFile: "qwen-edit.json",
    inputTransport: "load_image_name",
    // Nodes 121 and 165 were exported holding the same value, "0001 (1).png".
    // These deterministic per-slot names are what stop slots 2 and 3 overwriting
    // each other; the exported values are never used.
    inputBindings: [
      { slot: 1, mode: "load-image", nodeId: "76", inputName: "image", filename: stillImageSlotFilename(1) },
      { slot: 2, mode: "load-image", nodeId: "121", inputName: "image", filename: stillImageSlotFilename(2) },
      { slot: 3, mode: "load-image", nodeId: "165", inputName: "image", filename: stillImageSlotFilename(3) },
    ],
    apply: applyQwenEdit,
  },
};
