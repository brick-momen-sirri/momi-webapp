import assert from "node:assert/strict";
import test from "node:test";
import {
  UPLOAD_BASE_NAME_MAX_LENGTH,
  stripUploadIdPrefixes,
  uploadedMediaBaseName,
} from "./uploadedMediaName.js";

test("leaves a name with no upload-id prefix alone", () => {
  assert.equal(stripUploadIdPrefixes("CAM_S"), "CAM_S");
  assert.equal(stripUploadIdPrefixes("shot-01_final"), "shot-01_final");
  assert.equal(uploadedMediaBaseName("CAM_S", "image-upload"), "CAM_S");
});

test("strips a single upload-id prefix", () => {
  assert.equal(stripUploadIdPrefixes("1785755426495-8844bc9dbef0-CAM_S"), "CAM_S");
});

test("strips every chained prefix, not just the outermost", () => {
  // Reproduces the real production case: six accumulated prefixes.
  const chained =
    "1785755426495-8844bc9dbef0-"
    + "1785754786520-0da65897d3ed-"
    + "1785751640462-4daae6fccac3-"
    + "1785751324905-ef5f0a4de0a8-"
    + "1785751050111-5cf7adcd665d-"
    + "1785750855402-6c338c091e98-"
    + "CAM_S";
  assert.equal(stripUploadIdPrefixes(chained), "CAM_S");
  assert.equal(uploadedMediaBaseName(chained, "image-upload"), "CAM_S");
});

test("re-deriving a name repeatedly does not grow it", () => {
  // The actual regression: each round trip previously added 26 characters.
  let name = "CAM_S";
  for (let round = 0; round < 8; round += 1) {
    // Simulate the server storing "<uploadId>-<name>" and the client sending
    // that stored basename back on the next upload.
    const stored = `178575${String(1000000 + round).padStart(7, "0")}-8844bc9dbef${round}-${name}`;
    name = uploadedMediaBaseName(stored, "image-upload");
  }
  assert.equal(name, "CAM_S", "name should be stable across repeated re-uploads");
});

test("does not mistake similar-looking names for a prefix", () => {
  // Wrong digit count, wrong hex length, and a non-hex segment must all survive.
  for (const name of [
    "178575542649-8844bc9dbef0-CAM_S",
    "1785755426495-8844bc9dbef-CAM_S",
    "1785755426495-zzzzzzzzzzzz-CAM_S",
    "1785755426495-CAM_S",
  ]) {
    assert.equal(stripUploadIdPrefixes(name), name, `should not strip from ${name}`);
  }
});

test("applies the length budget and trims a dangling separator", () => {
  const long = `${"a".repeat(UPLOAD_BASE_NAME_MAX_LENGTH + 40)}_tail`;
  const result = uploadedMediaBaseName(long, "image-upload");
  assert.equal(result.length, UPLOAD_BASE_NAME_MAX_LENGTH);

  // A slice landing on a separator should not leave it trailing.
  const onSeparator = `${"a".repeat(UPLOAD_BASE_NAME_MAX_LENGTH - 1)}__${"b".repeat(20)}`;
  assert.ok(!uploadedMediaBaseName(onSeparator, "image-upload").endsWith("_"));
});

test("falls back when nothing usable survives sanitising", () => {
  assert.equal(uploadedMediaBaseName("", "image-upload"), "image-upload");
  assert.equal(uploadedMediaBaseName("1785755426495-8844bc9dbef0-", "video-upload"), "video-upload");
  // safeSegment maps path-hostile characters to "_", which then trims away.
  assert.equal(uploadedMediaBaseName("///", "image-upload"), "image-upload");
});

test("keeps the stored path clear of the Windows 260-character limit", () => {
  // Mirrors the real layout: uploads root + project + user + uploadId + name.
  const root = "C:\\Momi-Animation\\backend\\data\\projects\\_uploads";
  const project = "prj_8383_labella_bleutech_park";
  const user = "usr_b84b913428674654";
  const uploadId = "1785755426495-8844bc9dbef0";
  const baseName = uploadedMediaBaseName("x".repeat(300), "image-upload");
  const fullPath = `${root}\\${project}\\${user}\\${uploadId}-${baseName}.png`;
  assert.ok(fullPath.length < 260, `expected under 260 chars, got ${fullPath.length}`);
});
