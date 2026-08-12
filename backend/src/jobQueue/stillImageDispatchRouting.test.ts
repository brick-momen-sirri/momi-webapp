process.env.RUNPOD_ENDPOINT_ID = "shared-animation-endpoint";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
process.env.RUNPOD_ENDPOINT_ID_QWEN_EDIT = "pod-qwen-edit";
process.env.RUNPOD_ENDPOINT_ID_GENERAL_ENHANCEMENT = "pod-general-enhancement";
process.env.RUNPOD_ENDPOINT_ID_PRO_UPSCALER = "";
process.env.RUNPOD_ENDPOINT_ID_REFERENCE_GENERATOR = "";
process.env.RUNPOD_INPUT_BASE_URL = "";
process.env.PUBLIC_API_BASE_URL = "";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import sharp from "sharp";

const { prepareRunpodSubmission } = await import("./runpodExecution.js");
const { resolveRunpodEndpoint } = await import("../runpodEndpoints.js");
const { normalizeStillImageOptions } = await import("../stillImageRequest.js");
import type { Job, WorkflowModel } from "../types.js";

// Which materializer a job gets is a routing decision with real consequences: the
// Animation one derives destination filenames from the graph, which is exactly what
// breaks these presets. These tests assert the two routes side by side.

let animationWorkflowPath = "";
let tempRoot = "";

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-still-routing-"));
  animationWorkflowPath = path.join(tempRoot, "animation.json");
  // A minimal API-format graph whose LoadImage carries a distinctive filename, so
  // "the Animation path still names destinations from the graph" is observable.
  await fs.writeFile(
    animationWorkflowPath,
    JSON.stringify({
      "1": { class_type: "LoadImage", inputs: { image: "anim_from_graph.png" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "ComfyUI" } },
    }),
    "utf8",
  );
});

