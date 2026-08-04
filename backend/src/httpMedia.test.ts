import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// isAllowedMediaPath is the only thing standing between a caller-supplied
// ?path= and the filesystem, so it gets the most attention here. Roots are
// pointed at a temp directory rather than the real Comfy tree, and built with
// path.join so the assertions hold on the Linux CI runner as well as Windows.
const base = path.join(os.tmpdir(), "momi-http-media-test");
process.env.COMFY_ROOT = path.join(base, "comfy");
process.env.BRICK_PROJECTS_ROOT = path.join(base, "projects");
process.env.LOCAL_PROJECTS_ROOT = path.join(base, "local");
process.env.UPLOADED_MEDIA_ROOT = path.join(base, "local", "_uploads");

const {
  isAllowedMediaPath,
  extensionFromContentType,
  isAllowedUploadContentType,
  cleanMediaExtension,
  uploadedMediaFileName,
  safeHeaderFileName,
  contentTypeFromFilePath,
  formatBytes,
  parseByteRange,
} = await import("./httpMedia.js");

const projectsRoot = path.join(base, "projects");
const comfyOutput = path.join(base, "comfy", "output");

test("paths inside an allowed root are accepted", () => {
  assert.equal(isAllowedMediaPath(path.join(projectsRoot, "TWR_Tower", "render.png")), true);
  assert.equal(isAllowedMediaPath(path.join(comfyOutput, "a.png")), true);
  assert.equal(isAllowedMediaPath(path.join(base, "local", "_uploads", "in.jpg")), true);
});

test("paths outside every allowed root are rejected", () => {
  assert.equal(isAllowedMediaPath(path.join(base, "elsewhere", "secret.png")), false);
  assert.equal(isAllowedMediaPath(path.join(os.tmpdir(), "unrelated.png")), false);
});

test("directory traversal out of an allowed root is rejected", () => {
  assert.equal(isAllowedMediaPath(path.join(projectsRoot, "..", "elsewhere", "secret.png")), false);
  assert.equal(isAllowedMediaPath(path.join(projectsRoot, "sub", "..", "..", "elsewhere", "x.png")), false);
});

test("a sibling directory whose name merely extends an allowed root is rejected", () => {
  // The check compares resolved paths with startsWith. Without a separator
  // boundary, "<root>-evil" and "<root>2" both pass as though they were inside
  // the root, which is a real escape: an attacker who can create a sibling
  // directory (or a project named to collide) reads files outside the allowlist.
  assert.equal(isAllowedMediaPath(`${projectsRoot}-evil${path.sep}secret.png`), false);
  assert.equal(isAllowedMediaPath(`${projectsRoot}2${path.sep}secret.png`), false);
  assert.equal(isAllowedMediaPath(`${comfyOutput}-leak${path.sep}a.png`), false);
});

test("the root directory itself is allowed", () => {
  assert.equal(isAllowedMediaPath(projectsRoot), true);
});

test("allowTemp widens the allowlist only when asked", () => {
  const temp = path.join(base, "comfy", "temp", "preview.png");
  assert.equal(isAllowedMediaPath(temp), false);
  assert.equal(isAllowedMediaPath(temp, { allowTemp: true }), true);
});

test("extensionFromContentType maps the types this app actually serves", () => {
  assert.equal(extensionFromContentType("image/jpeg"), ".jpg");
  assert.equal(extensionFromContentType("image/png"), ".png");
  assert.equal(extensionFromContentType("image/webp"), ".webp");
  assert.equal(extensionFromContentType("video/mp4"), ".mp4");
  assert.equal(extensionFromContentType("video/quicktime"), ".mov");
  // Matched as a substring, so a full header with parameters still works.
  assert.equal(extensionFromContentType("image/png; charset=binary"), ".png");
  // Unknown types must not guess.
  assert.equal(extensionFromContentType("application/octet-stream"), ".bin");
  assert.equal(extensionFromContentType(""), ".bin");
});

