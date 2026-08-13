import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertManifestRecordSafe,
  readJsonFileWithBackup,
  redactEmbeddedMedia,
  snapshotJsonStore,
  writeJsonFile,
} from "./storageService.js";

test("writeJsonFile rejects embedded media in metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-metadata-"));
  const filePath = path.join(dir, "jobs.json");

  await assert.rejects(
    writeJsonFile(filePath, [{ id: "job_test", image: "data:image/png;base64,AAA=" }]),
    /Refusing to write embedded media/,
  );

  await assert.rejects(fs.stat(filePath));
});

test("manifest guard rejects embedded media and oversized records", () => {
  assert.throws(
    () => assertManifestRecordSafe({ file_path: "result.png", remote_url: "data:image/png;base64,AAA=" }),
    /Refusing to write embedded media/,
  );

  assert.throws(
    () => assertManifestRecordSafe({ file_path: "result.png", prompt: "x".repeat(260_000) }),
    /oversized metadata string|oversized metadata file/,
  );
});

test("readJsonFileWithBackup reads the main file when it is valid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-store-"));
  const filePath = path.join(dir, "jobs.json");
  await writeJsonFile(filePath, [{ id: "job_1" }]);

  const loaded = await readJsonFileWithBackup<Array<{ id: string }>>(filePath, []);
  assert.deepEqual(loaded, [{ id: "job_1" }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("readJsonFileWithBackup recovers from .bak when the main file is corrupt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-store-"));
  const filePath = path.join(dir, "jobs.json");
  // First good write establishes content; second write leaves the first as .bak.
  await writeJsonFile(filePath, [{ id: "good_1" }]);
  await writeJsonFile(filePath, [{ id: "good_1" }, { id: "good_2" }]);
  // Corrupt the main file; .bak still holds the previous good state.
  await fs.writeFile(filePath, "{ this is not valid json", "utf8");

  const loaded = await readJsonFileWithBackup<Array<{ id: string }>>(filePath, []);
  assert.deepEqual(loaded, [{ id: "good_1" }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("readJsonFileWithBackup returns the fallback when nothing parseable exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-store-"));
  const filePath = path.join(dir, "missing.json");

  const loaded = await readJsonFileWithBackup<string[]>(filePath, ["fallback"]);
  assert.deepEqual(loaded, ["fallback"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("snapshotJsonStore copies an existing store and is a no-op when absent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-store-"));
  const filePath = path.join(dir, "jobs.json");

  await snapshotJsonStore(filePath); // absent: must not throw or create anything
  assert.equal((await fs.readdir(dir)).length, 0);

  await writeJsonFile(filePath, [{ id: "job_1" }]);
  await snapshotJsonStore(filePath);
  const snapshots = (await fs.readdir(dir)).filter((name) => name.includes(".snapshot"));
  assert.equal(snapshots.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

// redactEmbeddedMedia is the escape valve for documents that legitimately carry
// media inline -- workflow snapshots -- where refusing to write meant throwing
// away a render that was otherwise fine.

test("redactEmbeddedMedia replaces payloads but keeps the surrounding shape", () => {
  const graph = {
    "63": { inputs: { image: "data:image/png;base64,AQID", denoise: 0.4, title: "Load Image" } },
    "12": { inputs: { seed: 77 } },
  };
  const out = redactEmbeddedMedia(graph);

  assert.match(out["63"].inputs.image, /embedded media omitted/);
  // Everything that is not the payload has to survive, or the snapshot stops
  // answering the one question it exists for: which graph ran, with what.
  assert.equal(out["63"].inputs.denoise, 0.4);
  assert.equal(out["63"].inputs.title, "Load Image");
  assert.deepEqual(out["12"], { inputs: { seed: 77 } });
});

test("redactEmbeddedMedia never mutates its input", () => {
  const image = "data:image/png;base64,AQID";
  const graph = { node: { inputs: { image } } };
  const out = redactEmbeddedMedia(graph);

  assert.equal(graph.node.inputs.image, image, "the original must be left alone");
  assert.notEqual(out.node.inputs.image, image);
  assert.notEqual(out.node, graph.node, "nested objects are copied, not shared");
});

test("redactEmbeddedMedia drops raw oversized strings, not just data URLs", () => {
  // Inline still image presets write bare base64 with no data: prefix, so the
  // length check is what actually catches them.
  const out = redactEmbeddedMedia({ image: "A".repeat(200_000), keep: "A".repeat(10) });
  assert.match(out.image, /oversized value omitted/);
  assert.match(out.image, /KiB|MiB/);
  assert.equal(out.keep.length, 10);
});

test("redactEmbeddedMedia handles arrays and cycles", () => {
  const cyclic: Record<string, unknown> = { images: ["data:image/png;base64,AQID", "plain"] };
  cyclic.self = cyclic;
  const out = redactEmbeddedMedia(cyclic) as Record<string, unknown>;
  const images = out.images as string[];

  assert.match(images[0], /embedded media omitted/);
  assert.equal(images[1], "plain");
  // A cycle resolves to the same redacted copy instead of recursing forever.
  assert.equal(out.self, out);
});

test("a redacted graph passes the guard that rejected it before", () => {
  const graph = { node: { inputs: { image: "data:image/png;base64," + "A".repeat(300_000) } } };
  assert.throws(() => assertManifestRecordSafe(graph, "before"), /embedded media|oversized/i);
  // The same document, redacted, is now writable -- which is the whole point.
  assert.doesNotThrow(() => assertManifestRecordSafe(redactEmbeddedMedia(graph), "after"));
});
