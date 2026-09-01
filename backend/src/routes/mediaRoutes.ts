// Media upload and the binary read routes. The reads are the only paths that
// accept a media access token in place of a session (see mediaAccessToken.ts).

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getRequestUser } from "../authMiddleware.js";
import { PORT, mediaUploadMaxBytes, uploadedMediaRoot } from "../config.js";
import {
  cleanMediaExtension,
  contentTypeFromFilePath,
  contentTypeFromUrl,
  downloadFileName,
  formatBytes,
  isAllowedMediaPath,
  isAllowedUploadContentType,
  mediaFilePathFromUrl,
  mediaUrl,
  requestAbortSignal,
  resolveAllowedExistingMediaPath,
  safeHeaderFileName,
  sendUpstreamBody,
  streamLocalFile,
  uploadedMediaFileName,
  isWithinRoot,
} from "../httpMedia.js";
import { getQueryValue } from "../httpQuery.js";
import { canAccessJob, canCreateJobInProject, canViewProject, getVisibleJobForResult, isDemoAccount } from "../jobPermissions.js";
import { getOrCreatePlayableVideo } from "../playableVideoService.js";
import { getProject, getProjects } from "../projectService.js";
import { rmWithRetry } from "../fsRetry.js";
import { safeSegment } from "../storageService.js";
import { writeContentAddressedStream, writeStreamAtomically } from "../streamingMediaService.js";
import { getOrCreateThumbnail, streamConvertedImage, type DownloadImageFormat } from "../thumbnailService.js";

export const mediaRouter = express.Router();

function downloadFormat(value: unknown): DownloadImageFormat | undefined {
  const requested = getQueryValue(value).trim().toLowerCase();
  if (requested === "png") return "png";
  if (requested === "jpg" || requested === "jpeg") return "jpg";
  return undefined;
}

