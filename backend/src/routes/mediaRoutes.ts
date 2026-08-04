// Media upload and the binary read routes. The reads are the only paths that
// accept a media access token in place of a session (see mediaAccessToken.ts).

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getRequestUser } from "../authMiddleware.js";
import { PORT, mediaUploadMaxBytes, uploadedMediaRoot } from "../config.js";
import {
  contentTypeFromFilePath,
  contentTypeFromUrl,
  downloadFileName,
  formatBytes,
  isAllowedMediaPath,
  isAllowedUploadContentType,
  mediaFilePathFromUrl,
  mediaUrl,
  requestAbortSignal,
  safeHeaderFileName,
  sendUpstreamBody,
  streamLocalFile,
  uploadedMediaFileName,
  isWithinRoot,
} from "../httpMedia.js";
import { getQueryValue } from "../httpQuery.js";
import { canAccessJob, canCreateJobInProject, canViewProject, getVisibleJobForResult, isDemoAccount } from "../jobPermissions.js";
import { getProject, getProjects } from "../projectService.js";
import { safeSegment } from "../storageService.js";
import { writeStreamAtomically } from "../streamingMediaService.js";
import { getOrCreateThumbnail } from "../thumbnailService.js";

export const mediaRouter = express.Router();

mediaRouter.post("/api/media/upload", async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (isDemoAccount(user)) {
      return res.status(403).json({ error: "Demo accounts are view-only and cannot upload media." });
    }

    const projectId = getQueryValue(req.query.projectId);
    const project = getProject(projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canCreateJobInProject(user, project)) return res.status(403).json({ error: "Project editor access required." });

    const kind = getQueryValue(req.query.kind) === "video" ? "video" : "image";
    const contentType = String(req.headers["content-type"] ?? "");
    if (!isAllowedUploadContentType(kind, contentType)) {
      return res.status(415).json({ error: `Expected an ${kind} upload body.` });
    }

    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > mediaUploadMaxBytes) {
      return res.status(413).json({ error: `Upload is larger than the ${formatBytes(mediaUploadMaxBytes)} limit.` });
    }

    const fileName = uploadedMediaFileName(getQueryValue(req.query.name), kind, contentType);
    const uploadId = `${Date.now()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const filePath = path.join(uploadedMediaRoot, safeSegment(project.id), safeSegment(user.id), `${uploadId}-${fileName}`);
    const { bytesWritten } = await writeStreamAtomically(req, filePath, mediaUploadMaxBytes, requestAbortSignal(req));
    if (bytesWritten <= 0) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      return res.status(400).json({ error: "Upload body was empty." });
    }

    res.status(201).json({
      url: mediaUrl(filePath),
      name: fileName,
      kind,
      bytes: bytesWritten,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not upload media.";
    const status = message.includes("maximum allowed size") || message.includes("larger than") ? 413 : 400;
    res.status(status).json({ error: message });
  }
});

// Shared gate for the media read routes: confirms the path is inside an allowed
// project root and that the caller may view the owning project. Both /api/media
// and its thumbnail variant go through this, so the two can never drift apart
// into an access-control gap.
function authorizeMediaRead(
  req: express.Request,
  rawPath: string,
): { ok: true; resolvedPath: string } | { ok: false; status: number; error: string } {
  const resolvedPath = path.resolve(rawPath);
  if (!isAllowedMediaPath(resolvedPath)) {
    return { ok: false, status: 403, error: "Media path is outside allowed project roots" };
  }

  // Boundary-aware, for the same reason isAllowedMediaPath is: a bare startsWith
  // makes "<folderPath>-other" look like it belongs to this project and applies
  // the wrong project's permissions to it.
  const project = getProjects().find((item) => item.folderPath && isWithinRoot(resolvedPath, item.folderPath));
  if (project && !canViewProject(getRequestUser(req), project)) {
    return { ok: false, status: 404, error: "Media file not found" };
  }

  return { ok: true, resolvedPath };
}

mediaRouter.get("/api/media", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  const access = authorizeMediaRead(req, rawPath);
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  try {
    await fs.access(access.resolvedPath);
    await streamLocalFile(req, res, access.resolvedPath, {
      contentType: contentTypeFromFilePath(access.resolvedPath),
      disposition: `inline; filename="${safeHeaderFileName(path.basename(access.resolvedPath))}"`,
    });
  } catch {
    res.status(404).json({ error: "Media file not found" });
  }
});

// Downscaled WebP rendition of an image result, for grid and feed views. Falls
// back to streaming the original whenever a rendition cannot be produced, so a
// decode failure degrades to "slow" rather than "broken image".
mediaRouter.get("/api/media/thumbnail", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  const access = authorizeMediaRead(req, rawPath);
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  const requestedWidth = Number(req.query.w);
  try {
    const rendition = await getOrCreateThumbnail(
      access.resolvedPath,
      Number.isFinite(requestedWidth) ? requestedWidth : undefined,
    );
    if (rendition.kind === "rendition") {
      res.setHeader("ETag", `"${rendition.cacheKey}"`);
      if (req.headers["if-none-match"] === `"${rendition.cacheKey}"`) {
        return res.status(304).end();
      }
      await streamLocalFile(req, res, rendition.filePath, {
        contentType: rendition.contentType,
        disposition: `inline; filename="${safeHeaderFileName(`${path.parse(access.resolvedPath).name}.webp`)}"`,
        // The cache key covers the source's mtime and size, so a regenerated
        // result yields a different URL-independent ETag and a new rendition.
        cacheControl: "private, max-age=604800, immutable",
      });
      return;
    }

    // Passthrough: source is already small, or not an image we can re-encode.
    await streamLocalFile(req, res, access.resolvedPath, {
      contentType: contentTypeFromFilePath(access.resolvedPath),
      disposition: `inline; filename="${safeHeaderFileName(path.basename(access.resolvedPath))}"`,
    });
  } catch (error) {
    // Never fail the request on a thumbnailing problem: serve the original.
    try {
      await fs.access(access.resolvedPath);
      console.warn(
        `Could not build thumbnail for ${path.basename(access.resolvedPath)}, serving original:`,
        error instanceof Error ? error.message : String(error),
      );
      await streamLocalFile(req, res, access.resolvedPath, {
        contentType: contentTypeFromFilePath(access.resolvedPath),
        disposition: `inline; filename="${safeHeaderFileName(path.basename(access.resolvedPath))}"`,
      });
    } catch {
      res.status(404).json({ error: "Media file not found" });
    }
  }
});

mediaRouter.get("/api/jobs/:jobId/result-file", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });

    const index = Number(req.query.index ?? 0);
    const resultUrl = job.resultUrls[Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0)] ?? job.thumbnailUrls[0];
    if (!resultUrl) return res.status(404).json({ error: "Result file not found" });

    const absoluteUrl = new URL(resultUrl, `http://127.0.0.1:${PORT}`);
    const localPath = mediaFilePathFromUrl(absoluteUrl);
    if (localPath) {
      try {
        await fs.access(localPath);
        const contentType = contentTypeFromFilePath(localPath);
        await streamLocalFile(req, res, localPath, {
          contentType,
          disposition: `attachment; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType))}"`,
        });
        return;
      } catch {
        return res.status(404).json({ error: "Result file not found" });
      }
    }

    const upstream = await fetch(absoluteUrl, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Could not read result file" });
    }

    const contentType = upstream.headers.get("content-type") ?? contentTypeFromUrl(absoluteUrl);
    const contentLength = upstream.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName(job, absoluteUrl, contentType)}"`);
    sendUpstreamBody(upstream, res);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not download result file" });
  }
});

