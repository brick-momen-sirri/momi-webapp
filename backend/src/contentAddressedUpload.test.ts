import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

import { writeContentAddressedStream } from "./streamingMediaService.js";

const bytes = (text: string) => Readable.from([Buffer.from(text)]);
const sha = (text: string) => createHash("sha256").update(Buffer.from(text)).digest("hex");

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "momi-cas-"));
}

test("names the file after its sha256 and keeps the extension", async () => {
  const dir = await tempDir();
  const result = await writeContentAddressedStream(bytes("frame one"), dir, ".png", 1024);

  assert.equal(path.basename(result.filePath), `${sha("frame one")}.png`);
  assert.equal(result.bytesWritten, 9);
  assert.equal(result.deduplicated, false);
  assert.equal(await fs.readFile(result.filePath, "utf8"), "frame one");

  await fs.rm(dir, { recursive: true, force: true });
});

test("a re-upload of identical bytes reuses the stored file and writes nothing new", async () => {
  const dir = await tempDir();
  const first = await writeContentAddressedStream(bytes("same content"), dir, ".jpg", 1024);
  const before = await fs.stat(first.filePath);

  const second = await writeContentAddressedStream(bytes("same content"), dir, ".jpg", 1024);

  assert.equal(second.filePath, first.filePath, "same bytes must map to the same path");
  assert.equal(second.deduplicated, true);
  assert.equal(second.bytesWritten, 12, "still reports what the client sent");

  const after = await fs.stat(first.filePath);
  assert.equal(after.mtimeMs, before.mtimeMs, "stored file must not be rewritten");

  const entries = await fs.readdir(dir);
  assert.equal(entries.length, 1, "no second copy and no leftover .part");

  await fs.rm(dir, { recursive: true, force: true });
});

test("different content gets a different path", async () => {
  const dir = await tempDir();
  const a = await writeContentAddressedStream(bytes("alpha"), dir, ".png", 1024);
  const b = await writeContentAddressedStream(bytes("beta"), dir, ".png", 1024);

  assert.notEqual(a.filePath, b.filePath);
  assert.equal((await fs.readdir(dir)).length, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("oversized upload fails and leaves no partial file behind", async () => {
  const dir = await tempDir();
  await assert.rejects(writeContentAddressedStream(bytes("x".repeat(500)), dir, ".png", 100), /maximum allowed size/);

  assert.deepEqual(await fs.readdir(dir), [], "the .part file must be cleaned up");
  await fs.rm(dir, { recursive: true, force: true });
});

test("creates the project/user directory if it does not exist yet", async () => {
  const root = await tempDir();
  const nested = path.join(root, "prj_abc", "usr_def");
  const result = await writeContentAddressedStream(bytes("nested"), nested, ".mp4", 1024);

  assert.equal(path.dirname(result.filePath), nested);
  // The project id must remain the first segment under the root: the media read
  // guard derives the owning project from it.
  assert.equal(path.relative(root, result.filePath).split(path.sep)[0], "prj_abc");

  await fs.rm(root, { recursive: true, force: true });
});
