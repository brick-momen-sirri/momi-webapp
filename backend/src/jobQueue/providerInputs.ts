// Turns a job's stored input media into the shape a generation provider accepts.
//
// This exists as its own module because "how do we hand bytes to RunPod or to a
// local ComfyUI worker" is a different problem from "what is this job's state".
// Nothing here touches the queue's in-memory job array, dispatch flags or lease
// state -- every function takes a job (or a path) and returns a descriptor, so it
// can be reasoned about and tested without standing up a queue.
//
// The two provider paths differ in a way worth knowing before editing:
//   - RunPod cannot see this host's disk. Inputs go out as a signed URL when
//     RUNPOD_INPUT_BASE_URL is reachable, and are otherwise inlined as base64 in
//     the JSON request -- which is why the size assertions below are load-bearing:
//     RunPod rejects bodies over 20MiB, so an oversized inline input must fail
//     here with an actionable message rather than at the provider.
//   - Local ComfyUI shares the filesystem, so inputs are uploaded to the worker
//     and referenced by the returned name.
import path from "node:path";
import fs from "node:fs/promises";

import { uploadImage, uploadInputFile } from "../comfyClient.js";
import {
  brickProjectsRoot,
  comfyRoot,
  localProjectsRoot,
  runpodInlineMediaMaxBytes,
  runpodInputBaseUrl,
  uploadedMediaRoot,
} from "../config.js";
import type { RunpodComfyImageInput } from "../runpodComfyService.js";
import { parseImageDataUrl, prepareRunpodInlineImageInput, runpodInlineImageByteBudget } from "../runpodImageInlineService.js";
import { createRunpodInputUrl, type RunpodInputKind } from "../runpodInputUrlService.js";
import { prepareRunpodVideoFile } from "../runpodVideoPreprocessService.js";
import { safeSegment } from "../storageService.js";
import type { Job, WorkflowModel } from "../types.js";
import { detectWorkflowLoadImageNames, detectWorkflowLoadVideoNames } from "../workflowService.js";
// Imported from the sibling rather than ./index.js: index re-exports this module's
// neighbours, so going through it would make the barrel import itself.
import { chooseRunpodImageInputNames, fallbackRunpodVideoName, videoExtension } from "./runpodInputNaming.js";

export async function materializeRunpodInputImages(job: Job, model: WorkflowModel) {
  const expectedNames = await detectWorkflowLoadImageNames(model);
  const images: RunpodComfyImageInput[] = [];
  const imageNames = chooseRunpodImageInputNames(job.inputImages, job.id, expectedNames);
  const inlineImageMaxBytes = runpodInlineImageByteBudget(job.inputImages.length);

  for (let index = 0; index < job.inputImages.length; index += 1) {
    const value = job.inputImages[index];
    const name = imageNames[index];
    images.push(await runpodImageInput(value, name, inlineImageMaxBytes));
  }

  return {
    images,
    imageNames: images.map((image) => image.name),
  };
}

export async function materializeRunpodInputVideo(job: Job, model: WorkflowModel, inputFolder: string) {
  if (!job.inputVideo) return undefined;
  const expectedNames = await detectWorkflowLoadVideoNames(model);
  const name = expectedNames?.[0] ?? fallbackRunpodVideoName(job.inputVideo, job.id);
  const filePath = localMediaFilePathFromUrl(job.inputVideo);
  const preparedFilePath = filePath ? await prepareRunpodVideoFile(filePath, inputFolder, model) : undefined;
  return {
    videos: [
      preparedFilePath ? await runpodFileInput(preparedFilePath, name, "video") : await runpodVideoInput(job.inputVideo, name),
    ],
    videoName: name,
  };
}

async function runpodImageInput(value: string, name: string, inlineImageMaxBytes: number): Promise<RunpodComfyImageInput> {
  if (value.startsWith("data:image/")) {
    return runpodInlineImageDataUrlInput(value, name, inlineImageMaxBytes);
  }
  const filePath = localMediaFilePathFromUrl(value);
  if (filePath) {
    return runpodFileInput(filePath, name, "image", inlineImageMaxBytes);
  }
  if (/^https?:\/\//i.test(value)) {
    return { name, url: value };
  }
  throw new Error("RunPod image inputs must be saved media, browser data URLs, or public http(s) URLs.");
}

