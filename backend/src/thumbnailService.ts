import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  ffmpegPath,
  resultPreviewWidths,
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

export type DownloadImageFormat = "png" | "jpg";

/**
 * Streams `sourcePath` re-encoded to `format` into `destination`.
 *
 * Format conversion for downloads used to happen in the browser, on a canvas.
 * That cannot work for the sizes this app produces: a canvas holds the entire
 * decoded bitmap, which is over 400 MB for a 10K still, on top of the blob it was
 * decoded from. libvips streams the same pipeline instead, so peak memory is a
 * few working tiles rather than the whole image.
 *
 * Callers must only reach this when the requested format actually differs from
 * the source; an untouched original should be streamed byte for byte.
 */
export async function streamConvertedImage(
  sourcePath: string,
  format: DownloadImageFormat,
  destination: NodeJS.WritableStream,
) {
  return withEncodeSlot(
    () =>
      new Promise<void>((resolve, reject) => {
        const decoded = sharp(sourcePath, { limitInputPixels: false }).rotate();
        const encoder =
          format === "jpg"
            ? // JPEG has no alpha, so transparency has to become something.
              // White matches what the download dialog promises.
              decoded.flatten({ background: "#ffffff" }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
            : decoded.png();

        encoder.on("error", reject);
        destination.on("error", reject);
        // "close" as well as "finish": a client that aborts mid-download fires
        // only the former, and without it the encode slot would never be
        // released. Resolving twice is a no-op.
        destination.on("close", () => resolve());
        encoder.pipe(destination).on("finish", () => resolve());
      }),
  );
}

/**
 * Generates the standard preview renditions for a freshly saved source, so the
 * first person to open the project does not pay to decode the original.
 *
 * Decodes the source ONCE -- straight down to the largest width asked for -- and
 * encodes every width from that one raw buffer. The obvious alternative, calling
 * getOrCreateThumbnail per width, decodes the original once per width, and for a
 * 10K PNG that decode is by far the most expensive thing this service does.
 *
 * Best effort by design, and never throws: returns the widths it actually wrote.
 * A source that cannot be decoded leaves the cache cold and the read path falls
 * back to serving the original, so a warm failure must never fail the job that
 * produced the image.
 */
export async function warmThumbnails(sourcePath: string, requestedWidths: number[] = resultPreviewWidths) {
  const resolvedPath = path.resolve(sourcePath);
  // Videos need ffmpeg to produce a frame first; that path stays on demand.
  if (isVideoSource(resolvedPath) || !isThumbnailableSource(resolvedPath)) return [];

  const stat = await fs.stat(resolvedPath).catch(() => undefined);
  // Small sources are served as-is by getOrCreateThumbnail, so a rendition for
  // them would be written and never read.
  if (!stat?.isFile() || stat.size <= thumbnailPassthroughMaxBytes) return [];

  // Snap and dedupe so this writes the exact cache keys the read path looks up,
  // largest first because the largest drives the single decode below.
  const widths = [...new Set(requestedWidths.map((width) => normalizeThumbnailWidth(width)))].sort(
    (left, right) => right - left,
  );

  const missing: Array<{ width: number; cachePath: string }> = [];
  for (const width of widths) {
    const cachePath = cachePathFor(cacheKeyFor(resolvedPath, width, stat.mtimeMs, stat.size));
    const cached = await fs.stat(cachePath).catch(() => undefined);
    if (!(cached?.isFile() && cached.size > 0)) {
      missing.push({ width, cachePath });
    }
  }
  if (!missing.length) return [];

  return withEncodeSlot(async () => {
    let decoded: Awaited<ReturnType<typeof decodeToRaw>>;
    try {
      decoded = await decodeToRaw(resolvedPath, missing[0].width);
    } catch (error) {
      // Never throws, so a caller cannot accidentally let a preview problem take
      // down the render that produced the image. Logged rather than swallowed
      // silently, because the read path will now decode the original on every
      // first view -- slow, but correct.
      console.warn(
        `Could not pre-build previews for ${path.basename(resolvedPath)}:`,
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
    const { data, info } = decoded;
    // channels comes from the decode rather than being forced, so a source
    // without an alpha channel does not gain a wasted one, and one with alpha
    // keeps it -- these results can be transparent.
    const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };

    const written: number[] = [];
    for (const { width, cachePath } of missing) {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const tempPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await sharp(data, raw)
          .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
          .webp({ quality: thumbnailQuality, effort: 4 })
          .toFile(tempPath);
        await fs.rename(tempPath, cachePath);
        written.push(width);
      } catch {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    return written;
  });
}

/**
 * Decodes `sourcePath` down to `width` and hands back raw pixels, with the same
 * long-path fallback encodeRendition needs (see the comment there).
 */
async function decodeToRaw(sourcePath: string, width: number) {
  const decode = (input: string | Buffer) =>
    sharp(input, { limitInputPixels: false })
      .rotate()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

  try {
    return await decode(sourcePath);
  } catch (error) {
    if (!(await canRetryFromBuffer(sourcePath))) throw error;
    return await decode(await fs.readFile(sourcePath));
  }
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
