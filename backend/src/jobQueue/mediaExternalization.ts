import fs from "node:fs/promises";
import path from "node:path";

import { ensureJobFolders, safeSegment } from "../storageService.js";
import type { CreateJobRequest, Job, Project } from "../types.js";
import { videoExtension } from "./runpodInputNaming.js";

export async function externalizeJobInputMedia(project: Project, jobId: string, request: CreateJobRequest) {
  const prepared: CreateJobRequest = { ...request };
  if (request.inputImages) {
    prepared.inputImages = [];
    for (let index = 0; index < request.inputImages.length; index += 1) {
      prepared.inputImages.push(
        await persistInputDataUrl(project, jobId, request.inputImages[index], `input_${String(index + 1).padStart(2, "0")}`),
      );
    }
  }
  if (request.startFrame) prepared.startFrame = await persistInputDataUrl(project, jobId, request.startFrame, "start_frame");
  if (request.endFrame) prepared.endFrame = await persistInputDataUrl(project, jobId, request.endFrame, "end_frame");
  if (request.inputVideo) prepared.inputVideo = await persistInputDataUrl(project, jobId, request.inputVideo, "input_video");
  return prepared;
}

export function normalizeDurationSeconds(
  value: number | undefined,
  model: { supportedDurations?: number[]; defaultDurationSeconds?: number },
) {
  const options = model.supportedDurations ?? [];
  if (!options.length) return undefined;
  if (typeof value === "number" && options.includes(value)) return value;
  const fallback =
    model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds) ? model.defaultDurationSeconds : options[0];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return options.reduce((closest, option) => (Math.abs(option - value) < Math.abs(closest - value) ? option : closest), fallback);
}

export function inferInputType(request: CreateJobRequest): Job["inputType"] {
  if (request.inputVideo) return "video";
  if (request.startFrame || request.endFrame) return "start_end_frames";
  if ((request.inputImages?.length ?? 0) > 1) return "multi_image";
  if (request.inputImages?.length) return "single_image";
  return "text_only";
}

async function persistInputDataUrl(project: Project, jobId: string, value: string, fileBase: string) {
  const parsed = parseMediaDataUrl(value);
  if (!parsed) return value;
  const folders = await ensureJobFolders(project, jobId);
  const filePath = path.join(folders.input, `${safeSegment(fileBase)}.${parsed.extension}`);
  await fs.writeFile(filePath, parsed.buffer);
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

function parseMediaDataUrl(value: string) {
  const match = value.match(/^data:(image|video)\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/);
  if (!match) return undefined;
  const kind = match[1].toLowerCase();
  const subtype = match[2].toLowerCase();
  return { extension: mediaExtension(kind, subtype), buffer: Buffer.from(match[3], "base64") };
}

function mediaExtension(kind: string, subtype: string) {
  const normalized = subtype.toLowerCase();
  if (kind === "image" && normalized === "jpeg") return "jpg";
  if (kind === "video") return videoExtension(normalized);
  return normalized.replace(/[^a-z0-9]+/g, "") || "bin";
}
