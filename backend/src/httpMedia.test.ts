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
  downloadFileName,
  formatBytes,
  parseByteRange,
  savedMediaFileName,
} = await import("./httpMedia.js");

type NamedJob = Parameters<typeof downloadFileName>[0];

function downloadJob(overrides: Partial<NamedJob> = {}) {
  return { id: "job_1", modelName: "Veo 3", resultUrls: ["a.png"], ...overrides } as NamedJob;
}

const resultUrl = new URL("http://127.0.0.1/api/media?path=C%3A%5Cout%5Cshot.png");

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

// Download naming used to happen in the browser, from the blob's MIME type. It
// moved here when downloads became a streamed response, so these cases moved
// with it. Artists file results into project folders by hand, so a collision
// between the two images of one job is a real loss of work.

test("downloadFileName names the file after the model and job", () => {
  assert.equal(downloadFileName(downloadJob(), resultUrl, "image/png"), "Veo_3-job_1.png");
});

test("downloadFileName replaces characters that are illegal in a filename", () => {
  const name = downloadFileName(downloadJob({ modelName: 'Kling v2.6 <"edit">', id: "job_2" }), resultUrl, "image/png");
  assert.doesNotMatch(name, /[<>"]/);
  // The sanitizer runs on the whole "model-id" template and only trims
  // underscores from the very ends, so a model name ending in an illegal
  // character leaves an "_" sitting next to the id separator. Cosmetic, and
  // pinned here so it is a deliberate choice rather than a surprise.
  assert.equal(name, "Kling_v2.6_edit_-job_2.png");
});

test("downloadFileName falls back to a generic base when the model is unknown", () => {
  assert.equal(downloadFileName(downloadJob({ modelName: "" }), resultUrl, "image/png"), "result-job_1.png");
});

test("downloadFileName distinguishes the images of a multi-image result", () => {
  const job = downloadJob({ resultUrls: ["a.png", "b.png"] });
  assert.equal(downloadFileName(job, resultUrl, "image/png", { index: 0 }), "Veo_3-job_1_image-1.png");
  assert.equal(downloadFileName(job, resultUrl, "image/png", { index: 1 }), "Veo_3-job_1_image-2.png");
});

test("downloadFileName adds no index suffix when there is only one result", () => {
  assert.equal(downloadFileName(downloadJob(), resultUrl, "image/png", { index: 0 }), "Veo_3-job_1.png");
});

test("downloadFileName lets an explicit extension override the source's", () => {
  // A converted download is no longer a PNG, and a name that still claimed .png
  // would produce a file the OS opens with the wrong application.
  assert.equal(downloadFileName(downloadJob(), resultUrl, "image/png", { extension: ".jpg" }), "Veo_3-job_1.jpg");
});

test("downloadFileName falls back to the content type when the URL carries no extension", () => {
  const bare = new URL("http://127.0.0.1/api/jobs/job_1/result-media");
  assert.equal(downloadFileName(downloadJob(), bare, "video/mp4"), "Veo_3-job_1.mp4");
});

// Where the save step files a video and the name it gives it -- the name the
// player's own download menu has always offered for this render.
const savedVideoPath = path.join(
  base,
  "projects",
  "8499_Project",
  "videos",
  "SHOT_4000",
  "20260921_api-kling-v3-video_8499_SHOT_4000_v002.mp4",
);

test("downloadFileName gives a saved video the name it was saved under", () => {
  const job = downloadJob({ id: "job_a8430fc9e89643f78e1316bd", modelName: "Api Kling V3 Video" });
  const url = new URL(`http://127.0.0.1/api/media?path=${encodeURIComponent(savedVideoPath)}`);
  assert.equal(
    downloadFileName(job, url, "video/mp4", { index: 0, filePath: savedVideoPath }),
    "20260921_api-kling-v3-video_8499_SHOT_4000_v002.mp4",
  );
});

test("downloadFileName keeps a saved video's own extension", () => {
  const movPath = path.join(path.dirname(savedVideoPath), "20260921_api-kling-v3-video_8499_SHOT_4000_v003.mov");
  assert.equal(
    downloadFileName(downloadJob(), resultUrl, "video/quicktime", { filePath: movPath }),
    "20260921_api-kling-v3-video_8499_SHOT_4000_v003.mov",
  );
});

test("downloadFileName falls back to the generated name for a video with no file on this machine", () => {
  // Still on the provider, or recorded before results were saved locally.
  const job = downloadJob({ id: "job_a8430fc9e89643f78e1316bd", modelName: "Api Kling V3 Video" });
  const remote = new URL("https://example.com/output/ComfyUI_00012_.mp4");
  assert.equal(downloadFileName(job, remote, "video/mp4"), "Api_Kling_V3_Video-job_a8430fc9e89643f78e1316bd.mp4");
});

test("downloadFileName falls back to the generated name when no header could carry the saved one", () => {
  const unicodePath = path.join(base, "projects", "镜头_4000.mp4");
  const url = new URL(`http://127.0.0.1/api/media?path=${encodeURIComponent(unicodePath)}`);
  assert.equal(downloadFileName(downloadJob(), url, "video/mp4", { filePath: unicodePath }), "Veo_3-job_1.mp4");
});

test("downloadFileName leaves image downloads on the generated name", () => {
  // Images and their PNG/JPG conversions share one scheme; only videos moved.
  const imagePath = path.join(base, "projects", "20260911_api-openai-gpt-image-2-i2i_8499_cam-5120_v001.png");
  assert.equal(downloadFileName(downloadJob(), resultUrl, "image/png", { index: 0, filePath: imagePath }), "Veo_3-job_1.png");
});

test("savedMediaFileName swaps only the extension when a rendition changes container", () => {
  assert.equal(savedMediaFileName(savedVideoPath), "20260921_api-kling-v3-video_8499_SHOT_4000_v002.mp4");
  const movPath = path.join(path.dirname(savedVideoPath), "20260921_seedance_8499_SHOT_4000_v001.mov");
  assert.equal(savedMediaFileName(movPath, ".mp4"), "20260921_seedance_8499_SHOT_4000_v001.mp4");
});
