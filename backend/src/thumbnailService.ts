import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  ffmpegPath,
  thumbnailBufferRetryMaxBytes,
  thumbnailCacheDir,
  thumbnailCacheMaxBytes,
  thumbnailMaxConcurrency,
  thumbnailPassthroughMaxBytes,
  thumbnailQuality,
  thumbnailWidths,
  videoPosterSeekSeconds,
  videoPosterTimeoutMs,
} from "./config.js";

const execFileAsync = promisify(execFile);

// Part of every cache key: bump it when the encoder settings below change, so
// existing renditions regenerate instead of being served with stale settings.
const CACHE_VERSION = "v1";

const THUMBNAILABLE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);

export type ThumbnailRendition =
  // The rendition on disk; safe to stream with a long-lived cache header
  // because the key covers the source's mtime and size.
  | { kind: "rendition"; filePath: string; contentType: string; width: number; cacheKey: string }
  // The source is already small enough that a rendition is not worth it. The
  // caller streams the original instead.
  | { kind: "passthrough" };

// Video results get a poster frame rather than a passthrough: a <video> element
// with no poster shows a blank box until the first frame decodes, and the
// originals average ~12 MiB.
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);

export function isThumbnailableSource(filePath: string) {
  return THUMBNAILABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isVideoSource(filePath: string) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// Snap to a whitelisted width so an arbitrary ?w= cannot fan the cache out into
// unbounded variants. Picks the smallest allowed width that still covers the
// request, falling back to the largest.
export function normalizeThumbnailWidth(requested: number | undefined) {
  const target = Number.isFinite(requested) && requested ? Math.floor(requested) : thumbnailWidths[0];
  return thumbnailWidths.find((width) => width >= target) ?? thumbnailWidths[thumbnailWidths.length - 1];
}

// Renditions in flight, keyed by cache key: a burst of grid requests for the
// same image encodes once and everyone awaits that single result. Per-process,
// so the API workers can still race each other — harmless, since the final
// rename is atomic and both would write identical bytes.
const inFlight = new Map<string, Promise<ThumbnailRendition>>();

let active = 0;
const waiting: Array<() => void> = [];

async function withEncodeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= thumbnailMaxConcurrency) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function cacheKeyFor(sourcePath: string, width: number, mtimeMs: number, size: number) {
  // Path is lowercased to match the case-insensitive filesystem this runs on,
  // so two spellings of the same file share one rendition.
  const material = [path.resolve(sourcePath).toLowerCase(), mtimeMs, size, width, thumbnailQuality, CACHE_VERSION].join("|");
  return createHash("sha1").update(material).digest("hex");
}

function cachePathFor(cacheKey: string) {
  // Shard on the first two hex characters: 256 directories keeps any single
  // directory small enough to stat quickly on Windows.
  return path.join(thumbnailCacheDir, cacheKey.slice(0, 2), `${cacheKey}.webp`);
}

/**
 * Returns a downscaled WebP rendition of `sourcePath`, generating and caching it
 * on first request. Callers are responsible for authorizing `sourcePath` before
 * calling — this performs no access control of its own.
 *
 * Throws if the source is missing or cannot be decoded; callers should fall back
 * to streaming the original so the UI never renders a broken image.
 */
export async function getOrCreateThumbnail(sourcePath: string, requestedWidth: number | undefined): Promise<ThumbnailRendition> {
  const resolvedPath = path.resolve(sourcePath);
  const video = isVideoSource(resolvedPath);
  if (!video && !isThumbnailableSource(resolvedPath)) {
    return { kind: "passthrough" };
  }

  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("Thumbnail source is not a file");
  }
  // Only images can be streamed as-is when small; handing a caller the video
  // itself would not serve as a poster no matter how small the file is.
  if (!video && stat.size <= thumbnailPassthroughMaxBytes) {
    return { kind: "passthrough" };
  }

  const width = normalizeThumbnailWidth(requestedWidth);
  const cacheKey = cacheKeyFor(resolvedPath, width, stat.mtimeMs, stat.size);
  const cachePath = cachePathFor(cacheKey);

  const cached = await fs.stat(cachePath).catch(() => undefined);
  if (cached?.isFile() && cached.size > 0) {
    return { kind: "rendition", filePath: cachePath, contentType: "image/webp", width, cacheKey };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const generation = withEncodeSlot(async () => {
    // Re-check under the slot: a request that queued behind a long encode may
    // find the rendition already written by the one it was waiting on.
    const raced = await fs.stat(cachePath).catch(() => undefined);
    if (!(raced?.isFile() && raced.size > 0)) {
      await encodeRendition(resolvedPath, cachePath, width, video);
    }
    return { kind: "rendition", filePath: cachePath, contentType: "image/webp", width, cacheKey } satisfies ThumbnailRendition;
  }).finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, generation);
  return generation;
}

