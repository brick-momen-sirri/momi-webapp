/**
 * H.264 renditions of video results a browser cannot decode.
 *
 * The generators do not agree on an output codec. Most return H.264 8-bit, which
 * plays everywhere; ByteDance's 4K tier returns HEVC Main 10 tagged `hev1`, which
 * plays almost nowhere -- Chrome and Firefox have no HEVC path on a typical
 * Windows box, Safari and QuickTime reject the `hev1` tag even when they support
 * the codec, and a GPU without a Main10 decoder fails on the 10 bits alone. The
 * result was a finished render that a handful of people could watch and everyone
 * else saw as a dead player.
 *
 * So the file the provider sent is left alone -- it is the deliverable, and the
 * download path streams its bytes untouched -- and the player is pointed here
 * instead. Sources that are already playable report `passthrough` and cost one
 * ffprobe; the rest are transcoded once and cached.
 *
 * Structured to match thumbnailService deliberately: same cache key material
 * (path + mtime + size, so a re-render invalidates itself), same sharded cache
 * layout, same in-flight coalescing, same "never throw at the caller, let the
 * read path fall back to the original" contract.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ffmpegPath,
  ffprobePath,
  playableVideoCacheDir,
  playableVideoCacheMaxBytes,
  playableVideoCrf,
  playableVideoMaxConcurrency,
  playableVideoMaxHeight,
  playableVideoPreset,
  playableVideoProbeTimeoutMs,
  playableVideoTimeoutMs,
} from "./config.js";

const execFileAsync = promisify(execFile);

// Part of every cache key: bump it when the encoder settings below change, so
// existing renditions regenerate instead of being served with stale settings.
const CACHE_VERSION = "v1";

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);

/**
 * Pixel formats a browser's H.264 decoder actually accepts.
 *
 * The bit depth and the chroma layout matter as much as the codec name does:
 * High 10 (`yuv420p10le`) and High 4:4:4 (`yuv444p`) are both legal H.264 that no
 * mainstream browser will decode. A source is only waved through when it is one
 * of these.
 */
const BROWSER_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p", "nv12"]);

/**
 * Codecs that need no rendition.
 *
 * H.264 is the universal floor. VP8, VP9 and AV1 are included because they are
 * broadly supported and nothing would be gained by re-encoding one into H.264 --
 * but they are still subject to the pixel-format check above, so a 10-bit AV1
 * would be rebuilt like anything else.
 */
const BROWSER_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

export type VideoProbe = {
  codecName: string;
  codecTag: string;
  pixelFormat: string;
  profile: string;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type PlayableVideo =
  // A rendition on disk, safe to serve with a long-lived cache header because
  // the key covers the source's mtime and size.
  | { kind: "rendition"; filePath: string; contentType: string; cacheKey: string }
  // The source plays in a browser as it is; the caller streams the original.
  | { kind: "passthrough" };

export function isPlayableVideoSource(filePath: string) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Would a browser decode this stream as-is?
 *
 * Deliberately a whitelist. An unrecognised codec, an unrecognised pixel format,
 * or a probe that came back without either is treated as "needs a rendition":
 * spending one transcode on a file that did not need it costs disk, while
 * guessing the other way costs someone a video they cannot watch.
 */
export function isBrowserPlayable(probe: VideoProbe) {
  if (!BROWSER_CODECS.has(probe.codecName)) return false;
  if (!BROWSER_PIXEL_FORMATS.has(probe.pixelFormat)) return false;
  // Apple's players reject HEVC tagged `hev1` rather than `hvc1`. No HEVC reaches
  // here (it fails the codec check above), but the same rule applies to any codec
  // whose tag disagrees with its sample entry, so keep the check honest for H.264:
  // `avc1` is the only tag browsers accept, and `avc3` in-band parameter sets are
  // not universally handled.
  if (probe.codecName === "h264" && probe.codecTag && probe.codecTag !== "avc1") return false;
  return true;
}

export async function probeVideo(filePath: string): Promise<VideoProbe | undefined> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,codec_tag_string,pix_fmt,profile,width,height",
        "-of",
        "json",
        filePath,
      ],
      { timeout: playableVideoProbeTimeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        codec_tag_string?: string;
        pix_fmt?: string;
        profile?: string;
        width?: number;
        height?: number;
      }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    if (!video) return undefined;

    return {
      codecName: (video.codec_name ?? "").toLowerCase(),
      codecTag: (video.codec_tag_string ?? "").toLowerCase(),
      pixelFormat: (video.pix_fmt ?? "").toLowerCase(),
      profile: video.profile ?? "",
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    };
  } catch {
    return undefined;
  }
}

