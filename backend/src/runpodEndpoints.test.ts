process.env.RUNPOD_ENDPOINT_ID = "shared-animation-endpoint";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
process.env.RUNPOD_ENDPOINT_ID_PRO_UPSCALER = "pod-pro-upscaler";
process.env.RUNPOD_ENDPOINT_ID_QWEN_EDIT = "pod-qwen-edit";
// Blanked rather than merely omitted so the "no endpoint configured" path is
// tested against the fixture and not against whatever the host's .env happens to
// hold: env.ts skips any key already present in process.env, so an absent key
// here would be filled in from the real file and this suite would pass or fail
// depending on the machine it runs on.
process.env.RUNPOD_ENDPOINT_ID_GENERAL_ENHANCEMENT = "";
process.env.RUNPOD_ENDPOINT_ID_REFERENCE_GENERATOR = "";

import test from "node:test";
import assert from "node:assert/strict";

const { defaultRunpodEndpoint, resolveRunpodEndpoint, runpodEndpointForId, stillImageEndpointId } =
  await import("./runpodEndpoints.js");

// Routing a job to the wrong pod is not a soft failure. A still image graph sent
// to the shared Animation worker dies on its first loader node, and a cancel sent
// to the wrong endpoint 404s while the real work keeps running -- and billing.

function stillImageJob(categoryId: string, runpodEndpointId?: string) {
  return {
    runpodEndpointId,
    workflowOptions: { stillImage: { categoryId, settings: {} } },
  } as Parameters<typeof resolveRunpodEndpoint>[0];
}

test("an animation job goes to the shared endpoint", () => {
  const endpoint = resolveRunpodEndpoint({});
  assert.equal(endpoint.id, "shared-animation-endpoint");
  assert.deepEqual(endpoint, defaultRunpodEndpoint());
});

test("workflowOptions without a still image preset is still an animation job", () => {
  const endpoint = resolveRunpodEndpoint({ workflowOptions: { save: { cameraNumber: "0012" } } });
  assert.equal(endpoint.id, "shared-animation-endpoint");
});

test("a still image preset goes to its own pod", () => {
  const endpoint = resolveRunpodEndpoint(stillImageJob("pro-upscaler"));
  assert.equal(endpoint.id, "pod-pro-upscaler");
  assert.equal(endpoint.submitUrl, "https://api.runpod.ai/v2/pod-pro-upscaler/runsync");
  assert.equal(endpoint.statusUrl("job-1"), "https://api.runpod.ai/v2/pod-pro-upscaler/status/job-1");
  assert.equal(endpoint.cancelUrl("job-1"), "https://api.runpod.ai/v2/pod-pro-upscaler/cancel/job-1");
  assert.equal(endpoint.healthUrl, "https://api.runpod.ai/v2/pod-pro-upscaler/health");
});

test("each preset resolves to a distinct pod", () => {
  const upscaler = resolveRunpodEndpoint(stillImageJob("pro-upscaler"));
  const qwen = resolveRunpodEndpoint(stillImageJob("qwen-edit"));
  assert.notEqual(upscaler.id, qwen.id);
  assert.notEqual(upscaler.submitUrl, qwen.submitUrl);
});

test("a preset with no configured pod is refused, not sent to the shared worker", () => {
  // Falling back would put a local-GPU graph on a worker with no weights, and the
  // failure would surface as an opaque ComfyUI node error.
  assert.throws(
    () => resolveRunpodEndpoint(stillImageJob("general-enhancement")),
    /No RunPod endpoint is configured for the general-enhancement still image preset/,
  );
  assert.throws(() => resolveRunpodEndpoint(stillImageJob("reference-generator")), /Set RUNPOD_ENDPOINT_ID_REFERENCE_GENERATOR/);
});

test("a shared preset with no configured pod goes to the animation worker", () => {
  // Image Editing's graph is a Nano Banana API call. It loads no weights, so the
  // shared worker runs it -- and that worker is the one handed comfy_org_api_key.
  const endpoint = resolveRunpodEndpoint(stillImageJob("image-editing"));
  assert.equal(endpoint.id, "shared-animation-endpoint");
  assert.deepEqual(endpoint, defaultRunpodEndpoint());
});

test("a persisted endpoint id wins over the preset configuration", () => {
  // Once RunPod has acknowledged the job, that is where the work lives -- even if
  // the preset has since been pointed at a different pod.
  const endpoint = resolveRunpodEndpoint(stillImageJob("pro-upscaler", "pod-retired-but-still-running"));
  assert.equal(endpoint.id, "pod-retired-but-still-running");
});

test("a persisted endpoint id rescues a preset whose configuration was removed", () => {
  // Otherwise an in-flight job becomes uncancellable the moment its env var is
  // unset, and keeps billing on a pod nothing can reach.
  const endpoint = resolveRunpodEndpoint(stillImageJob("general-enhancement", "pod-general-enhancement"));
  assert.equal(endpoint.id, "pod-general-enhancement");
});

test("the default endpoint is not round-tripped through its id", () => {
  // Rebuilding it from runpodApiRoot would discard RUNPOD_ENDPOINT_BASE_URL, which
  // the topology load test uses to aim this at a mock server. That would send a
  // load test's traffic to the real api.runpod.ai.
  assert.deepEqual(runpodEndpointForId("shared-animation-endpoint"), defaultRunpodEndpoint());
});

test("job ids are encoded into status and cancel URLs", () => {
  const endpoint = runpodEndpointForId("pod-x");
  assert.equal(endpoint.statusUrl("a/b?c"), "https://api.runpod.ai/v2/pod-x/status/a%2Fb%3Fc");
  assert.equal(endpoint.cancelUrl("a/b?c"), "https://api.runpod.ai/v2/pod-x/cancel/a%2Fb%3Fc");
});

test("stillImageEndpointId reports configured presets and empty for the rest", () => {
  assert.equal(stillImageEndpointId("pro-upscaler"), "pod-pro-upscaler");
  assert.equal(stillImageEndpointId("qwen-edit"), "pod-qwen-edit");
  assert.equal(stillImageEndpointId("general-enhancement"), "");
  assert.equal(stillImageEndpointId("not-a-preset"), "");
});
