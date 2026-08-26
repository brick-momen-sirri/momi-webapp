import fs from "node:fs/promises";
import path from "node:path";

import { runpodInlineMediaMaxBytes, uploadedMediaRoot } from "./config.js";
import { isAllowedMediaPath, resolveAllowedExistingMediaPath } from "./mediaPathPolicy.js";
import { isPathWithinRoot } from "./pathContainment.js";
import { safeSegment } from "./storageService.js";
import type { CreateJobRequest, Project, User } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo"]);

export async function validateJobMediaReferences(request: CreateJobRequest, project: Project, user: User) {
  for (const value of request.inputImages ?? []) {
    await validateReference(value, "image", project, user);
  }
  // Crop editing keeps the full original and prior layer crops out of inputImages
  // so they are not sent to RunPod. They are still media reads performed for this
  // job and therefore require the exact same project/user ownership validation.
  const edit = request.workflowOptions?.stillImage?.edit;
  if (edit) {
    const editReferences = [
      edit.originalSourceUrl,
      edit.maskSourceUrl,
      ...(edit.referenceSourceUrls ?? []),
      ...edit.baseLayers.flatMap((layer) => [layer.generatedCropUrl, layer.maskSourceUrl]),
    ];
    for (const value of new Set(editReferences)) await validateReference(value, "image", project, user);
  }
  if (request.startFrame) await validateReference(request.startFrame, "image", project, user);
  if (request.endFrame) await validateReference(request.endFrame, "image", project, user);
  if (request.inputVideo) await validateReference(request.inputVideo, "video", project, user);
}

async function validateReference(value: string, kind: "image" | "video", project: Project, user: User) {
  if (value.startsWith("data:")) {
    validateDataUrl(value, kind);
    return;
  }

  let url: URL;
  try {
    url = new URL(value, "http://127.0.0.1");
  } catch {
    throw new Error(`${label(kind)} must be saved media or a public http(s) URL.`);
  }

  if (url.pathname === "/api/media") {
    await validateLocalMediaUrl(url, kind, project, user);
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label(kind)} must be saved media or a public http(s) URL.`);
  }
  assertSupportedExtension(url.pathname, kind, false);
}

async function validateLocalMediaUrl(url: URL, kind: "image" | "video", project: Project, user: User) {
  const rawPath = url.searchParams.get("path") ?? "";
  if (!rawPath || !isAllowedMediaPath(rawPath)) {
    throw new Error(`Invalid local ${kind} media path.`);
  }
  const filePath = await resolveAllowedExistingMediaPath(rawPath);
  if (!filePath) throw new Error(`Invalid local ${kind} media path or missing file.`);

  const uploadRoot = path.join(uploadedMediaRoot, safeSegment(project.id), safeSegment(user.id));
  const realProjectRoot = await fs.realpath(project.folderPath).catch(() => path.resolve(project.folderPath));
  const realUploadRoot = await fs.realpath(uploadRoot).catch(() => path.resolve(uploadRoot));
  if (!isPathWithinRoot(filePath, realProjectRoot) && !isPathWithinRoot(filePath, realUploadRoot)) {
    throw new Error(`${label(kind)} is not owned by this user or project.`);
  }
  assertSupportedExtension(filePath, kind, true);
}

function validateDataUrl(value: string, kind: "image" | "video") {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || match[2].length % 4 === 1) {
    throw new Error(`Malformed ${kind} data URL.`);
  }
  const mimeType = match[1].toLowerCase();
  const allowed = kind === "image" ? IMAGE_MIME_TYPES : VIDEO_MIME_TYPES;
  if (!allowed.has(mimeType)) throw new Error(`Expected ${kind} media, received ${mimeType}.`);

  const byteLength = Buffer.from(match[2], "base64").byteLength;
  if (byteLength > runpodInlineMediaMaxBytes) {
    throw new Error(`${label(kind)} is larger than the ${formatBytes(runpodInlineMediaMaxBytes)} inline submission limit.`);
  }
}

function assertSupportedExtension(value: string, kind: "image" | "video", required: boolean) {
  const extension = path.extname(value).toLowerCase();
  if (!extension && !required) return;
  const allowed = kind === "image" ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
  if (!allowed.has(extension)) throw new Error(`Unsupported ${kind} type: ${extension || "missing extension"}.`);
}

function label(kind: "image" | "video") {
  return kind === "image" ? "Input image" : "Input video";
}

function formatBytes(value: number) {
  return `${Math.ceil(value / (1024 * 1024))}MiB`;
}
