import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-runpod-input-"));

process.env.RUNPOD_INPUT_BASE_URL = "https://backend.example";
process.env.RUNPOD_INPUT_URL_SECRET = "input-url-secret";
process.env.LOCAL_PROJECTS_ROOT = tempRoot;
process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";

const service = await import("./runpodInputUrlService.js");

test("creates and resolves signed RunPod input URLs for local media", async () => {
  const filePath = path.join(tempRoot, "project", "jobs", "job_1", "input", "reference.png");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "original-bytes");

  const url = service.createRunpodInputUrl(filePath, "image");
  assert.ok(url);
  assert.match(url, /^https:\/\/backend\.example\/api\/runpod-input\?token=/);

  const token = new URL(url).searchParams.get("token") ?? "";
  assert.deepEqual(service.resolveRunpodInputToken(token), {
    filePath: path.resolve(filePath),
    kind: "image",
  });
});

test("rejects tampered RunPod input tokens", async () => {
  const filePath = path.join(tempRoot, "project", "jobs", "job_2", "input", "reference.png");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "original-bytes");

  const url = service.createRunpodInputUrl(filePath, "image");
  const token = new URL(url ?? "").searchParams.get("token") ?? "";

  assert.equal(service.resolveRunpodInputToken(`${token}tampered`), undefined);
});