mediaRouter.get("/api/jobs/:jobId/result-media", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });

    const index = Number(req.query.index ?? 0);
    const resultUrl = job.resultUrls[Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0)] ?? job.thumbnailUrls[0];
    if (!resultUrl) return res.status(404).json({ error: "Result file not found" });

    const absoluteUrl = new URL(resultUrl, `http://127.0.0.1:${PORT}`);
    const localPath = mediaFilePathFromUrl(absoluteUrl);
    if (localPath) {
      try {
        await fs.access(localPath);
        // ?w= asks for a downscaled rendition for grid/feed display. Ignored for
        // remote-only results below, which have no local file to re-encode.
        const requestedWidth = Number(req.query.w);
        if (Number.isFinite(requestedWidth) && requestedWidth > 0) {
          const rendition = await getOrCreateThumbnail(localPath, requestedWidth).catch(() => undefined);
          if (rendition?.kind === "rendition") {
            res.setHeader("ETag", `"${rendition.cacheKey}"`);
            if (req.headers["if-none-match"] === `"${rendition.cacheKey}"`) {
              return res.status(304).end();
            }
            await streamLocalFile(req, res, rendition.filePath, {
              contentType: rendition.contentType,
              disposition: `inline; filename="${safeHeaderFileName(`${path.parse(localPath).name}.webp`)}"`,
              cacheControl: "private, max-age=604800, immutable",
            });
            return;
          }
        }

        const contentType = contentTypeFromFilePath(localPath);
        await streamLocalFile(req, res, localPath, {
          contentType,
          disposition: `inline; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType))}"`,
        });
        return;
      } catch {
        return res.status(404).json({ error: "Result file not found" });
      }
    }

    const headers = new Headers();
    const range = req.headers.range;
    if (range) {
      headers.set("Range", range);
    }

    const upstream = await fetch(absoluteUrl, { headers, signal: AbortSignal.timeout(120000) });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: "Could not read result media" });
    }

    const contentType = upstream.headers.get("content-type") ?? contentTypeFromUrl(absoluteUrl);
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    for (const header of ["accept-ranges", "content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) {
        res.setHeader(header, value);
      }
    }
    res.setHeader("Content-Disposition", `inline; filename="${downloadFileName(job, absoluteUrl, contentType)}"`);
    sendUpstreamBody(upstream, res);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read result media" });
  }
});