function matchesFormat(filePath: string, format: DownloadImageFormat) {
  const extension = path.extname(filePath).toLowerCase();
  return format === "png" ? extension === ".png" : extension === ".jpg" || extension === ".jpeg";
}

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
    // The directory still starts with the project id: authorizeMediaRead below
    // derives the owning project from that first segment. Only the file name is
    // content-addressed, so a re-upload of the same bytes reuses the stored file
    // instead of adding another full copy.
    const directory = path.join(uploadedMediaRoot, safeSegment(project.id), safeSegment(user.id));
    const extension = cleanMediaExtension(path.extname(fileName)) || (kind === "image" ? ".png" : ".mp4");
    const { filePath, bytesWritten, deduplicated } = await writeContentAddressedStream(
      req,
      directory,
      extension,
      mediaUploadMaxBytes,
      requestAbortSignal(req),
    );
    if (bytesWritten <= 0) {
      await rmWithRetry(filePath, { force: true }).catch(() => undefined);
      return res.status(400).json({ error: "Upload body was empty." });
    }

    // `name` keeps the caller's original filename even though the path no longer
    // carries it, so the UI still shows what the user actually uploaded.
    res.status(201).json({
      url: mediaUrl(filePath),
      name: fileName,
      kind,
      bytes: bytesWritten,
      deduplicated,
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
async function authorizeMediaRead(
  req: express.Request,
  rawPath: string,
): Promise<{ ok: true; resolvedPath: string } | { ok: false; status: number; error: string }> {
  if (!isAllowedMediaPath(rawPath)) {
    return { ok: false, status: 403, error: "Media path is outside allowed project roots" };
  }
  const resolvedPath = await resolveAllowedExistingMediaPath(rawPath);
  if (!resolvedPath) {
    return { ok: false, status: 404, error: "Media file not found" };
  }

  const user = getRequestUser(req);
  const canonicalUploadRoot = await fs.realpath(uploadedMediaRoot).catch(() => path.resolve(uploadedMediaRoot));
  if (isWithinRoot(resolvedPath, canonicalUploadRoot)) {
    const [projectId] = path.relative(canonicalUploadRoot, resolvedPath).split(path.sep);
    const uploadProject = getProject(projectId);
    if (!uploadProject || !canViewProject(user, uploadProject)) {
      return { ok: false, status: 404, error: "Media file not found" };
    }
  }

  // Boundary-aware, for the same reason isAllowedMediaPath is: a bare startsWith
  // makes "<folderPath>-other" look like it belongs to this project and applies
  // the wrong project's permissions to it.
  const project = getProjects().find((item) => item.folderPath && isWithinRoot(resolvedPath, item.folderPath));
  if (project && !canViewProject(user, project)) {
    return { ok: false, status: 404, error: "Media file not found" };
  }

  return { ok: true, resolvedPath };
}

mediaRouter.get("/api/media", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  const access = await authorizeMediaRead(req, rawPath);
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
  const access = await authorizeMediaRead(req, rawPath);
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

// A browser-playable rendition of a video result. Sources that already decode
// everywhere stream through untouched; HEVC, 10-bit and 4:4:4 sources are served
// as a cached H.264 copy. Falls back to the original whenever a rendition cannot
// be produced -- that at least works for whoever does have a decoder, which is
// strictly better than a 500.
mediaRouter.get("/api/media/playable", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  const access = await authorizeMediaRead(req, rawPath);
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  await streamPlayableVideo(req, res, access.resolvedPath);
});

/**
 * Streams `resolvedPath` as something a browser can decode.
 *
 * Shared by /api/media/playable and result-media's ?playable=1 so the two cannot
 * drift; both have already authorized the path.
 */
async function streamPlayableVideo(req: express.Request, res: express.Response, resolvedPath: string) {
  try {
    const playable = await getOrCreatePlayableVideo(resolvedPath);
    if (playable.kind === "rendition") {
      res.setHeader("ETag", `"${playable.cacheKey}"`);
      if (req.headers["if-none-match"] === `"${playable.cacheKey}"`) {
        return res.status(304).end();
      }
      await streamLocalFile(req, res, playable.filePath, {
        contentType: playable.contentType,
        disposition: `inline; filename="${safeHeaderFileName(`${path.parse(resolvedPath).name}.mp4`)}"`,
        // The cache key covers the source's mtime and size, so a re-rendered
        // result yields a different ETag and a new rendition.
        cacheControl: "private, max-age=604800, immutable",
      });
      return;
    }

    await streamLocalFile(req, res, resolvedPath, {
      contentType: contentTypeFromFilePath(resolvedPath),
      disposition: `inline; filename="${safeHeaderFileName(path.basename(resolvedPath))}"`,
    });
  } catch (error) {
    // Headers are already on the wire once streaming starts; there is nothing
    // useful left to say, and appending JSON would corrupt the video.
    if (res.headersSent) return res.destroy();
    try {
      await fs.access(resolvedPath);
      console.warn(
        `Could not build a playable rendition for ${path.basename(resolvedPath)}, serving original:`,
        error instanceof Error ? error.message : String(error),
      );
      await streamLocalFile(req, res, resolvedPath, {
        contentType: contentTypeFromFilePath(resolvedPath),
        disposition: `inline; filename="${safeHeaderFileName(path.basename(resolvedPath))}"`,
      });
    } catch {
      res.status(404).json({ error: "Media file not found" });
    }
  }
}

mediaRouter.get("/api/jobs/:jobId/result-file", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });

    const rawIndex = Number(req.query.index ?? 0);
    const index = Math.max(0, Number.isFinite(rawIndex) ? Math.floor(rawIndex) : 0);
    const resultUrl = job.resultUrls[index] ?? job.thumbnailUrls[0];
    if (!resultUrl) return res.status(404).json({ error: "Result file not found" });

    const requestedFormat = downloadFormat(req.query.format);

    const absoluteUrl = new URL(resultUrl, `http://127.0.0.1:${PORT}`);
    const localPath = mediaFilePathFromUrl(absoluteUrl);
    if (localPath) {
      try {
        const safeLocalPath = await resolveAllowedExistingMediaPath(localPath);
        if (!safeLocalPath) throw new Error("Result file not found");
        await fs.access(safeLocalPath);
        const contentType = contentTypeFromFilePath(safeLocalPath);

        // Only re-encode when the request actually asks for a different format.
        // Matching formats stream the generator's bytes through untouched, which
        // is the whole point of the download button.
        if (requestedFormat && !matchesFormat(safeLocalPath, requestedFormat)) {
          const extension = requestedFormat === "jpg" ? ".jpg" : ".png";
          res.setHeader("Content-Type", requestedFormat === "jpg" ? "image/jpeg" : "image/png");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType, { index, extension }))}"`,
          );
          await streamConvertedImage(safeLocalPath, requestedFormat, res);
          return;
        }

        await streamLocalFile(req, res, safeLocalPath, {
          contentType,
          disposition: `attachment; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType, { index }))}"`,
        });
        return;
      } catch (error) {
        // Nothing useful can be said once the body has started; closing the
        // connection lets the client see a truncated download rather than a
        // download with an error page appended to it.
        if (res.headersSent) return res.destroy();
        // A conversion that failed before writing anything has already set the
        // attachment headers. Left in place, the browser would save the JSON
        // error below as if it were the image the user asked for.
        res.removeHeader("Content-Disposition");
        console.warn(`Could not serve result file for ${job.id}:`, error instanceof Error ? error.message : String(error));
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
        const safeLocalPath = await resolveAllowedExistingMediaPath(localPath);
        if (!safeLocalPath) throw new Error("Result file not found");
        await fs.access(safeLocalPath);
        // ?w= asks for a downscaled rendition for grid/feed display. Ignored for
        // remote-only results below, which have no local file to re-encode.
        const requestedWidth = Number(req.query.w);
        if (Number.isFinite(requestedWidth) && requestedWidth > 0) {
          const rendition = await getOrCreateThumbnail(safeLocalPath, requestedWidth).catch(() => undefined);
          if (rendition?.kind === "rendition") {
            res.setHeader("ETag", `"${rendition.cacheKey}"`);
            if (req.headers["if-none-match"] === `"${rendition.cacheKey}"`) {
              return res.status(304).end();
            }
            await streamLocalFile(req, res, rendition.filePath, {
              contentType: rendition.contentType,
              disposition: `inline; filename="${safeHeaderFileName(`${path.parse(safeLocalPath).name}.webp`)}"`,
              cacheControl: "private, max-age=604800, immutable",
            });
            return;
          }
        }

        // ?playable=1 asks for something the browser can actually decode. Only
        // the player sets it; the download route deliberately does not, so what
        // gets saved stays the master the generator produced.
        if (getQueryValue(req.query.playable) === "1") {
          await streamPlayableVideo(req, res, safeLocalPath);
          return;
        }

        const contentType = contentTypeFromFilePath(safeLocalPath);
        await streamLocalFile(req, res, safeLocalPath, {
          contentType,
          disposition: `inline; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType))}"`,
        });
        return;
      } catch {
        if (res.headersSent) return res.destroy();
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
