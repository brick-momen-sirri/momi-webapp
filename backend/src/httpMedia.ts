// HTTP media plumbing: content types, range requests, streaming, upload name
// and path validation. Extracted from index.ts verbatim.

import express from "express";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { comfyRoot } from "./config.js";
import { isAllowedMediaPath as isAllowedMediaPathByPolicy, resolveAllowedExistingMediaPath } from "./mediaPathPolicy.js";
import { isPathWithinRoot } from "./pathContainment.js";
import { uploadedMediaBaseName } from "./uploadedMediaName.js";
import type { Job } from "./types.js";

export function contentTypeFromUrl(url: URL) {
  const extension = path.extname(url.searchParams.get("filename") || url.searchParams.get("path") || url.pathname).toLowerCase();
  return contentTypeFromExtension(extension);
}

export function sendUpstreamBody(upstream: Response, res: express.Response) {
  if (!upstream.body) {
    res.status(502).json({ error: "Upstream response did not include a readable body." });
    return;
  }

  Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>)
    .on("error", (error) => {
      res.destroy(error);
    })
    .pipe(res);
}

export async function streamLocalFile(
  req: express.Request,
  res: express.Response,
  filePath: string,
  options: { contentType: string; disposition?: string; cacheControl?: string },
) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Media file not found");
  }

  const fileSize = stat.size;
  const range = parseByteRange(req.headers.range, fileSize);
  if (range === "unsatisfiable") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, fileSize - 1);
  const contentLength = fileSize === 0 ? 0 : end - start + 1;

  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", options.contentType);
  res.setHeader("Content-Length", String(contentLength));
  res.setHeader("Cache-Control", options.cacheControl ?? "private, max-age=3600");
  if (options.disposition) {
    res.setHeader("Content-Disposition", options.disposition);
  }

  if (fileSize === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end, highWaterMark: 64 * 1024 });
  const closeStream = () => stream.destroy();
  req.on("aborted", closeStream);
  res.on("close", closeStream);
  stream.on("error", (error) => {
    res.destroy(error);
  });
  stream.pipe(res);
}

export function parseByteRange(
  rangeHeader: string | undefined,
  fileSize: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!rangeHeader) return undefined;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)(?:,.*)?$/);
  if (!match) return undefined;
  if (fileSize <= 0) return "unsatisfiable";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return {
      start: Math.max(fileSize - Math.floor(suffixLength), 0),
      end: fileSize - 1,
    };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return "unsatisfiable";
  }

  return {
    start: Math.floor(start),
    end: Math.min(Math.floor(end), fileSize - 1),
  };
}

export function safeHeaderFileName(value: string) {
  return value.replace(/["\r\n]/g, "_");
}

export function contentTypeFromFilePath(filePath: string) {
  return contentTypeFromExtension(path.extname(filePath).toLowerCase());
}

export function contentTypeFromExtension(extension: string) {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".m4v") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mkv") return "video/x-matroska";
  if (extension === ".avi") return "video/x-msvideo";
  return "application/octet-stream";
}

export function requestAbortSignal(req: express.Request) {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  return controller.signal;
}

export function isAllowedUploadContentType(kind: "image" | "video", contentType: string) {
  const lower = contentType.toLowerCase();
  if (kind === "image") {
    return lower.startsWith("image/") || lower === "application/octet-stream";
  }
  return lower.startsWith("video/") || lower === "application/octet-stream" || lower.includes("quicktime");
}

export function uploadedMediaFileName(rawName: string, kind: "image" | "video", contentType: string) {
  const parsed = path.parse(rawName || `${kind}-upload`);
  const baseName = uploadedMediaBaseName(parsed.name, `${kind}-upload`);
  const extension =
    cleanMediaExtension(parsed.ext) || extensionFromContentType(contentType) || (kind === "image" ? ".png" : ".mp4");
  return `${baseName}${extension}`;
}

export function cleanMediaExtension(extension: string) {
  const cleaned = extension.toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (!cleaned || cleaned === ".") return "";
  return cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
}

export function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

export function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib >= 1 ? mib.toFixed(1) : (value / 1024).toFixed(1)} ${mib >= 1 ? "MiB" : "KiB"}`;
}

export function downloadFileName(
  job: Job,
  url: URL,
  contentType: string,
  options: { index?: number; extension?: string } = {},
) {
  const urlFileName = url.searchParams.get("filename") || path.basename(url.searchParams.get("path") || url.pathname);
  // An explicit extension wins: a converted download is no longer the source's
  // format, so its name must not claim to be.
  const extension = options.extension || path.extname(urlFileName) || extensionFromContentType(contentType);
  const baseName = `${job.modelName || "result"}-${job.id}`.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  // Only disambiguate when there is something to disambiguate between. This
  // mirrors the naming the browser used to apply before downloads moved here.
  const suffix = options.index != null && (job.resultUrls?.length ?? 0) > 1 ? `_image-${options.index + 1}` : "";
  return `${baseName}${suffix}${extension}`;
}

export function mediaFilePathFromUrl(url: URL) {
  if (url.pathname === "/api/media") {
    const filePath = url.searchParams.get("path");
    return filePath && isAllowedMediaPath(filePath) ? path.resolve(filePath) : undefined;
  }

  if (url.pathname.endsWith("/view")) {
    const filename = url.searchParams.get("filename");
    const subfolder = url.searchParams.get("subfolder") ?? "";
    const type = url.searchParams.get("type") || "output";
    if (!filename) return undefined;
    const port = url.port;
    const filePath = /^82\d\d$/.test(port)
      ? path.join("C:\\Comfy_pool\\instances", `comfy-${port}`, type, subfolder, filename)
      : path.join(comfyRoot, type, subfolder, filename);
    return isAllowedMediaPath(filePath, { allowTemp: true }) ? path.resolve(filePath) : undefined;
  }

  return undefined;
}

/**
 * Is `candidate` the directory `root` itself, or something inside it?
 *
 * The point of this over a bare startsWith is the separator boundary. Comparing
 * resolved strings alone means "<root>-evil" and "<root>.json" count as inside
 * the root, because they share its prefix. That was a real hole rather than a
 * theoretical one: localProjectsRoot is `backend/data/projects`, so
 * `backend/data/projects.json` -- the project store -- passed the media
 * allowlist, and no project folder matched it either, so no per-project
 * permission check applied on top.
 *
 * Case-insensitive because the Windows filesystem this runs on is.
 */
export const isWithinRoot = isPathWithinRoot;

export function isAllowedMediaPath(filePath: string, options: { allowTemp?: boolean } = {}) {
  return isAllowedMediaPathByPolicy(filePath, options);
}

export { resolveAllowedExistingMediaPath };

export function extensionFromContentType(contentType: string) {
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/gif")) return ".gif";
  if (contentType.includes("video/mp4")) return ".mp4";
  if (contentType.includes("video/quicktime")) return ".mov";
  if (contentType.includes("video/webm")) return ".webm";
  if (contentType.includes("video/x-matroska")) return ".mkv";
  if (contentType.includes("video/x-msvideo")) return ".avi";
  return ".bin";
}