async function runpodVideoInput(value: string, name: string): Promise<RunpodComfyImageInput> {
  if (value.startsWith("data:video/")) {
    return runpodInlineVideoDataUrlInput(value, name);
  }
  const filePath = localMediaFilePathFromUrl(value);
  if (filePath) {
    return runpodFileInput(filePath, name, "video");
  }
  if (/^https?:\/\//i.test(value)) {
    return { name, url: value };
  }
  throw new Error("RunPod video inputs must be saved media, browser data URLs, or public http(s) URLs.");
}

async function runpodFileInput(
  filePath: string,
  name: string,
  kind: RunpodInputKind,
  inlineImageMaxBytes?: number,
): Promise<RunpodComfyImageInput> {
  const signedUrl = createRunpodInputUrl(filePath, kind);
  if (signedUrl) {
    return { name, url: signedUrl };
  }

  if (kind === "image") {
    return runpodInlineImageFileInput(filePath, name, inlineImageMaxBytes ?? runpodInlineImageByteBudget(1));
  }

  return {
    name,
    image: await readMediaFileAsDataUrl(filePath, kind),
  };
}

async function runpodInlineImageDataUrlInput(value: string, name: string, maxBytes: number): Promise<RunpodComfyImageInput> {
  const parsed = parseImageDataUrl(value);
  if (!parsed) {
    throw new Error("Unsupported image data URL.");
  }

  const prepared = await prepareRunpodInlineImageInput({
    buffer: parsed.buffer,
    mimeType: parsed.mimeType,
    name,
    source: name,
    maxBytes,
  });
  return { name: prepared.name, image: prepared.image };
}

async function runpodInlineImageFileInput(filePath: string, name: string, maxBytes: number): Promise<RunpodComfyImageInput> {
  const buffer = await fs.readFile(filePath);
  const prepared = await prepareRunpodInlineImageInput({
    buffer,
    mimeType: mimeTypeFromMediaPath(filePath, "image"),
    name,
    source: filePath,
    maxBytes,
  });
  return { name: prepared.name, image: prepared.image };
}

function runpodInlineVideoDataUrlInput(value: string, name: string): RunpodComfyImageInput {
  const byteLength = dataUrlBase64ByteLength(value);
  if (byteLength != null) {
    assertRunpodInlineMediaSize(byteLength, "video", name);
  }
  return { name, image: value };
}

export async function materializeComfyInputImages(job: Job, serverUrl: string) {
  const converted: string[] = [];
  for (let index = 0; index < job.inputImages.length; index += 1) {
    const value = job.inputImages[index];
    if (value.startsWith("data:image/")) {
      converted.push(await uploadDataImageToComfy(serverUrl, value, job.id, index));
    } else {
      const filePath = localMediaFilePathFromUrl(value);
      if (filePath) {
        converted.push(await uploadLocalMediaToComfy(serverUrl, filePath, `${job.id}_${index + 1}`, "image"));
      } else {
        converted.push(value);
      }
    }
  }
  return converted;
}

async function uploadLocalMediaToComfy(serverUrl: string, filePath: string, fileBase: string, kind: "image" | "video") {
  const extension = path.extname(filePath) || (kind === "image" ? ".png" : ".mp4");
  const filename = `${safeSegment(fileBase)}${extension}`;
  const file = new Blob([await fs.readFile(filePath)], { type: mimeTypeFromMediaPath(filePath, kind) });
  const uploaded =
    kind === "image" ? await uploadImage(serverUrl, file, filename) : await uploadInputFile(serverUrl, file, filename);
  const uploadedName = uploaded.name || filename;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploadedName}` : uploadedName;
}

async function uploadDataImageToComfy(serverUrl: string, dataUrl: string, jobId: string, index: number) {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported image data URL.");
  }
  const ext = match[1].toLowerCase().replace("jpeg", "jpg");
  const filename = `${jobId}_${index + 1}.${ext}`;
  const file = new Blob([Buffer.from(match[2], "base64")], { type: `image/${match[1].toLowerCase()}` });
  const uploaded = await uploadImage(serverUrl, file, filename);
  const uploadedName = uploaded.name || filename;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploadedName}` : uploadedName;
}

