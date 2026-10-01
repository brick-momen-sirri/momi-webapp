// Dispatch-side preparation for LTX 2.5 CQ First & Last Frame: plan, normalize
// both images, send them, and compile the graph. Beside the image-to-video route
// in prepareRunpodSubmission, and built from the same pieces.

import fs from "node:fs/promises";
import path from "node:path";

import { runpodInlineMediaMaxBytes } from "../config.js";
import {
  compileLtxCqFlfWorkflow,
  loadLtxCqFlfTemplate,
  planLtxCqFlf,
  type LtxCqFlfPlan,
} from "../ltxCqFirstLastFrame.js";
import { prepareLtxCqI2vImage } from "../ltxCqImageToVideoMedia.js";
import type { RunpodComfyImageInput } from "../runpodComfyService.js";
import type { Job } from "../types.js";
import { ltxCqImageInput, ltxCqLocalSourcePath } from "./ltxCqImageToVideoSubmission.js";
import type { PreparedSubmission } from "./runpodExecution.js";

/** Per job and per role: a warm worker's ComfyUI input folder is shared across jobs. */
export function ltxCqFlfImageNames(jobId: string) {
  return { first: `ltxflfcq-${jobId}-first.png`, last: `ltxflfcq-${jobId}-last.png` };
}

/**
 * Build the submission. Everything that can reject the job -- an unsupported size
 * or length, a missing or undecodable image on either side -- runs before anything
 * is uploaded, so a bad input never becomes a paid GPU task. Each image goes
 * through the image-to-video normalizer on its own, so the two can arrive in
 * different formats, sizes and orientations.
 */
export async function prepareLtxCqFlfSubmission(job: Job, inputFolder: string): Promise<PreparedSubmission> {
  const plan = planLtxCqFlf(job.resolution, job.durationSeconds);
  const prompt = job.prompt?.trim() ?? "";
  if (!prompt) throw new Error("LTX 2.5 CQ First & Last Frame needs a prompt describing the movement between the frames.");
  const names = ltxCqFlfImageNames(job.id);
  const imageNames = [names.first, names.last];
  const outputPrefix = `momi/${job.id}/FLF_CQ`;

  // A resume re-polls a job RunPod already holds: nothing is sent again, but the
  // graph is rebuilt because the caller snapshots it.
  if (job.runpodJobId) {
    const workflow = await ltxCqFlfWorkflow(plan, prompt, names, outputPrefix);
    return { workflow, runpodImages: { images: [], imageNames }, runpodVideo: undefined };
  }

  const firstSource = await ltxCqLocalSourcePath(job.inputImages[0], "a first frame");
  const lastSource = await ltxCqLocalSourcePath(job.inputImages[1], "a last frame");
  await fs.mkdir(inputFolder, { recursive: true });
  const firstPath = await prepareFrame(firstSource, path.join(inputFolder, `${job.id}_ltx_cq_first.png`), "first");
  const lastPath = await prepareFrame(lastSource, path.join(inputFolder, `${job.id}_ltx_cq_last.png`), "last");

  // Compiled before the upload too: a graph or manifest that no longer wires both
  // guides fails here, not on the GPU.
  const workflow = await ltxCqFlfWorkflow(plan, prompt, names, outputPrefix);
  const first = await ltxCqImageInput(firstPath, names.first);
  const last = await ltxCqImageInput(lastPath, names.last, runpodInlineMediaMaxBytes - inlineBytes(first));
  return { workflow, runpodImages: { images: [first, last], imageNames }, runpodVideo: undefined };
}

/** The normalizer's own messages, naming which of the two images failed. */
async function prepareFrame(sourcePath: string, outputPath: string, role: "first" | "last") {
  try {
    return await prepareLtxCqI2vImage(sourcePath, outputPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^The input image\b/, `The ${role} frame`));
  }
}

async function ltxCqFlfWorkflow(
  plan: LtxCqFlfPlan,
  prompt: string,
  names: { first: string; last: string },
  outputPrefix: string,
) {
  const { graph, mode } = await loadLtxCqFlfTemplate();
  return compileLtxCqFlfWorkflow(graph, mode, {
    plan,
    prompt,
    firstImageName: names.first,
    lastImageName: names.last,
    outputPrefix,
  });
}

/** Bytes an inline image takes from the request's shared budget; none when sent by URL. */
function inlineBytes(input: RunpodComfyImageInput) {
  const data = input.image ?? "";
  return data ? Math.floor((data.slice(data.indexOf(",") + 1).length * 3) / 4) : 0;
}
