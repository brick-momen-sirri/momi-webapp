import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertManifestRecordSafe, writeJsonFile } from "./storageService.js";

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

