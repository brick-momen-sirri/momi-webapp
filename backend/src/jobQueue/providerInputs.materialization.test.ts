import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { Job, WorkflowModel } from "../types.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-provider-inputs-"));
const uploadRoot = path.join(tempDir, "uploads");
const workflowPath = path.join(tempDir, "workflow.json");
await fs.mkdir(uploadRoot, { recursive: true });
await fs.writeFile(
  workflowPath,
  JSON.stringify({
    "1": { class_type: "LoadImage", inputs: { image: "first.png" } },
    "2": { class_type: "LoadImage", inputs: { image: "second.png" } },
    "3": { class_type: "LoadVideo", inputs: { file: "source.mov" } },
  }),
);

process.env.UPLOADED_MEDIA_ROOT = uploadRoot;
process.env.LOCAL_PROJECTS_ROOT = path.join(tempDir, "projects");
process.env.BRICK_PROJECTS_ROOT = path.join(tempDir, "brick");
process.env.COMFY_ROOT = path.join(tempDir, "comfy");
process.env.RUNPOD_INPUT_BASE_URL = "";
process.env.RUNPOD_INLINE_MEDIA_MAX_BYTES = "1024";

const uploadRequests: string[] = [];
const fakeComfy = http.createServer((req, res) => {
  uploadRequests.push(req.url ?? "");
  req.resume();
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "stored.bin", subfolder: "inputs" }));
  });
});
fakeComfy.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => fakeComfy.once("listening", resolve));
const comfyUrl = `http://127.0.0.1:${(fakeComfy.address() as AddressInfo).port}`;

const { materializeComfyInputImages, materializeComfyInputVideo, materializeRunpodInputImages, materializeRunpodInputVideo } =
  await import("./providerInputs.js");

after(async () => {
  await new Promise<void>((resolve) => fakeComfy.close(() => resolve()));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("RunPod image inputs preserve workflow field names across data and public URL inputs", async () => {
  const result = await materializeRunpodInputImages(
    job({ inputImages: ["data:image/png;base64,AQID", "https://cdn.example/reference.jpg"] }),
    model,
  );

  assert.deepEqual(result.imageNames, ["first.png", "second.png"]);
  assert.equal(result.images[0].image, "data:image/png;base64,AQID");
  assert.equal(result.images[1].url, "https://cdn.example/reference.jpg");
  assert.equal("url" in result.images[0], false);
  assert.equal("image" in result.images[1], false);
});

test("local image input is read only from an allowed root and inlined without a public base URL", async () => {
  const localPath = path.join(uploadRoot, "prj_1", "usr_1", "reference.png");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, Buffer.from([1, 2, 3, 4]));

  const result = await materializeRunpodInputImages(job({ inputImages: [mediaUrl(localPath)] }), model);
  assert.equal(result.images[0].name, "first.png");
  assert.equal(result.images[0].image, "data:image/png;base64,AQIDBA==");
});

test("RunPod video mapping handles absent, inline, and public video inputs", async () => {
  assert.equal(await materializeRunpodInputVideo(job(), model, tempDir), undefined);

  const inline = await materializeRunpodInputVideo(job({ inputVideo: "data:video/mp4;base64,AQID" }), model, tempDir);
  assert.equal(inline?.videoName, "source.mov");
  assert.equal(inline?.videos[0].image, "data:video/mp4;base64,AQID");

  const remote = await materializeRunpodInputVideo(job({ inputVideo: "https://cdn.example/source.mp4" }), model, tempDir);
  assert.equal(remote?.videos[0].url, "https://cdn.example/source.mp4");
});

test("local Comfy materialization uploads data/local media and leaves remote URLs untouched", async () => {
  const localImage = path.join(uploadRoot, "prj_1", "usr_1", "image.jpg");
  const localVideo = path.join(uploadRoot, "prj_1", "usr_1", "video.webm");
  await fs.mkdir(path.dirname(localImage), { recursive: true });
  await fs.writeFile(localImage, Buffer.from([1, 2, 3]));
  await fs.writeFile(localVideo, Buffer.from([4, 5, 6]));

  const images = await materializeComfyInputImages(
    job({
      inputImages: ["data:image/png;base64,AQID", mediaUrl(localImage), "https://cdn.example/remote.png"],
    }),
    comfyUrl,
  );
  const video = await materializeComfyInputVideo(job({ inputVideo: mediaUrl(localVideo) }), comfyUrl);

  assert.deepEqual(images, ["inputs/stored.bin", "inputs/stored.bin", "https://cdn.example/remote.png"]);
  assert.equal(video, "inputs/stored.bin");
  assert.deepEqual(uploadRequests, ["/upload/image", "/upload/image", "/upload/image"]);
});

test("invalid provider inputs fail before any provider request", async () => {
  const before = uploadRequests.length;
  await assert.rejects(
    () => materializeRunpodInputImages(job({ inputImages: ["ftp://example/image.png"] }), model),
    /must be saved media.*data urls.*http/i,
  );
  await assert.rejects(
    () => materializeComfyInputImages(job({ inputImages: ["data:image/png,not-base64"] }), comfyUrl),
    /unsupported image data url/i,
  );
  await assert.rejects(
    () =>
      materializeRunpodInputVideo(
        job({ inputVideo: `data:video/mp4;base64,${Buffer.alloc(1025).toString("base64")}` }),
        model,
        tempDir,
      ),
    /too large.*json request/i,
  );
  assert.equal(uploadRequests.length, before);
});

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelId: model.id,
    modelName: model.name,
    category: model.category,
    inputType: "text_only",
    status: "queued",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: model.outputType,
    projectFolderPath: tempDir,
    workflowPath,
    createdAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

const model: WorkflowModel = {
  id: "test_video_workflow",
  name: "Test Video Workflow",
  category: "video_editing",
  workflowPath,
  requiredInputs: ["prompt", "single_image", "video"],
  supportedDurations: [5, 10],
  defaultDurationSeconds: 5,
  requiresPrompt: true,
  requiresImage: true,
  requiresStartEndFrames: false,
  outputType: "video",
  estimatedCredits: 1,
};