test("isAllowedUploadContentType keeps images and videos in their own lanes", () => {
  assert.equal(isAllowedUploadContentType("image", "image/png"), true);
  assert.equal(isAllowedUploadContentType("video", "video/mp4"), true);
  // A video uploaded through the image path (or vice versa) must be refused.
  assert.equal(isAllowedUploadContentType("image", "video/mp4"), false);
  assert.equal(isAllowedUploadContentType("video", "image/png"), false);
  assert.equal(isAllowedUploadContentType("image", "text/html"), false);
  assert.equal(isAllowedUploadContentType("image", ""), false);
});

test("safeHeaderFileName strips what would break a Content-Disposition header", () => {
  // A quote or CRLF here is a header-injection vector.
  const cleaned = safeHeaderFileName('re"nder\r\nX-Evil: 1.png');
  assert.ok(!cleaned.includes('"'));
  assert.ok(!cleaned.includes("\r"));
  assert.ok(!cleaned.includes("\n"));
});

test("cleanMediaExtension sanitises rather than rejects", () => {
  assert.equal(cleanMediaExtension(".PNG"), ".png");
  assert.equal(cleanMediaExtension(".png"), ".png");
  assert.equal(cleanMediaExtension(""), "");
  assert.equal(cleanMediaExtension("."), "");
  // Characters that could escape a path are stripped, and what is left is kept --
  // so a separator can never survive into a filename.
  assert.equal(cleanMediaExtension(".with/slash"), ".withslash");
  assert.equal(cleanMediaExtension("..\\..\\etc"), "....etc");
  // A bare extension gains its leading dot.
  assert.equal(cleanMediaExtension("png"), ".png");
});

test("uploadedMediaFileName produces a name with a usable extension", () => {
  assert.match(uploadedMediaFileName("photo.png", "image", "image/png"), /\.png$/);
  // No usable extension on the name: fall back to the content type.
  assert.match(uploadedMediaFileName("photo", "image", "image/jpeg"), /\.jpg$/);
  assert.match(uploadedMediaFileName("clip", "video", "video/mp4"), /\.mp4$/);
});

test("contentTypeFromFilePath keys off the extension", () => {
  assert.match(contentTypeFromFilePath("/x/a.png"), /image\/png/);
  assert.match(contentTypeFromFilePath("/x/a.mp4"), /video\/mp4/);
});

test("formatBytes is human readable at each magnitude", () => {
  assert.match(formatBytes(512), /B$/);
  assert.match(formatBytes(2 * 1024), /KiB|KB/);
  assert.match(formatBytes(5 * 1024 * 1024), /MiB|MB/);
});

test("parseByteRange handles the forms a video element sends", () => {
  const size = 1000;
  assert.deepEqual(parseByteRange("bytes=0-99", size), { start: 0, end: 99 });
  // Open-ended range: to the last byte.
  assert.deepEqual(parseByteRange("bytes=500-", size), { start: 500, end: size - 1 });
  // Suffix range: the last N bytes.
  assert.deepEqual(parseByteRange("bytes=-100", size), { start: size - 100, end: size - 1 });
});

test("parseByteRange distinguishes 'not a range request' from 'cannot be satisfied'", () => {
  const size = 1000;
  // undefined means "no usable Range header" -> serve the whole file, 200.
  assert.equal(parseByteRange("", size), undefined);
  assert.equal(parseByteRange(undefined, size), undefined);
  assert.equal(parseByteRange("items=0-10", size), undefined, "a non-bytes unit");
  assert.equal(parseByteRange("bytes=abc-def", size), undefined, "not numeric, so not a range at all");
  assert.equal(parseByteRange("bytes=-", size), undefined, "neither bound given");

  // "unsatisfiable" is a distinct signal so the route can answer 416 rather than
  // silently serving the wrong bytes. Worth pinning: collapsing the two would
  // turn a client bug into a corrupt download.
  assert.equal(parseByteRange(`bytes=${size}-`, size), "unsatisfiable", "start at or past EOF");
  assert.equal(parseByteRange("bytes=500-100", size), "unsatisfiable", "inverted range");
  assert.equal(parseByteRange("bytes=-0", size), "unsatisfiable", "zero-length suffix");
  assert.equal(parseByteRange("bytes=0-99", 0), "unsatisfiable", "empty file");
});

test("parseByteRange clamps an end past EOF instead of failing", () => {
  assert.deepEqual(parseByteRange("bytes=0-99999", 1000), { start: 0, end: 999 });
});
