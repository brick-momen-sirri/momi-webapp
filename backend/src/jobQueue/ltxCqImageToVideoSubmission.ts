// Dispatch-side preparation for LTX 2.5 CQ Image to Video: plan, normalize the
// image, send it, and wire the graph. The fourth route in prepareRunpodSubmission.

import fs from "node:fs/promises";
import path from "node:path";

import { runpodInlineMediaMaxBytes } from "../config.js";
import { buildLtxCqI2vWorkflow, ltxCqI2vWorkflowPath, planLtxCqI2v, type LtxCqI2vPlan } from "../ltxCqImageToVideo.js";
import { prepareLtxCqI2vImage } from "../ltxCqImageToVideoMedia.js";
import { resolveAllowedExistingMediaPath } from "../mediaPathPolicy.js";
import type { RunpodComfyImageInput } from "../runpodComfyService.js";
import { createRunpodInputUrl } from "../runpodInputUrlService.js";
import { uploadRunpodObjectInput } from "../runpodObjectInputService.js";
import type { Job } from "../types.js";
import { localMediaFilePathFromUrl } from "./providerInputs.js";
import type { PreparedSubmission } from "./runpodExecution.js";

/**
 * Build the submission. Everything that can reject the job -- an unsupported
 * size or length, an unreadable image -- runs before the upload, so a bad input
 * never becomes a paid GPU task.
 *
 * The filename is per job, and written to both LoadImage and the payload: the
 * worker's ComfyUI input folder is shared across the jobs a warm worker takes.
 */
export async function prepareLtxCqI2vSubmission(job: Job, inputFolder: string): Promise<PreparedSubmission> {
  const plan = planLtxCqI2v(job.resolution, job.durationSeconds);
  const prompt = job.prompt?.trim() ?? "";
  if (!prompt) throw new Error("LTX 2.5 CQ needs a prompt.");
  const imageName = `ltxi2vcq-${job.id}.png`;
  const outputPrefix = `momi/${job.id}/I2V_CQ`;

  // A resume re-polls a job RunPod already holds: nothing is sent again, but the
  // graph is rebuilt because the caller snapshots it.
  if (job.runpodJobId) {
    const workflow = await ltxCqI2vWorkflow(plan, prompt, imageName, outputPrefix);
    return { workflow, runpodImages: { images: [], imageNames: [imageName] }, runpodVideo: undefined };
  }

  const sourcePath = await ltxCqLocalSourcePath(job.inputImages[0], "an input image");
  await fs.mkdir(inputFolder, { recursive: true });
  const preparedPath = await prepareLtxCqI2vImage(sourcePath, path.join(inputFolder, `${job.id}_ltx_cq_input.png`));
  const image = await ltxCqImageInput(preparedPath, imageName);

  const workflow = await ltxCqI2vWorkflow(plan, prompt, imageName, outputPrefix);
  return { workflow, runpodImages: { images: [image], imageNames: [imageName] }, runpodVideo: undefined };
}

async function ltxCqI2vWorkflow(plan: LtxCqI2vPlan, prompt: string, imageName: string, outputPrefix: string) {
  const template = JSON.parse(await fs.readFile(ltxCqI2vWorkflowPath(), "utf8")) as unknown;
  return buildLtxCqI2vWorkflow(template, { plan, prompt, imageName, outputPrefix });
}

/**
 * By URL where one is available, which is how every input on this host now goes.
 * Inline base64 -- the transport the handoff's GPU runs used -- stays as the
 * fallback, but only whole: the PNG is never re-encoded to fit, since the model
 * would then condition on the compression. `inlineBudgetBytes` is what is left of
 * the inline limit when an earlier image of the same request already used some.
 *
 * Shared with First & Last Frame, which sends two images this way.
 */
export async function ltxCqImageInput(
  filePath: string,
  name: string,
  inlineBudgetBytes = runpodInlineMediaMaxBytes,
): Promise<RunpodComfyImageInput> {
  const url = createRunpodInputUrl(filePath, "image") ?? (await uploadRunpodObjectInput(filePath, "image"));
  if (url) return { name, url };

  const png = await fs.readFile(filePath);
  if (png.byteLength > inlineBudgetBytes) {
    throw new Error(
      `The normalized input image is ${(png.byteLength / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(inlineBudgetBytes / 1024 / 1024).toFixed(1)} MB left of the inline limit. Configure RUNPOD_INPUT_BASE_URL ` +
        "or the RUNPOD_INPUT_BUCKET_* settings so it can be sent by URL.",
    );
  }
  return { name, image: `data:image/png;base64,${png.toString("base64")}` };
}

/** `what` names the image for the artist: "an input image", "a first frame". */
export async function ltxCqLocalSourcePath(inputImage: string | undefined, what: string) {
  if (!inputImage) throw new Error(`LTX 2.5 CQ needs ${what}.`);
  // Normalized here, so it has to be bytes this host holds. The submission route
  // already refuses a link.
  const filePath = localMediaFilePathFromUrl(inputImage);
  const resolved = filePath ? await resolveAllowedExistingMediaPath(filePath) : undefined;
  if (!resolved) throw new Error(`LTX 2.5 CQ's ${what.replace(/^an? /, "")} is missing or is not saved media in this app.`);
  return resolved;
}