after(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

const animationModel: WorkflowModel = {
  id: "anim_model",
  name: "Anim Model",
  category: "image_editing",
  workflowPath: "",
  requiredInputs: ["single_image"],
  requiresPrompt: false,
  requiresImage: true,
  requiresStartEndFrames: false,
  outputType: "image",
};

async function pngDataUrl(size: number) {
  const channels = 3 as const;
  const png = await sharp(Buffer.alloc(size * size * channels), { raw: { width: size, height: size, channels } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function job(overrides: Partial<Job>): Job {
  return {
    id: "job_routing",
    projectId: "prj_1",
    userId: "usr_1",
    modelId: "anim_model",
    modelName: "Anim Model",
    category: "image_editing",
    inputType: "single_image",
    status: "queued",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "image",
    projectFolderPath: path.join(tempRoot, "project"),
    workflowPath: animationWorkflowPath,
    createdAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  } as Job;
}

test("an animation job still uses the graph-derived filename", async () => {
  const image = await pngDataUrl(8);
  const prepared = await prepareRunpodSubmission(
    job({ inputImages: [image] }),
    { ...animationModel, workflowPath: animationWorkflowPath },
    "PROJECT",
    tempRoot,
  );

  assert.deepEqual(prepared.runpodImages.imageNames, ["anim_from_graph.png"], "unchanged Animation behaviour");
  assert.equal(prepared.runpodImages.images.length, 1);
  assert.doesNotMatch(prepared.runpodImages.imageNames[0], /momi_still/, "must not pick up still image naming");
});

test("a still image job uses the deterministic per-slot names instead", async () => {
  const images = await Promise.all([pngDataUrl(8), pngDataUrl(9), pngDataUrl(10)]);
  const prepared = await prepareRunpodSubmission(
    job({
      inputImages: images,
      workflowOptions: {
        stillImage: normalizeStillImageOptions({
          categoryId: "qwen-edit",
          settings: { mode: "edit", imageCount: "3" },
        }),
      },
      prompt: "swap the cladding",
    }),
    animationModel,
    "PROJECT",
    tempRoot,
  );

  assert.deepEqual(prepared.runpodImages.imageNames, ["momi_still_01.png", "momi_still_02.png", "momi_still_03.png"]);
  assert.equal(prepared.runpodVideo, undefined, "still image presets take no video");

  // The graph really is the preset's, wired for three images.
  const graph = prepared.workflow as Record<string, { inputs?: Record<string, unknown> }>;
  assert.equal(graph["76"]?.inputs?.image, "momi_still_01.png");
  assert.equal(graph["121"]?.inputs?.image, "momi_still_02.png");
  assert.equal(graph["165"]?.inputs?.image, "momi_still_03.png");
  assert.deepEqual(graph["145"]?.inputs?.positive, ["164", 0], "three-image conditioning chain");
  assert.equal(graph["154"]?.inputs?.text, "swap the cladding");
});

test("a base64 preset puts image data in the graph and nothing in the payload", async () => {
  const prepared = await prepareRunpodSubmission(
    job({
      inputImages: [await pngDataUrl(8)],
      workflowOptions: { stillImage: normalizeStillImageOptions({ categoryId: "general-enhancement" }) },
    }),
    animationModel,
    "PROJECT",
    tempRoot,
  );

  assert.equal(prepared.runpodImages.images.length, 0, "no payload images for a base64 preset");
  const graph = prepared.workflow as Record<string, { inputs?: Record<string, unknown> }>;
  const inlined = String(graph["63"]?.inputs?.image);
  assert.ok(inlined.length > 0);
  assert.equal(inlined.startsWith("data:"), false);
  assert.equal(/^https?:\/\//i.test(inlined), false, "never a URL");
});

test("local materialization failure throws before anything could be submitted", async () => {
  // prepareRunpodSubmission runs before the provider call in executeRunpodJob, so a
  // rejection here is the guarantee that a bad input costs no RunPod submission.
  await assert.rejects(
    () =>
      prepareRunpodSubmission(
        job({
          inputImages: ["https://cdn.example/remote.png"],
          workflowOptions: { stillImage: normalizeStillImageOptions({ categoryId: "general-enhancement" }) },
        }),
        animationModel,
        "PROJECT",
        tempRoot,
      ),
    /remote URLs cannot be inlined/,
  );
});

test("a slot-count mismatch fails locally rather than submitting a half-wired graph", async () => {
  const single = await pngDataUrl(8);
  await assert.rejects(
    () =>
      prepareRunpodSubmission(
        job({
          inputImages: [single],
          workflowOptions: { stillImage: normalizeStillImageOptions({ categoryId: "reference-generator" }) },
        }),
        animationModel,
        "PROJECT",
        tempRoot,
      ),
    /needs 2 input image\(s\); the job carries 1/,
  );
});

test("the still image job resolves to its own pod, and a persisted id wins", async () => {
  const qwen = job({
    workflowOptions: { stillImage: normalizeStillImageOptions({ categoryId: "qwen-edit", settings: { mode: "consistency" } }) },
  });
  assert.equal(resolveRunpodEndpoint(qwen).id, "pod-qwen-edit");

  // Submit, status and cancel all read the same resolved endpoint, and once RunPod
  // has acknowledged the job the persisted id is authoritative.
  const endpoint = resolveRunpodEndpoint({ ...qwen, runpodEndpointId: "pod-acknowledged" });
  assert.equal(endpoint.id, "pod-acknowledged");
  assert.match(endpoint.submitUrl, /\/v2\/pod-acknowledged\/runsync$/);
  assert.match(endpoint.statusUrl("job-1"), /\/v2\/pod-acknowledged\/status\/job-1$/);
  assert.match(endpoint.cancelUrl("job-1"), /\/v2\/pod-acknowledged\/cancel\/job-1$/);

  // An animation job keeps the shared endpoint.
  assert.equal(resolveRunpodEndpoint(job({})).id, "shared-animation-endpoint");
});

test("a preset with no configured pod is refused before materialization", async () => {
  assert.throws(
    () =>
      resolveRunpodEndpoint(job({ workflowOptions: { stillImage: normalizeStillImageOptions({ categoryId: "pro-upscaler" }) } })),
    /No RunPod endpoint is configured for the pro-upscaler still image preset/,
  );
});
