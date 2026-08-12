// Which RunPod endpoint a job goes to.
//
// Until Still Images, this was a single module-level URL in config.ts: every
// workflow relayed to an external provider API (Kling, Veo, Seedance, Gemini,
// GPT-Image), so one generic serverless ComfyUI worker served all of them and
// there was nothing to choose between.
//
// Still image presets break that. They execute locally on the GPU -- Flux via
// Nunchaku, KSampler, 4x-UltraSharp, GGUF VLMs -- so each runs on its own pod
// carrying its own weights and custom nodes. The endpoint therefore becomes a
// per-job property, and one that must be remembered: a job acknowledged by RunPod
// is polled and cancelled against the endpoint it was submitted to, and a
// dispatcher restart or failover must not guess.

import {
  runpodApiRoot,
  runpodCancelUrl,
  runpodEndpointId,
  runpodEndpointUrl,
  runpodHealthUrl,
  runpodStatusUrl,
  runpodStillImageEndpointIds,
  runpodSubmissionMode,
} from "./config.js";
import type { WorkflowOptions } from "./types.js";

export type RunpodEndpoint = {
  /** RunPod endpoint id, or "" when only an explicit base URL override is configured. */
  id: string;
  submitUrl: string;
  statusUrl: (jobId: string) => string;
  cancelUrl: (jobId: string) => string;
  healthUrl: string;
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
    healthUrl: runpodHealthUrl,
  };
}

export function runpodEndpointForId(id: string): RunpodEndpoint {
  // Round-tripping the default through its id would discard the base URL
  // override and start addressing api.runpod.ai for real.
  if (id && id === runpodEndpointId) return defaultRunpodEndpoint();

  const base = `${runpodApiRoot}/${encodeURIComponent(id)}`;
  return {
    id,
    submitUrl: `${base}/${runpodSubmissionMode === "async" ? "run" : "runsync"}`,
    statusUrl: (jobId: string) => `${base}/status/${encodeURIComponent(jobId)}`,
    cancelUrl: (jobId: string) => `${base}/cancel/${encodeURIComponent(jobId)}`,
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
export function resolveRunpodEndpoint(job: { runpodEndpointId?: string; workflowOptions?: WorkflowOptions }): RunpodEndpoint {
  if (job.runpodEndpointId) return runpodEndpointForId(job.runpodEndpointId);

  const categoryId = job.workflowOptions?.stillImage?.categoryId;
  if (!categoryId) return defaultRunpodEndpoint();

  const configured = stillImageEndpointId(categoryId);
  if (!configured) {
    throw new Error(
      `No RunPod endpoint is configured for the ${categoryId} still image preset. ` +
        `Set RUNPOD_ENDPOINT_ID_${categoryId.replaceAll("-", "_").toUpperCase()}.`,
    );
  }
  return runpodEndpointForId(configured);
}
