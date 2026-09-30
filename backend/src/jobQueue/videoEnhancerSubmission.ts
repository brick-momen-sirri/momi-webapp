// Dispatch-side preparation for a Video Enhancer job: probe, plan, normalize,
// upload, and wire the graph. The third route in prepareRunpodSubmission, beside
// the Animation and Still Images ones.

import fs from "node:fs/promises";
import path from "node:path";

import { resolveAllowedExistingMediaPath } from "../mediaPathPolicy.js";
import { createRunpodInputUrl } from "../runpodInputUrlService.js";
import { uploadRunpodObjectInput } from "../runpodObjectInputService.js";
import type { Job } from "../types.js";
import {
  buildVideoEnhancerWorkflow,
  DEFAULT_VIDEO_ENHANCER_SEED,
  planVideoEnhancement,
  videoEnhancerWorkflowPath,
  type VideoEnhancerOptions,
  type VideoEnhancerPlan,
} from "../videoEnhancer.js";
import { prepareVideoEnhancerInput, probeVideoEnhancerSource } from "../videoEnhancerMedia.js";
import { localMediaFilePathFromUrl } from "./providerInputs.js";
import type { PreparedSubmission } from "./runpodExecution.js";

/**
 * Build the enhancer's submission, recording the plan on the job.
 *
 * The plan goes onto workflowOptions because the result cannot be finished
 * without it -- the source frame rate and frame count are what the render is
 * stretched back to -- and a dispatcher restart between submit and settle must
 * still know them. job.resolution becomes the enhanced size, which is what that
 * field means on every other job.
 *
 * Throws before anything is uploaded when the source cannot be used, so a clip
 * that is too short or unreadable costs nothing.
 */
export async function prepareVideoEnhancerSubmission(
  job: Job,
  options: VideoEnhancerOptions,
  inputFolder: string,
): Promise<PreparedSubmission> {
  const videoName = `momi_${job.id}_cq_input.mp4`;
  const seed = options.seed ?? DEFAULT_VIDEO_ENHANCER_SEED;
  const outputPrefix = `momi/${job.id}/video_enhancer`;

  // A resume re-polls a job RunPod already holds; its input was uploaded on the
  // first pass and nothing here is sent again. The graph is still rebuilt, from
  // the recorded plan, because the caller snapshots it.
  if (job.runpodJobId && options.plan) {
    const workflow = await videoEnhancerWorkflow(options.plan, videoName, seed, outputPrefix);
    return emptyInputs(workflow, videoName);
  }

  const sourcePath = await localSourcePath(job.inputVideo);
  const source = await probeVideoEnhancerSource(sourcePath);
  const plan = planVideoEnhancement(source, options.longSide);

  await fs.mkdir(inputFolder, { recursive: true });
  const preparedPath = await prepareVideoEnhancerInput(
    sourcePath,
    path.join(inputFolder, `${job.id}_video_enhancer_input.mp4`),
    plan,
    source,
  );

  // By URL only. The inline fallback other video inputs have would re-encode a
  // 1440p guide down to a few megabytes, and the enhancer would then faithfully
  // enhance the compression.
  const url = createRunpodInputUrl(preparedPath, "video") ?? (await uploadRunpodObjectInput(preparedPath, "video"));
  if (!url) {
    throw new Error(
      "The Video Enhancer sends its input by URL, and neither RUNPOD_INPUT_BASE_URL nor the RUNPOD_INPUT_BUCKET_* " +
        "object storage settings are configured.",
    );
  }

  job.workflowOptions = { ...job.workflowOptions, videoEnhancer: { ...options, plan } };
  job.resolution = { width: plan.width, height: plan.height, label: `${plan.width}x${plan.height}` };

  const workflow = await videoEnhancerWorkflow(plan, videoName, seed, outputPrefix);
  return {
    workflow,
    runpodImages: { images: [], imageNames: [] },
    runpodVideo: { videos: [{ name: videoName, url }], videoName },
  };
}

async function videoEnhancerWorkflow(plan: VideoEnhancerPlan, videoName: string, seed: number, outputPrefix: string) {
  const template = JSON.parse(await fs.readFile(videoEnhancerWorkflowPath(), "utf8")) as unknown;
  return buildVideoEnhancerWorkflow(template, { plan, videoName, seed, outputPrefix });
}

function emptyInputs(workflow: unknown, videoName: string): PreparedSubmission {
  return { workflow, runpodImages: { images: [], imageNames: [] }, runpodVideo: { videos: [], videoName } };
}

async function localSourcePath(inputVideo: string | undefined) {
  if (!inputVideo) throw new Error("The Video Enhancer needs an input video.");
  // The source is probed and re-encoded here, so it has to be bytes this host
  // holds. The submission route already refuses anything else.
  const filePath = localMediaFilePathFromUrl(inputVideo);
  const resolved = filePath ? await resolveAllowedExistingMediaPath(filePath) : undefined;
  if (!resolved) throw new Error("The Video Enhancer's input video is missing or is not saved media in this app.");
  return resolved;
}
