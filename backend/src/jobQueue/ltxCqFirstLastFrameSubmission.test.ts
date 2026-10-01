import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-ltx-cq-flf-"));
const uploadRoot = path.join(tempRoot, "uploads");
await fs.mkdir(uploadRoot, { recursive: true });
process.env.UPLOADED_MEDIA_ROOT = uploadRoot;
process.env.LOCAL_PROJECTS_ROOT = path.join(tempRoot, "projects");
process.env.BRICK_PROJECTS_ROOT = path.join(tempRoot, "brick");
// Inputs go by signed app URL, which needs no network. The bucket keys are blanked
// so env.ts cannot fill them from the host's .env and upload fixtures to R2.
process.env.RUNPOD_INPUT_BASE_URL = "https://momi.test";
process.env.RUNPOD_INPUT_URL_SECRET = "flf-test-secret";
process.env.RUNPOD_INPUT_BUCKET_ENDPOINT_URL = "";
process.env.RUNPOD_INPUT_BUCKET_ACCESS_KEY_ID = "";
process.env.RUNPOD_INPUT_BUCKET_SECRET_ACCESS_KEY = "";
process.env.RUNPOD_ENDPOINT_ID_VIDEO_ENHANCER = "pod-ltx-cq-test";
process.env.RUNPOD_ENDPOINT_ID_LTX_CQ_I2V = "";

import assert from "node:assert/strict";
import test, { after } from "node:test";

import sharp from "sharp";

import type { Job } from "../types.js";

const { prepareRunpodSubmission } = await import("./runpodExecution.js");
const { ltxCqFlfWorkflowModel, LTX_CQ_FLF_MODEL_ID } = await import("../ltxCqFirstLastFrame.js");
const { resolveRunpodEndpoint } = await import("../runpodEndpoints.js");

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const media = (filePath: string) => `/api/media?path=${encodeURIComponent(filePath)}`;
const inputFolder = path.join(uploadRoot, "job-input");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_flf",
    projectId: "prj_1",
    userId: "usr_owner",
    modelId: LTX_CQ_FLF_MODEL_ID,
    modelName: "LTX 2.5 CQ First & Last Frame (Experimental)",
    category: "first_last_frame_to_video",
    inputType: "start_end_frames",
    status: "queued",
    prompt: "The camera glides from the lobby to the terrace.",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: 5,
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "video",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as Job;
}

const prepare = (value: Job) => prepareRunpodSubmission(value, ltxCqFlfWorkflowModel(), "project", inputFolder);

// A rotated JPEG and a transparent WebP: the two images arrive in different
// formats and are normalized independently.
const firstPath = path.join(uploadRoot, "lobby.jpg");
await sharp({ create: { width: 60, height: 40, channels: 3, background: "#336699" } })
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toFile(firstPath);
const lastPath = path.join(uploadRoot, "terrace.webp");
await sharp({ create: { width: 32, height: 18, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .webp({ lossless: true })
  .toFile(lastPath);
const notAnImage = path.join(uploadRoot, "notes.png");
await fs.writeFile(notAnImage, "not an image");

test("both frames are normalized on their own, named per job and role, and sent by URL", async () => {
  const prepared = await prepare(job({ inputImages: [media(firstPath), media(lastPath)] }));
  const graph = prepared.workflow as Record<string, { inputs: Record<string, unknown> }>;

  assert.deepEqual(prepared.runpodImages.imageNames, ["ltxflfcq-job_flf-first.png", "ltxflfcq-job_flf-last.png"]);
  assert.deepEqual(
    prepared.runpodImages.images.map((image) => image.name),
    prepared.runpodImages.imageNames,
  );
  for (const image of prepared.runpodImages.images) {
    assert.match(image.url ?? "", /^https:\/\/momi\.test\/api\/runpod-input\?token=/);
    assert.equal(image.image, undefined, "no inline copy alongside the URL");
  }
  assert.equal(graph.load_first_frame.inputs.image, "ltxflfcq-job_flf-first.png");
  assert.equal(graph.load_last_frame.inputs.image, "ltxflfcq-job_flf-last.png");
  assert.deepEqual([graph.video_latent.inputs.width, graph.video_latent.inputs.height, graph.video_latent.inputs.length], [1920, 1088, 121]);
  assert.equal(graph.save.inputs.filename_prefix, "momi/job_flf/FLF_CQ");
  assert.equal(prepared.runpodVideo, undefined);

  const first = await sharp(path.join(inputFolder, "job_flf_ltx_cq_first.png")).metadata();
  assert.deepEqual([first.format, first.width, first.height], ["png", 40, 60], "upright from its EXIF orientation");
  const last = await sharp(path.join(inputFolder, "job_flf_ltx_cq_last.png")).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([last.info.channels, ...last.data.subarray(0, 3)], [3, 255, 255, 255], "transparency laid on white");
});

test("a missing, unreadable or linked frame fails before anything is sent", async () => {
  await assert.rejects(prepare(job({ inputImages: [] })), /needs a first frame/);
  await assert.rejects(prepare(job({ inputImages: [media(firstPath)] })), /needs a last frame/);
  await assert.rejects(prepare(job({ inputImages: [media(firstPath), media(notAnImage)] })), /The last frame could not be decoded/);
  await assert.rejects(prepare(job({ inputImages: [media(notAnImage), media(lastPath)] })), /The first frame could not be decoded/);
  await assert.rejects(
    prepare(job({ inputImages: [media(firstPath), "https://cdn.example/terrace.png"] })),
    /last frame is missing or is not saved media/,
  );
});

test("invalid settings fail before either image is touched", async () => {
  const untouched = path.join(uploadRoot, "untouched-input");
  const inputs = [media(firstPath), media(lastPath)];
  const attempt = (overrides: Partial<Job>) =>
    prepareRunpodSubmission(job({ inputImages: inputs, ...overrides }), ltxCqFlfWorkflowModel(), "project", untouched);

  await assert.rejects(attempt({ resolution: { width: 3840, height: 2160, label: "4K" } }), /720p, 1080p, 1440p only/);
  await assert.rejects(attempt({ durationSeconds: 8 }), /2, 3, 4, 5 second/);
  await assert.rejects(attempt({ prompt: "   " }), /needs a prompt/);
  await assert.rejects(fs.access(untouched), /ENOENT/);
});

test("a resume re-polls without sending the images again", async () => {
  const prepared = await prepare(job({ runpodJobId: "rp_existing", inputImages: [media(firstPath), media(lastPath)] }));
  assert.deepEqual(prepared.runpodImages.images, []);
  assert.deepEqual(prepared.runpodImages.imageNames, ["ltxflfcq-job_flf-first.png", "ltxflfcq-job_flf-last.png"]);
  assert.equal((prepared.workflow as Record<string, { inputs: Record<string, unknown> }>).load_last_frame.inputs.image, "ltxflfcq-job_flf-last.png");
});

test("it runs on the CQ pod, which reports its own success", () => {
  const endpoint = resolveRunpodEndpoint({ modelId: LTX_CQ_FLF_MODEL_ID });
  const imageToVideo = resolveRunpodEndpoint({ modelId: "ltx25_cq_i2v" });
  assert.equal(endpoint.id, "pod-ltx-cq-test");
  assert.equal(imageToVideo.id, "pod-ltx-cq-test");
  assert.equal(endpoint.reportsWorkerSuccess, true);
});
