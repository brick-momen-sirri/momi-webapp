import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-thumbnails-"));
process.env.THUMBNAIL_CACHE_DIR = path.join(tempRoot, "cache");
process.env.THUMBNAIL_WIDTHS = "240,480";
process.env.THUMBNAIL_PASSTHROUGH_MAX_BYTES = "1024";
// Small enough that one fixture below can sit over it; every other fixture that
// relies on reading into memory (the MAX_PATH ones) stays well under.
process.env.THUMBNAIL_BUFFER_RETRY_MAX_BYTES = String(4 * 1024 * 1024);

const sharp = (await import("sharp")).default;
const {
  getOrCreateThumbnail,
  isThumbnailableSource,
  isVideoSource,
  normalizeThumbnailWidth,
  pruneThumbnailCache,
  streamConvertedImage,
  warmThumbnails,
} = await import("./thumbnailService.js");

async function writeSourceImage(name: string, width: number, height: number) {
  const filePath = path.join(tempRoot, name);
  // Noise compresses poorly, so the PNG lands comfortably above the passthrough
  // threshold the way a real render does.
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 2654435761) % 256;
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toFile(filePath);
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
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } })
    .png()
    .toFile(tiny);
  assert.ok((await fs.stat(tiny)).size <= 1024, "fixture should be under the configured passthrough threshold");

  assert.equal((await getOrCreateThumbnail(tiny, 480)).kind, "passthrough");
});

test("passes through non-image, non-video sources instead of trying to decode them", async () => {
  const document = path.join(tempRoot, "notes.txt");
  await fs.writeFile(document, "not media");

  assert.equal(isThumbnailableSource(document), false);
  assert.equal(isVideoSource(document), false);
  assert.equal((await getOrCreateThumbnail(document, 480)).kind, "passthrough");
});

test("extracts a poster frame from a video instead of passing it through", async (t) => {
  const clip = path.join(tempRoot, "clip.mp4");
  // A real 2-second clip: colour bars, so a decoded frame is non-empty.
  try {
    await execFileAsync(
      process.env.FFMPEG_PATH?.trim() || "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=2", clip],
      { timeout: 30_000, windowsHide: true },
    );
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  assert.equal(isVideoSource(clip), true);
  const rendition = await getOrCreateThumbnail(clip, 480);
  assert.equal(rendition.kind, "rendition", "a video should yield a poster, not a passthrough");
  if (rendition.kind !== "rendition") return;

  const metadata = await sharp(rendition.filePath).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 480);
  assert.equal(metadata.height, 270);
});

test("falls back to frame 0 for a clip shorter than the seek offset", async (t) => {
  const shortClip = path.join(tempRoot, "short.mp4");
  // 0.2s is well under the 1s default seek, so the first attempt finds nothing.
  try {
    await execFileAsync(
      process.env.FFMPEG_PATH?.trim() || "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=0.2", shortClip],
      { timeout: 30_000, windowsHide: true },
    );
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }

  const rendition = await getOrCreateThumbnail(shortClip, 240);
  assert.equal(rendition.kind, "rendition", "a sub-second clip should still yield a poster");
  if (rendition.kind !== "rendition") return;
  assert.equal((await sharp(rendition.filePath).metadata()).format, "webp");
});

test("rejects a video that holds no decodable frame so the route can fall back", async () => {
  const broken = path.join(tempRoot, "broken.mp4");
  await fs.writeFile(broken, Buffer.alloc(4096, 7));

  assert.equal(isVideoSource(broken), true);
  await assert.rejects(() => getOrCreateThumbnail(broken, 480));
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
  assert.ok((await sizeOf()) <= budget, "cache should end up within its budget");
});

// Warming exists so that browsing a project never decodes an original. If these
// stop writing the exact keys the read path looks up, the warm still "succeeds"
// and every first view silently pays for a 100 MB decode again.

test("warming fills the cache the read path reads, without decoding again", async () => {
  const source = await writeSourceImage("warm.png", 1200, 800);
  const written = await warmThumbnails(source, [240, 480]);
  assert.deepEqual(written.sort(), [240, 480]);

  // The proof that the keys line up: a read now has to find these on disk rather
  // than encoding its own. A mismatched key would leave the cache cold and this
  // would still return a rendition, so compare the actual files.
  for (const width of [240, 480]) {
    const rendition = await getOrCreateThumbnail(source, width);
    assert.equal(rendition.kind, "rendition");
    if (rendition.kind !== "rendition") return;
    const metadata = await sharp(rendition.filePath).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, width);
  }
});

test("warming twice does no work the second time", async () => {
  const source = await writeSourceImage("warm-idempotent.png", 700, 700);
  assert.deepEqual((await warmThumbnails(source, [480])).sort(), [480]);
  // Nothing left to write, so nothing is reported -- a second render pass over a
  // project must not re-encode everything it already has.
  assert.deepEqual(await warmThumbnails(source, [480]), []);
});

test("warming keeps transparency rather than flattening it", async () => {
  // These results can be transparent, and a preview that silently gained a black
  // or white background would misrepresent the render.
  const filePath = path.join(tempRoot, "warm-alpha.png");
  const pixels = Buffer.alloc(600 * 600 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = (index * 7) % 256;
    pixels[index + 1] = (index * 13) % 256;
    pixels[index + 2] = (index * 29) % 256;
    pixels[index + 3] = index % 512 === 0 ? 0 : 255;
  }
  await sharp(pixels, { raw: { width: 600, height: 600, channels: 4 } })
    .png({ compressionLevel: 0 })
    .toFile(filePath);

  await warmThumbnails(filePath, [240]);
  const rendition = await getOrCreateThumbnail(filePath, 240);
  assert.equal(rendition.kind, "rendition");
  if (rendition.kind !== "rendition") return;
  assert.equal((await sharp(rendition.filePath).metadata()).hasAlpha, true);
});