export async function materializeComfyInputVideo(job: Job, serverUrl: string) {
  if (!job.inputVideo) {
    return job.inputVideo;
  }

  if (!job.inputVideo.startsWith("data:video/")) {
    const filePath = localMediaFilePathFromUrl(job.inputVideo);
    if (filePath) {
      return uploadLocalMediaToComfy(serverUrl, filePath, `${job.id}_video`, "video");
    }
    return job.inputVideo;
  }

  const match = job.inputVideo.match(/^data:video\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported video data URL.");
  }

  const ext = videoExtension(match[1]);
  const filename = `${job.id}_video.${ext}`;
  const file = new Blob([Buffer.from(match[2], "base64")], { type: `video/${match[1].toLowerCase()}` });
  const uploaded = await uploadInputFile(serverUrl, file, filename);
  const uploadedName = uploaded.name || filename;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploadedName}` : uploadedName;
}

// Only media that already lives under a known project/upload/Comfy root may be
// read off disk and sent to a provider. Anything else -- an arbitrary ?path= --
// is treated as absent rather than read, so a crafted media URL cannot turn the
// dispatcher into a file-exfiltration primitive.
export function localMediaFilePathFromUrl(value: string) {
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.pathname !== "/api/media") return undefined;
    const filePath = url.searchParams.get("path");
    return filePath && isAllowedLocalMediaPath(filePath) ? path.resolve(filePath) : undefined;
  } catch {
    return undefined;
  }
}

function isAllowedLocalMediaPath(filePath: string) {
  const resolvedPath = path.resolve(filePath).toLowerCase();
  return [brickProjectsRoot, localProjectsRoot, uploadedMediaRoot, path.join(comfyRoot, "output"), path.join(comfyRoot, "input")]
    .map((root) => path.resolve(root).toLowerCase())
    .some((root) => resolvedPath.startsWith(root));
}

async function readMediaFileAsDataUrl(filePath: string, kind: "image" | "video") {
  const stat = await fs.stat(filePath);
  assertRunpodInlineMediaSize(stat.size, kind, filePath);
  const buffer = await fs.readFile(filePath);
  return `data:${mimeTypeFromMediaPath(filePath, kind)};base64,${buffer.toString("base64")}`;
}

function dataUrlBase64ByteLength(value: string) {
  const match = value.match(/^data:[^;]+;base64,([\s\S]+)$/);
  if (!match) return undefined;
  const payload = match[1].replace(/\s/g, "");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function assertRunpodInlineMediaSize(byteLength: number, kind: RunpodInputKind, source: string) {
  if (byteLength <= runpodInlineMediaMaxBytes) return;

  const sourceName = path.basename(source) || `${kind} input`;
  const baseUrlHint = runpodInputBaseUrl
    ? "The input could not be sent as a signed file URL, so the backend refused to inline it."
    : "Set RUNPOD_INPUT_BASE_URL to a public URL for this backend, such as a production URL or tunnel, so RunPod can download the original file bytes.";

  throw new Error(
    `RunPod ${kind} input "${sourceName}" is ${formatBytes(byteLength)}, which is too large to place inside the JSON request without hitting RunPod's 20MiB body limit. ${baseUrlHint} This avoids any image quality loss.`,
  );
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`;
}

function mimeTypeFromMediaPath(filePath: string, kind: "image" | "video") {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4" || extension === ".m4v") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mkv") return "video/x-matroska";
  if (extension === ".avi") return "video/x-msvideo";
  return kind === "image" ? "image/png" : "video/mp4";
}

// Pool workers keep their own output tree per instance port. Creating the folder
// set up-front means a worker that has never seen this project still lands its
// results in the expected layout instead of failing the save.
export async function ensureWorkerProjectFolder(serverUrl: string, projectFolderName: string) {
  const port = new URL(serverUrl).port;
  if (!/^82\d\d$/.test(port)) return;

  const projectRoot = path.join("C:\\Comfy_pool\\instances", `comfy-${port}`, "output", "projects", projectFolderName);
  for (const folder of ["images", "sequences", "videos", "metadata", "logs", "jobs"]) {
    await fs.mkdir(path.join(projectRoot, folder), { recursive: true });
  }
}
