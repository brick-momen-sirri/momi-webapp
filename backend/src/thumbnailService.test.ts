import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-thumbnails-"));
process.env.THUMBNAIL_CACHE_DIR = path.join(tempRoot, "cache");
process.env.THUMBNAIL_WIDTHS = "240,480";
process.env.THUMBNAIL_PASSTHROUGH_MAX_BYTES = "1024";

const sharp = (await import("sharp")).default;
const {
  getOrCreateThumbnail,
  isThumbnailableSource,
  normalizeThumbnailWidth,
  pruneThumbnailCache,
} = await import("./thumbnailService.js");

async function writeSourceImage(name: string, width: number, height: number) {
  const filePath = path.join(tempRoot, name);
  // Noise compresses poorly, so the PNG lands comfortably above the passthrough
  // threshold the way a real render does.
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 2654435761) % 256;
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toFile(filePath);
  return filePath;
}

test("produces a webp rendition capped to the requested width", async () => {
  const source = await writeSourceImage("wide.png", 1600, 900);
  const rendition = await getOrCreateThumbnail(source, 480);

  assert.equal(rendition.kind, "rendition");
  if (rendition.kind !== "rendition") return;
  assert.equal(rendition.contentType, "image/webp");

  const metadata = await sharp(rendition.filePath).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 480);
  // 1600x900 scaled to fit inside a 480 box keeps the aspect ratio.
  assert.equal(metadata.height, 270);

  const [sourceStat, renditionStat] = await Promise.all([fs.stat(source), fs.stat(rendition.filePath)]);
  assert.ok(
    renditionStat.size < sourceStat.size / 4,
    `expected the rendition (${renditionStat.size}B) to be far smaller than the source (${sourceStat.size}B)`,
  );
});

test("serves the same cached file on a second request and re-renders after the source changes", async () => {
  const source = await writeSourceImage("cached.png", 800, 800);

  const first = await getOrCreateThumbnail(source, 240);
  const second = await getOrCreateThumbnail(source, 240);
  assert.equal(first.kind, "rendition");
  assert.equal(second.kind, "rendition");
  if (first.kind !== "rendition" || second.kind !== "rendition") return;
  assert.equal(second.cacheKey, first.cacheKey, "an unchanged source should reuse its cached rendition");

  // Re-rendering a result rewrites the file: the key covers mtime and size, so
  // the stale rendition must not be served.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const replacement = await writeSourceImage("cached-replacement.png", 640, 640);
  await fs.copyFile(replacement, source);

  const third = await getOrCreateThumbnail(source, 240);
  assert.equal(third.kind, "rendition");
  if (third.kind !== "rendition") return;
  assert.notEqual(third.cacheKey, first.cacheKey, "a changed source must invalidate its cached rendition");
});

test("a burst of concurrent requests encodes the rendition once", async () => {
  const source = await writeSourceImage("burst.png", 1200, 1200);
  const results = await Promise.all(Array.from({ length: 12 }, () => getOrCreateThumbnail(source, 480)));

  const keys = new Set(results.map((result) => (result.kind === "rendition" ? result.cacheKey : "passthrough")));
  assert.equal(keys.size, 1, "every concurrent caller should get the same rendition");

  const shard = path.join(process.env.THUMBNAIL_CACHE_DIR!, [...keys][0].slice(0, 2));
  const files = await fs.readdir(shard);
  assert.deepEqual(
    files.filter((name) => name.endsWith(".tmp")),
    [],
    "no partial temp files should be left behind",
  );
});

test("passes through sources already smaller than the threshold", async () => {
  const tiny = path.join(tempRoot, "tiny.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toFile(tiny);
  assert.ok((await fs.stat(tiny)).size <= 1024, "fixture should be under the configured passthrough threshold");

  assert.equal((await getOrCreateThumbnail(tiny, 480)).kind, "passthrough");
});

test("passes through non-image sources instead of trying to decode them", async () => {
  const video = path.join(tempRoot, "clip.mp4");
  await fs.writeFile(video, Buffer.alloc(4096, 7));

  assert.equal(isThumbnailableSource(video), false);
  assert.equal((await getOrCreateThumbnail(video, 480)).kind, "passthrough");
});

test("snaps requested widths onto the whitelist", () => {
  assert.equal(normalizeThumbnailWidth(1), 240);
  assert.equal(normalizeThumbnailWidth(240), 240);
  assert.equal(normalizeThumbnailWidth(300), 480);
  // Above the largest allowed width, clamp rather than honour the request.
  assert.equal(normalizeThumbnailWidth(4000), 480);
  assert.equal(normalizeThumbnailWidth(undefined), 240);
});

test("renders a source whose path exceeds the Windows 260-char MAX_PATH limit", async () => {
  // Reproduces a real production failure: sharp resolves paths through libvips'
  // native API, which reports an over-long path as "Input file is missing".
  // Long names rather than deep nesting, mirroring the accumulated upload
  // prefixes that caused it.
  const segment = "s".repeat(60);
  const deepDir = path.join(tempRoot, segment, segment, segment);
  await fs.mkdir(deepDir, { recursive: true });
  const longPath = path.join(deepDir, `${"n".repeat(80)}.png`);
  assert.ok(longPath.length > 260, `fixture path should exceed MAX_PATH, got ${longPath.length}`);

  const source = await writeSourceImage("longpath-src.png", 900, 900);
  await fs.copyFile(source, longPath);

  const rendition = await getOrCreateThumbnail(longPath, 480);
  assert.equal(rendition.kind, "rendition");
  if (rendition.kind !== "rendition") return;

  const metadata = await sharp(rendition.filePath).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 480);
});

test("rejects a source that cannot be decoded so the route can fall back", async () => {
  const corrupt = path.join(tempRoot, "corrupt.png");
  await fs.writeFile(corrupt, Buffer.alloc(8192, 0xab));

  await assert.rejects(() => getOrCreateThumbnail(corrupt, 480));
});

test("prune evicts oldest renditions down to the budget", async () => {
  const cacheDir = process.env.THUMBNAIL_CACHE_DIR!;
  for (let index = 0; index < 6; index += 1) {
    const source = await writeSourceImage(`prune-${index}.png`, 900, 900);
    await getOrCreateThumbnail(source, 480);
  }

  const sizeOf = async () => {
    let total = 0;
    for (const shard of await fs.readdir(cacheDir)) {
      for (const name of await fs.readdir(path.join(cacheDir, shard))) {
        total += (await fs.stat(path.join(cacheDir, shard, name))).size;
      }
    }
    return total;
  };

  const before = await sizeOf();
  const budget = Math.floor(before / 2);
  const result = await pruneThumbnailCache(budget);

  assert.ok(result.deletedFiles > 0, "prune should have evicted something");
  assert.ok(await sizeOf() <= budget, "cache should end up within its budget");
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});