test("warming an undecodable source reports nothing instead of throwing", async () => {
  // A warm failure must never fail the render that produced the image: the read
  // path falls back to serving the original.
  const filePath = path.join(tempRoot, "warm-broken.png");
  await fs.writeFile(filePath, Buffer.alloc(4096, 7));
  assert.deepEqual(await warmThumbnails(filePath, [240]), []);
});

test("warming skips sources small enough to be served as they are", async () => {
  // getOrCreateThumbnail streams these unchanged, so a rendition would be written
  // and then never read.
  const filePath = path.join(tempRoot, "warm-tiny.png");
  await sharp(Buffer.alloc(8 * 8 * 3), { raw: { width: 8, height: 8, channels: 3 } })
    .png()
    .toFile(filePath);
  assert.deepEqual(await warmThumbnails(filePath, [240]), []);
});

test("warming a video is left to the on-demand poster path", async () => {
  assert.deepEqual(await warmThumbnails(path.join(tempRoot, "clip.mp4"), [240]), []);
});

/** Runs a download conversion into memory, the way the route streams it into the response. */
async function convert(sourcePath: string, format: "png" | "jpg") {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await streamConvertedImage(sourcePath, format, sink);
  return Buffer.concat(chunks);
}

test("a JPG download is a real JPEG at the source's size, with transparency turned white", async () => {
  const width = 320;
  const height = 180;
  // Left half opaque red, right half fully transparent.
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width / 2; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 3] = 255;
    }
  }
  const source = path.join(tempRoot, "convert-alpha.png");
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(source);

  const output = await convert(source, "jpg");

  // The JPEG signature: a real re-encode, not a PNG under a new name.
  assert.deepEqual([...output.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, width);
  assert.equal(metadata.height, height);
  assert.equal(metadata.hasAlpha, false);
  // Full chroma resolution, which is what the dialog's "100% quality" promises.
  assert.equal(metadata.chromaSubsampling, "4:4:4");

  const decoded = await sharp(output).raw().toBuffer();
  const pixelAt = (x: number, y: number) => [...decoded.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
  const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]) <= 2);
  assert.ok(near(pixelAt(width / 4, height / 2), [255, 0, 0]), `opaque half decoded as ${pixelAt(width / 4, height / 2)}`);
  assert.ok(
    near(pixelAt((width * 3) / 4, height / 2), [255, 255, 255]),
    `transparent half decoded as ${pixelAt((width * 3) / 4, height / 2)}`,
  );
});

test("a PNG download of a JPEG source is a real PNG at the source's size", async () => {
  const source = path.join(tempRoot, "convert-source.jpg");
  await sharp({ create: { width: 300, height: 200, channels: 3, background: "#336699" } })
    .jpeg()
    .toFile(source);

  const output = await convert(source, "png");

  assert.deepEqual([...output.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 300);
  assert.equal(metadata.height, 200);
});

test("converts a source whose path exceeds the Windows 260-char MAX_PATH limit", async () => {
  // sharp cannot open this path at all (see the rendition test above), so a
  // conversion that succeeds here read the source through Node -- the change
  // that took JPG downloads from 4 KB libvips reads over SMB to a few large ones.
  const segment = "c".repeat(60);
  const deepDir = path.join(tempRoot, segment, segment, segment);
  await fs.mkdir(deepDir, { recursive: true });
  const longPath = path.join(deepDir, `${"m".repeat(80)}.png`);
  assert.ok(longPath.length > 260, `fixture path should exceed MAX_PATH, got ${longPath.length}`);
  await fs.copyFile(await writeSourceImage("convert-longpath-src.png", 400, 300), longPath);

  const metadata = await sharp(await convert(longPath, "jpg")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 400);
  assert.equal(metadata.height, 300);
});

test("a source over the in-memory cap still converts, decoded by path", async () => {
  // 1600 x 1000 of uncompressed noise is ~4.8 MB, over the 4 MiB cap set above.
  const source = await writeSourceImage("convert-over-cap.png", 1600, 1000);
  assert.ok((await fs.stat(source)).size > 4 * 1024 * 1024);

  const metadata = await sharp(await convert(source, "jpg")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 1000);
});

test("a download abandoned before its conversion starts gives the encode slot back", { timeout: 20_000 }, async () => {
  // The client gave up while the conversion queued for a slot or read its source,
  // so the response closed before the conversion attached to it. Each of these
  // used to wait forever on a "close" that had already fired; one more than the
  // slot count then locked every conversion and rendition in the process out.
  const source = await writeSourceImage("convert-abandoned.png", 200, 200);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const abandoned = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    abandoned.destroy();
    await once(abandoned, "close");
    await streamConvertedImage(source, "jpg", abandoned);
  }

  const metadata = await sharp(await convert(source, "jpg")).metadata();
  assert.equal(metadata.format, "jpeg");
});

test.after(async () => {
  // Best effort. Windows reports EBUSY while a just-written rendition still has
  // an open handle, and this is a temp directory the OS will reclaim anyway --
  // failing or, worse, retrying the run to death over cleanup helps nobody.
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});
