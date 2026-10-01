// Which RunPod endpoint a job goes to.
//
// Until Still Images, this was a single module-level URL in config.ts: every
// workflow relayed to an external provider API (Kling, Veo, Seedance, Gemini,
// GPT-Image), so one generic serverless ComfyUI worker served all of them and
// there was nothing to choose between.
//
// Still image presets break that. Most execute locally on the GPU -- Flux via
// Nunchaku, KSampler, 4x-UltraSharp, GGUF VLMs -- so each runs on its own pod
// carrying its own weights and custom nodes. The endpoint therefore becomes a
// per-job property, and one that must be remembered: a job acknowledged by RunPod
// is polled and cancelled against the endpoint it was submitted to, and a
// dispatcher restart or failover must not guess.
//
// The exception is a preset whose graph is itself a provider call -- Image Editing
// is one -- which needs no weights and so goes back to the generic worker unless
// an override names a pod for it.

import {
  runpodApiRoot,
  runpodCancelUrl,
  runpodEndpointId,
  runpodEndpointUrl,
  runpodHealthUrl,
  runpodStatusUrl,
  runpodStreamUrl,
  runpodStillImageEndpointIds,
  runpodLtxCqI2vEndpointId,
  runpodSubmissionMode,
  runpodVideoEnhancerEndpointId,
} from "./config.js";
import { isLtxCqPodModelId } from "./ltxCqFirstLastFrame.js";
import { stillImageRunsOnSharedEndpoint } from "./stillImageWorkflow.js";
import type { WorkflowOptions } from "./types.js";

export type RunpodEndpoint = {
  /** RunPod endpoint id, or "" when only an explicit base URL override is configured. */
  id: string;
  submitUrl: string;
  statusUrl: (jobId: string) => string;
  cancelUrl: (jobId: string) => string;
  /**
   * Progress chunks the worker has emitted but nobody has read yet.
   *
   * Drain-on-read: each call returns only what has arrived since the last one,
   * so this is only useful while the job is running. Reading it after the job
   * finishes returns an empty list, which is exactly how its usefulness was
   * missed the first time round.
   */
  streamUrl: (jobId: string) => string;
  healthUrl: string;
  /**
   * The worker reports its own outcome as `output.success`, and a COMPLETED job
   * without `success: true` is a failure. Set for the LTX 2.5 CQ pod, whose
   * handler does this; other workers do not send the field and are judged as before.
   */
  reportsWorkerSuccess?: boolean;
  /**
   * The worker downloads an `images[]` entry sent as `{ name, url }`. Set only for
   * the Animation endpoint, whose handler was probed doing so on 2026-09-24. The
   * Qwen Edit, Pro Upscaler and Flux Klein Upscaler pods run an older handler that
   * base64-decodes `image` and fails the whole job on any entry without one. Read
   * by the Still Images materializer, which inlines the bytes when this is unset.
   */
  acceptsUrlInputs?: boolean;
};

/**
 * The endpoint every Animation workflow uses.
 *
 * Built from the config values rather than from runpodApiRoot, so the
 * RUNPOD_ENDPOINT_BASE_URL and RUNPOD_ENDPOINT_URL overrides keep working --
 * topologyLoadTest.ts relies on them to point this at a mock server.
 */
export function defaultRunpodEndpoint(): RunpodEndpoint {
  return {
    id: runpodEndpointId,
    submitUrl: runpodEndpointUrl,
    statusUrl: runpodStatusUrl,
    cancelUrl: runpodCancelUrl,
    streamUrl: runpodStreamUrl,
    healthUrl: runpodHealthUrl,
    acceptsUrlInputs: true,
  };
}

export function runpodEndpointForId(id: string): RunpodEndpoint {
  // Round-tripping the default through its id would discard the base URL
  // override and start addressing api.runpod.ai for real.
  if (id && id === runpodEndpointId) return defaultRunpodEndpoint();

  const base = `${runpodApiRoot}/${encodeURIComponent(id)}`;
  // By id, so a resume after a restart -- which rebuilds the endpoint from the
  // persisted runpodEndpointId -- keeps the same success rule.
  const ltxCqPod = id === runpodVideoEnhancerEndpointId || id === runpodLtxCqI2vEndpointId;
  return {
    ...(ltxCqPod ? { reportsWorkerSuccess: true } : {}),
    id,
    submitUrl: `${base}/${runpodSubmissionMode === "async" ? "run" : "runsync"}`,
    statusUrl: (jobId: string) => `${base}/status/${encodeURIComponent(jobId)}`,
    cancelUrl: (jobId: string) => `${base}/cancel/${encodeURIComponent(jobId)}`,
    streamUrl: (jobId: string) => `${base}/stream/${encodeURIComponent(jobId)}`,
    healthUrl: `${base}/health`,
  };
}

export function stillImageEndpointId(categoryId: string) {
  return runpodStillImageEndpointIds[categoryId] ?? "";
}

/**
 * Pick the endpoint for a job.
 *
 * A persisted runpodEndpointId always wins: once RunPod has acknowledged the
 * submission, that is where the work lives, whatever the configuration has since
 * been changed to.
 */
export function resolveRunpodEndpoint(job: {
  runpodEndpointId?: string;
  workflowOptions?: WorkflowOptions;
  modelId?: string;
}): RunpodEndpoint {
  if (job.runpodEndpointId) return runpodEndpointForId(job.runpodEndpointId);

  // The enhancer's graph loads ~46 GiB of LTX weights that only its own image
  // carries, so like a local-GPU still image preset it never falls back.
  if (job.workflowOptions?.videoEnhancer) {
    if (runpodVideoEnhancerEndpointId) return runpodEndpointForId(runpodVideoEnhancerEndpointId);
    throw new Error("No RunPod endpoint is configured for the Video Enhancer. Set RUNPOD_ENDPOINT_ID_VIDEO_ENHANCER.");
  }
  // Same pod, same reason, for both its generation graphs. Keyed on the model:
  // neither has options of its own.
  if (isLtxCqPodModelId(job.modelId)) {
    if (runpodLtxCqI2vEndpointId) return runpodEndpointForId(runpodLtxCqI2vEndpointId);
    throw new Error(
      "No RunPod endpoint is configured for LTX 2.5 CQ. Set RUNPOD_ENDPOINT_ID_VIDEO_ENHANCER or RUNPOD_ENDPOINT_ID_LTX_CQ_I2V.",
    );
  }

  const categoryId = job.workflowOptions?.stillImage?.categoryId;
  if (!categoryId) return defaultRunpodEndpoint();

  const configured = stillImageEndpointId(categoryId);
  if (configured) return runpodEndpointForId(configured);

  // A shared preset loads no models -- its graph is a remote API call -- so the
  // Animation endpoint runs it as-is, and that is where comfy_org_api_key is
  // already sent. An override still wins above, for pinning one to its own pod.
  if (stillImageRunsOnSharedEndpoint(categoryId)) return defaultRunpodEndpoint();

  throw new Error(
    `No RunPod endpoint is configured for the ${categoryId} still image preset. ` +
      `Set RUNPOD_ENDPOINT_ID_${categoryId.replaceAll("-", "_").toUpperCase()}.`,
  );
}