// Renditions in flight, keyed by cache key: a burst of requests for the same
// video transcodes once and everyone awaits that single result. Per-process, so
// the API workers can still race each other -- harmless, since the final rename
// is atomic and both would write equivalent files.
const inFlight = new Map<string, Promise<PlayableVideo>>();

/**
 * Cache keys already known to need no rendition.
 *
 * This is not an optimisation for the warm path -- it is what keeps playback
 * cheap. A `<video>` element issues a stream of range requests for a single clip,
 * and without this every one of them would re-probe the file with ffprobe just to
 * be told again that H.264 is fine. Keys cover mtime and size, so an entry cannot
 * outlive the file it describes; the cap only bounds memory on a long-lived
 * process.
 */
const knownPlayable = new Set<string>();
const KNOWN_PLAYABLE_MAX_ENTRIES = 4096;

function rememberPlayable(cacheKey: string) {
  if (knownPlayable.size >= KNOWN_PLAYABLE_MAX_ENTRIES) {
    // Insertion-ordered, so this drops the oldest entry.
    knownPlayable.delete(knownPlayable.values().next().value as string);
  }
  knownPlayable.add(cacheKey);
}

let active = 0;
const waiting: Array<() => void> = [];

async function withEncodeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= playableVideoMaxConcurrency) {
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

function cacheKeyFor(sourcePath: string, mtimeMs: number, size: number) {
  // Path is lowercased to match the case-insensitive filesystem this runs on,
  // so two spellings of the same file share one rendition.
  const material = [
    path.resolve(sourcePath).toLowerCase(),
    mtimeMs,
    size,
    playableVideoMaxHeight,
    playableVideoCrf,
    playableVideoPreset,
    CACHE_VERSION,
  ].join("|");
  return createHash("sha1").update(material).digest("hex");
}

function cachePathFor(cacheKey: string) {
  // Shard on the first two hex characters: 256 directories keeps any single
  // directory small enough to stat quickly on Windows.
  return path.join(playableVideoCacheDir, cacheKey.slice(0, 2), `${cacheKey}.mp4`);
}

/**
 * Returns a browser-playable version of `sourcePath`, transcoding and caching it
 * on first request. Callers are responsible for authorizing `sourcePath` before
 * calling -- this performs no access control of its own.
 *
 * Throws if the source is missing or cannot be transcoded; callers should fall
 * back to streaming the original, which at least works for whoever does have a
 * decoder for it.
 */
export async function getOrCreatePlayableVideo(sourcePath: string): Promise<PlayableVideo> {
  const resolvedPath = path.resolve(sourcePath);
  if (!isPlayableVideoSource(resolvedPath)) return { kind: "passthrough" };

  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("Playable video source is not a file");
  }

  const cacheKey = cacheKeyFor(resolvedPath, stat.mtimeMs, stat.size);
  if (knownPlayable.has(cacheKey)) return { kind: "passthrough" };

  const cachePath = cachePathFor(cacheKey);

  const cached = await fs.stat(cachePath).catch(() => undefined);
  if (cached?.isFile() && cached.size > 0) {
    return { kind: "rendition", filePath: cachePath, contentType: "video/mp4", cacheKey };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const generation = (async () => {
    // Probe before taking an encode slot: the overwhelming majority of results
    // are already H.264, and those must not queue behind a 4K transcode just to
    // find out they had nothing to do.
    const probe = await probeVideo(resolvedPath);
    if (!probe) {
      throw new Error(`Could not probe ${path.basename(resolvedPath)} for playback compatibility`);
    }
    if (isBrowserPlayable(probe)) {
      rememberPlayable(cacheKey);
      return { kind: "passthrough" } satisfies PlayableVideo;
    }

    return withEncodeSlot(async () => {
      // Re-check under the slot: a request that queued behind a long transcode
      // may find the rendition already written by the one it was waiting on.
      const raced = await fs.stat(cachePath).catch(() => undefined);
      if (!(raced?.isFile() && raced.size > 0)) {
        await encodePlayableVideo(resolvedPath, cachePath, probe);
      }
      return { kind: "rendition", filePath: cachePath, contentType: "video/mp4", cacheKey } satisfies PlayableVideo;
    });
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, generation);
  return generation;
}

/**
 * Builds the rendition for a freshly saved result, so the first person to open it
 * is not waiting on a 4K transcode.
 *
 * Best effort by design, and never throws: returns whether a rendition now
 * exists. A source that cannot be transcoded leaves the cache cold, the read path
 * falls back to serving the original, and the render that produced it still
 * counts as a success -- a playback rendition must never fail a finished job.
 */
export async function warmPlayableVideo(sourcePath: string) {
  try {
    const result = await getOrCreatePlayableVideo(sourcePath);
    return result.kind === "rendition";
  } catch (error) {
    console.warn(
      `Could not build a playable rendition for ${path.basename(sourcePath)}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function encodePlayableVideo(sourcePath: string, cachePath: string, probe: VideoProbe) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  // Write to a unique temp name and rename into place, so a concurrent reader
  // (or another backend process encoding the same key) never sees a half file.
  const tempPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;

  // Only scale when the source is actually taller than the cap. `-2` keeps the
  // width even and on the source's aspect ratio, which H.264 requires.
  const scaleFilter = probe.height > playableVideoMaxHeight ? ["-vf", `scale=-2:${playableVideoMaxHeight}`] : [];
  const audioArgs = probe.hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"] : ["-an"];

  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        ...scaleFilter,
        "-c:v",
        "libx264",
        "-preset",
        playableVideoPreset,
        "-crf",
        String(playableVideoCrf),
        // The two settings that make this universally decodable rather than
        // merely H.264: 8-bit 4:2:0 pixels, and a profile/level pair inside what
        // every browser and hardware decoder advertises.
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-level:v",
        "5.1",
        ...audioArgs,
        // Moves the index to the front so the player can start without fetching
        // the tail first -- these are streamed over range requests.
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        tempPath,
      ],
      { timeout: playableVideoTimeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );

    // ffmpeg can exit 0 having written nothing useful; a zero-byte rendition
    // would be cached and served as a broken video forever after.
    const written = await fs.stat(tempPath).catch(() => undefined);
    if (!written?.isFile() || written.size === 0) {
      throw new Error("FFmpeg produced an empty rendition");
    }

    await fs.rm(cachePath, { force: true }).catch(() => undefined);
    await fs.rename(tempPath, cachePath);
    console.info(
      `[playable] Re-encoded ${path.basename(sourcePath)} (${probe.codecName} ${probe.profile} ${probe.pixelFormat}, ` +
        `${probe.width}x${probe.height}) to H.264 8-bit for browser playback.`,
    );
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : "unknown FFmpeg error";
    throw new Error(`Could not re-encode ${path.basename(sourcePath)} for browser playback: ${message}`);
  }
}

/**
 * Enforces the cache's disk budget by deleting the oldest renditions first.
 * Eviction is by mtime rather than true LRU, for the same reason the thumbnail
 * cache does it: reads do not update mtime, and touching every file on read would
 * cost a write per request. Evicting a hot rendition is survivable -- the next
 * request rebuilds it.
 */
export async function prunePlayableVideoCache(maxBytes = playableVideoCacheMaxBytes) {
  const entries: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  let shardNames: string[];
  try {
    shardNames = await fs.readdir(playableVideoCacheDir);
  } catch {
    return { totalBytes: 0, deletedFiles: 0, deletedBytes: 0 };
  }

  for (const shard of shardNames) {
    const shardPath = path.join(playableVideoCacheDir, shard);
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
