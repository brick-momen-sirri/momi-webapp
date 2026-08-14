/**
 * One-off backfill for playable video renditions.
 *
 * Renditions are built when a result is saved, so everything rendered from the
 * moment that landed is covered. Videos already on disk are not: an HEVC 4K
 * result from last week still has a cold cache, and the first person to open it
 * waits out a full transcode -- or, if the warm has not run at all, watches the
 * original fail to decode exactly as before.
 *
 * This walks the project media roots and builds them ahead of time. Safe to stop
 * and re-run: anything already cached is skipped, and anything already playable
 * costs one ffprobe and is left alone.
 *
 * Originals are never modified. The only writes are into the rendition cache.
 *
 *   node node_modules/tsx/dist/cli.mjs src/warmPlayableVideos.ts [options]
 *
 *   --limit=N         stop after N videos (default: no limit)
 *   --concurrency=N   videos in flight (default 1; transcoding is CPU-bound and
 *                     the encoder has its own cap)
 *   --dry-run         report which videos would need a rendition, write nothing
 *   --no-prune        skip the cache prune at the end
 *   --oldest-first    process oldest first (default is newest, which is what
 *                     people actually open)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { brickProjectsRoot, localProjectsRoot, playableVideoCacheDir, uploadedMediaRoot } from "./config.js";
import { isPathWithinRoot } from "./pathContainment.js";
import {
  isBrowserPlayable,
  isPlayableVideoSource,
  probeVideo,
  prunePlayableVideoCache,
  warmPlayableVideo,
} from "./playableVideoService.js";

type Candidate = { filePath: string; size: number; mtimeMs: number };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prune = !args.includes("--no-prune");
const oldestFirst = args.includes("--oldest-first");
const limit = numberArg("--limit", Number.POSITIVE_INFINITY);
// One at a time by default. This is expected to run on the production box while
// people are working, and a 4K transcode saturates a core for a few seconds; the
// encoder's semaphore is shared with live playback requests.
const concurrency = Math.max(1, numberArg("--concurrency", 1));

function numberArg(flag: string, fallback: number) {
  const raw = args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Every video under the project roots.
 *
 * These are the roots the media path policy allows to be served, so a video
 * outside them could not be played anyway. The uploads tree is skipped: those are
 * job inputs, which nobody watches through the result player.
 */
async function* walkVideos(root: string): AsyncGenerator<Candidate> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (isPathWithinRoot(filePath, uploadedMediaRoot)) continue;
      yield* walkVideos(filePath);
      continue;
    }
    if (!entry.isFile() || !isPlayableVideoSource(filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => undefined);
    if (stat?.isFile() && stat.size > 0) {
      yield { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
}

async function runPool(items: Candidate[], run: (item: Candidate) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let index = cursor++; index < items.length; index = cursor++) {
        await run(items[index]);
      }
    }),
  );
}

function formatBytes(value: number) {
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = value / 1024 ** 2;
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(value / 1024).toFixed(0)} KiB`;
}

async function main() {
  // Printed so a mis-set PLAYABLE_VIDEO_CACHE_DIR is obvious immediately, rather
  // than after transcoding an afternoon's worth of video into a directory that
  // nothing reads.
  console.log(`Cache: ${playableVideoCacheDir}`);
  console.log(`Roots: ${brickProjectsRoot}, ${localProjectsRoot}`);
  console.log(dryRun ? "Mode:  dry run (nothing will be written)\n" : `Mode:  warming, concurrency ${concurrency}\n`);

  const candidates: Candidate[] = [];
  for (const root of new Set([brickProjectsRoot, localProjectsRoot])) {
    for await (const candidate of walkVideos(root)) {
      candidates.push(candidate);
    }
  }

  // Newest first by default: the top of a project's gallery is what someone
  // opens, so an interrupted run has still covered the part that matters.
  candidates.sort((left, right) => (oldestFirst ? left.mtimeMs - right.mtimeMs : right.mtimeMs - left.mtimeMs));
  const work = candidates.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);

  console.log(`Found ${candidates.length} video(s); processing ${work.length}.`);
  if (limit !== Number.POSITIVE_INFINITY && candidates.length > work.length) {
    console.log(`Skipping ${candidates.length - work.length} beyond --limit=${limit}. Re-run to continue.`);
  }
  if (!work.length) {
    console.log("\nNothing to do.");
    return;
  }

  const startedAt = Date.now();
  let processed = 0;
  let rebuilt = 0;
  let alreadyPlayable = 0;
  let unreadable = 0;

  await runPool(work, async (item) => {
    processed += 1;

    if (dryRun) {
      const probe = await probeVideo(item.filePath);
      if (!probe) {
        unreadable += 1;
        console.log(`  ? ${path.basename(item.filePath)} - could not probe`);
      } else if (isBrowserPlayable(probe)) {
        alreadyPlayable += 1;
      } else {
        rebuilt += 1;
        console.log(
          `  → ${path.basename(item.filePath)} - ${probe.codecName} ${probe.profile} ${probe.pixelFormat} ` +
            `${probe.width}x${probe.height} (${formatBytes(item.size)})`,
        );
      }
      return;
    }

    // warmPlayableVideo never throws and logs its own failures, so one bad file
    // cannot abort a run with hundreds left to do.
    if (await warmPlayableVideo(item.filePath)) {
      rebuilt += 1;
    } else {
      alreadyPlayable += 1;
    }

    if (processed % 10 === 0 || processed === work.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = processed / Math.max(elapsed, 0.001);
      const remaining = (work.length - processed) / Math.max(rate, 0.001);
      console.log(
        `${processed}/${work.length} - ${rebuilt} rendition(s) built, ${alreadyPlayable} needed none - ` +
          `~${Math.round(remaining)}s left`,
      );
    }
  });

  if (dryRun) {
    console.log(
      `\nDry run complete: ${rebuilt} video(s) would be re-encoded, ${alreadyPlayable} already play in a browser` +
        (unreadable ? `, ${unreadable} could not be probed.` : "."),
    );
    return;
  }

  console.log(
    `\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
      `${rebuilt} rendition(s) built, ${alreadyPlayable} already playable or skipped.`,
  );

  if (prune) {
    // The cache has a disk budget and is normally pruned on a timer in the
    // dispatcher. A big backfill can push it over in one go, so settle up here
    // rather than leaving it over budget until the next scheduled pass.
    const result = await prunePlayableVideoCache();
    console.log(
      `Cache now ${formatBytes(result.totalBytes)}` +
        (result.deletedFiles ? `; pruned ${result.deletedFiles} file(s), ${formatBytes(result.deletedBytes)}.` : "."),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
