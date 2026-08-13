/**
 * One-off backfill for preview renditions.
 *
 * Renditions are built when a result is saved, so everything rendered from that
 * point on is already warm. Results that existed before still have a cold cache,
 * and the first person to open one of those projects pays a full decode of every
 * original they scroll past -- which for a 10K PNG is several seconds and a few
 * hundred MB of peak memory, on the server, per image.
 *
 * This walks the project media roots and warms them ahead of time. It is safe to
 * stop and re-run: warmThumbnails skips anything already cached, so a second pass
 * only picks up what the first did not finish.
 *
 * Originals are never modified. The only writes are into the thumbnail cache.
 *
 *   node node_modules/tsx/dist/cli.mjs src/warmResultPreviews.ts [options]
 *
 *   --limit=N         stop after N images (default: no limit)
 *   --concurrency=N   images in flight (default 2; the encoder has its own cap)
 *   --dry-run         report what would be warmed, write nothing
 *   --no-prune        skip the cache prune at the end
 *   --oldest-first    process oldest first (default is newest, which is what
 *                     people actually browse)
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  brickProjectsRoot,
  localProjectsRoot,
  resultPreviewWidths,
  thumbnailCacheDir,
  thumbnailPassthroughMaxBytes,
  uploadedMediaRoot,
} from "./config.js";
import { isPathWithinRoot } from "./pathContainment.js";
import { isThumbnailableSource, pruneThumbnailCache, warmThumbnails } from "./thumbnailService.js";

type Candidate = { filePath: string; size: number; mtimeMs: number };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prune = !args.includes("--no-prune");
const oldestFirst = args.includes("--oldest-first");
const limit = numberArg("--limit", Number.POSITIVE_INFINITY);
// Deliberately low. This is expected to run on the production box while people
// are working, and the encoder's own semaphore is shared with live requests --
// so the default leaves most of it for whoever is actually waiting on a page.
const concurrency = Math.max(1, numberArg("--concurrency", 2));

function numberArg(flag: string, fallback: number) {
  const raw = args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Every image under the project roots.
 *
 * These two roots are what the media path policy allows to be served, so an
 * image outside them could not be displayed anyway and is not worth warming.
 * The uploads tree is skipped: those are job inputs, not results.
 */
async function* walkImages(root: string): AsyncGenerator<Candidate> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (isPathWithinRoot(filePath, uploadedMediaRoot)) continue;
      yield* walkImages(filePath);
      continue;
    }
    if (!entry.isFile() || !isThumbnailableSource(filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => undefined);
    // Sources this small are streamed as they are, so a rendition would be
    // written and then never read.
    if (stat?.isFile() && stat.size > thumbnailPassthroughMaxBytes) {
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
  // Printed so a mis-set THUMBNAIL_CACHE_DIR is obvious immediately, rather than
  // after warming several thousand images into a directory nothing reads.
  console.log(`Cache:  ${thumbnailCacheDir}`);
  console.log(`Widths: ${resultPreviewWidths.join(", ")}`);
  console.log(`Roots:  ${brickProjectsRoot}, ${localProjectsRoot}`);
  console.log(dryRun ? "Mode:   dry run (nothing will be written)\n" : `Mode:   warming, concurrency ${concurrency}\n`);

  const candidates: Candidate[] = [];
  for (const root of new Set([brickProjectsRoot, localProjectsRoot])) {
    for await (const candidate of walkImages(root)) {
      candidates.push(candidate);
    }
  }

  // Newest first by default: the top of a project's gallery is what someone
  // opens, so a run that gets interrupted has still warmed the part that matters.
  candidates.sort((left, right) => (oldestFirst ? left.mtimeMs - right.mtimeMs : right.mtimeMs - left.mtimeMs));
  const work = candidates.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
  const totalBytes = work.reduce((sum, item) => sum + item.size, 0);

  console.log(`Found ${candidates.length} image(s); processing ${work.length} (${formatBytes(totalBytes)} of originals).`);
  if (limit !== Number.POSITIVE_INFINITY && candidates.length > work.length) {
    console.log(`Skipping ${candidates.length - work.length} beyond --limit=${limit}. Re-run to continue.`);
  }
  if (!work.length || dryRun) {
    console.log(dryRun ? "\nDry run complete." : "\nNothing to do.");
    return;
  }

  const startedAt = Date.now();
  let processed = 0;
  let renditions = 0;
  let warmed = 0;
  let nothingToDo = 0;

  await runPool(work, async (item) => {
    // warmThumbnails never throws and logs its own failures, so one undecodable
    // file cannot abort a run that has thousands left to do.
    const widths = await warmThumbnails(item.filePath);
    processed += 1;
    if (widths.length) {
      warmed += 1;
      renditions += widths.length;
    } else {
      nothingToDo += 1;
    }
    if (processed % 25 === 0 || processed === work.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = processed / Math.max(elapsed, 0.001);
      const remaining = (work.length - processed) / Math.max(rate, 0.001);
      console.log(
        `${processed}/${work.length} - ${warmed} warmed, ${nothingToDo} already warm - ` +
          `${rate.toFixed(1)}/s, ~${Math.round(remaining)}s left`,
      );
    }
  });

  console.log(
    `\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
      `${warmed} image(s) warmed (${renditions} rendition(s)), ${nothingToDo} already warm or undecodable.`,
  );

  if (prune) {
    // The cache has a disk budget and is normally pruned on a timer in the
    // dispatcher. A big backfill can push it over in one go, so settle up here
    // rather than leaving it over budget until the next scheduled pass.
    const result = await pruneThumbnailCache();
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