async function encodeRendition(sourcePath: string, cachePath: string, width: number, video: boolean) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  // Write to a unique temp name and rename into place, so a concurrent reader
  // (or another backend process encoding the same key) never sees a half file.
  const tempPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

  const encode = (input: string | Buffer) =>
    sharp(input, { limitInputPixels: false })
      // Honour EXIF orientation, and flatten animated sources to their first
      // frame — a grid cell does not need to animate.
      .rotate()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: thumbnailQuality, effort: 4 })
      .toFile(tempPath);

  // Videos go through ffmpeg for the frame, then the same sharp pipeline as
  // images so a poster and a thumbnail share one set of encoder settings.
  if (video) {
    const framePath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.frame.png`;
    try {
      await extractVideoFrame(sourcePath, framePath);
      await encode(framePath);
      await fs.rename(tempPath, cachePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(framePath, { force: true }).catch(() => undefined);
    }
    return;
  }

  try {
    try {
      await encode(sourcePath);
    } catch (error) {
      // sharp resolves paths through libvips' native API, which on Windows is
      // subject to the 260-character MAX_PATH limit and reports an over-long
      // path as "Input file is missing". Node's fs is long-path aware, so read
      // the bytes ourselves and hand sharp a buffer instead. This also covers
      // UNC sources, where prefixing with \\?\ would be awkward.
      if (!(await canRetryFromBuffer(sourcePath))) throw error;
      await encode(await fs.readFile(sourcePath));
    }
    await fs.rename(tempPath, cachePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Writes a single frame of `sourcePath` to `framePath` as PNG.
 *
 * Tries a small seek offset first because frame 0 of a render is often black or
 * mid fade-in; a clip shorter than the offset produces no frame, so it falls
 * back to frame 0. Throws if neither attempt yields a frame, letting the caller
 * fall back to serving the original.
 */
async function extractVideoFrame(sourcePath: string, framePath: string) {
  const attempts = videoPosterSeekSeconds > 0 ? [videoPosterSeekSeconds, 0] : [0];
  let lastError: unknown;

  for (const seek of attempts) {
    await fs.rm(framePath, { force: true }).catch(() => undefined);
    try {
      await execFileAsync(
        ffmpegPath,
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          // Before -i, so ffmpeg seeks by keyframe instead of decoding forward.
          "-ss",
          String(seek),
          "-i",
          sourcePath,
          "-frames:v",
          "1",
          framePath,
        ],
        { timeout: videoPosterTimeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      lastError = error;
      continue;
    }

    // ffmpeg can exit 0 while writing nothing when the seek lands past the end.
    const stat = await fs.stat(framePath).catch(() => undefined);
    if (stat?.isFile() && stat.size > 0) return;
  }

  throw new Error(
    `Could not extract a poster frame from ${path.basename(sourcePath)}` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

// Guards the buffer retry: only worth attempting for a file that exists and is
// small enough to hold in memory. Without the size cap a pathological source
// could be read into every concurrent encode slot at once.
async function canRetryFromBuffer(sourcePath: string) {
  const stat = await fs.stat(sourcePath).catch(() => undefined);
  return Boolean(stat?.isFile() && stat.size > 0 && stat.size <= thumbnailBufferRetryMaxBytes);
}

/**
 * Enforces the cache's disk budget by deleting the oldest renditions first.
 * Eviction is by mtime (write time) rather than true LRU: read access does not
 * update mtime, and touching every file on read would cost a write per request.
 * Evicting a still-hot rendition is cheap — the next request regenerates it.
 */
export async function pruneThumbnailCache(maxBytes = thumbnailCacheMaxBytes) {
  const entries: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  let shardNames: string[];
  try {
    shardNames = await fs.readdir(thumbnailCacheDir);
  } catch {
    return { totalBytes: 0, deletedFiles: 0, deletedBytes: 0 };
  }

  for (const shard of shardNames) {
    const shardPath = path.join(thumbnailCacheDir, shard);
    const fileNames = await fs.readdir(shardPath).catch(() => []);
    for (const fileName of fileNames) {
      const filePath = path.join(shardPath, fileName);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (stat?.isFile()) {
        entries.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes <= maxBytes) {
    return { totalBytes, deletedFiles: 0, deletedBytes: 0 };
  }

  // Prune down to 90% of the budget so a cache sitting right at the limit does
  // not re-prune on every pass.
  const target = Math.floor(maxBytes * 0.9);
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);

  let remaining = totalBytes;
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const entry of entries) {
    if (remaining <= target) break;
    if (
      await fs
        .rm(entry.filePath, { force: true })
        .then(() => true)
        .catch(() => false)
    ) {
      remaining -= entry.size;
      deletedFiles += 1;
      deletedBytes += entry.size;
    }
  }

  return { totalBytes, deletedFiles, deletedBytes };
}
