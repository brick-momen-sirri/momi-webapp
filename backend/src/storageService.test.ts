import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertManifestRecordSafe, readJsonFileWithBackup, snapshotJsonStore, writeJsonFile } from "./storageService.js";

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

