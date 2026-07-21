import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistServerlessArtifacts } from "./serverlessArtifactService.js";
import type { RunpodMediaResult } from "./runpodComfyService.js";
import type { Job, Project, WorkflowModel } from "./types.js";

test("serverless video output under images is mirrored into Brick video folders and manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-serverless-artifacts-"));
  const projectFolder = path.join(root, "1234_TestOffice_TestProject");
  const project = makeProject(projectFolder);
  const model = makeModel();
  const job = makeJob(project, model);
  const media: RunpodMediaResult[] = [
    {
      url: "https://cdn.example/ComfyUI_00001_.mp4",
      filename: "ComfyUI_00001_.mp4",
      source: "images",
      type: "s3_url",
      isVideo: true,
    },
  ];
  const fetchImpl = async () => new Response(Buffer.from("video-bytes"), {
    headers: { "content-type": "video/mp4" },
  });

  const result = await persistServerlessArtifacts({
    project,
    job,
    model,
    media,
    selectedMedia: media,
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(result.resultUrls.length, 1);
  const savedPath = mediaPathFromUrl(result.resultUrls[0]);
  assert.match(savedPath, /videos[\\/]SHOT_0007[\\/]\d{8}_kling-v3-video_1234_SHOT_0007_v001\.mp4$/);
  assert.equal(await fs.readFile(savedPath, "utf8"), "video-bytes");

  const jobCopy = result.selectedArtifacts[0]?.jobFilePath;
  assert.ok(jobCopy);
  assert.equal(await fs.readFile(jobCopy, "utf8"), "video-bytes");

  const manifestPath = path.join(projectFolder, "metadata", "manifest.jsonl");
  const records = (await fs.readFile(manifestPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].asset_type, "video");
  assert.equal(records[0].source, "runpod_serverless");
  assert.equal(records[0].file_path, savedPath);
  assert.equal(records[0].runpod_job_id, "rp-123");
  assert.equal(records[0].prompt_id, "runpod:rp-123");
  assert.equal(records[0].credits_used, 12.5);

  const versions = JSON.parse(await fs.readFile(path.join(projectFolder, "metadata", "latest_versions.json"), "utf8"));
  assert.equal(versions["video|1234_TestOffice_TestProject|kling-v3-video|SHOT_0007"], 1);
});

test("dispatcher failover reserves unique versions while an older write is paused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-serverless-failover-"));
  const projectFolder = path.join(root, "1234_TestOffice_TestProject");
  const project = makeProject(projectFolder);
  const model = makeModel();
  const oldJob = { ...makeJob(project, model), id: "job-old", runpodJobId: "rp-old" };
  const newJob = { ...makeJob(project, model), id: "job-new", runpodJobId: "rp-new" };
  const oldMedia = videoMedia("https://cdn.example/old.mp4");
  const newMedia = videoMedia("https://cdn.example/new.mp4");
  let releaseOldWrite: (() => void) | undefined;

  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url).includes("old.mp4")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseOldWrite = () => {
            controller.enqueue(Buffer.from("old-video"));
            controller.close();
          };
        },
      });
      return new Response(body, { headers: { "content-type": "video/mp4" } });
    }
    return new Response(Buffer.from("new-video"), { headers: { "content-type": "video/mp4" } });
  };

  const oldPersist = persistServerlessArtifacts({
    project,
    job: oldJob,
    model,
    media: [oldMedia],
    selectedMedia: [oldMedia],
    fetchImpl: fetchImpl as typeof fetch,
  });
  await waitForReservation(projectFolder);

  const newResult = await persistServerlessArtifacts({
    project,
    job: newJob,
    model,
    media: [newMedia],
    selectedMedia: [newMedia],
    fetchImpl: fetchImpl as typeof fetch,
  });
  releaseOldWrite?.();
  const oldResult = await oldPersist;

  const oldPath = mediaPathFromUrl(oldResult.resultUrls[0]);
  const newPath = mediaPathFromUrl(newResult.resultUrls[0]);
  assert.notEqual(oldPath, newPath);
  assert.match(oldPath, /_v001\.mp4$/);
  assert.match(newPath, /_v002\.mp4$/);
  assert.equal(await fs.readFile(oldPath, "utf8"), "old-video");
  assert.equal(await fs.readFile(newPath, "utf8"), "new-video");

  const versions = JSON.parse(await fs.readFile(path.join(projectFolder, "metadata", "latest_versions.json"), "utf8"));
  assert.equal(versions["video|1234_TestOffice_TestProject|kling-v3-video|SHOT_0007"], 2);
  assert.equal((await recursiveFiles(projectFolder)).some((filePath) => filePath.endsWith(".momi-reservation")), false);
});

function videoMedia(url: string): RunpodMediaResult {
  return {
    url,
    filename: path.basename(new URL(url).pathname),
    source: "images",
    type: "s3_url",
    isVideo: true,
  };
}

async function waitForReservation(root: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await recursiveFiles(root)).some((filePath) => filePath.endsWith(".momi-reservation"))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the first artifact reservation.");
}

async function recursiveFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? recursiveFiles(fullPath) : [fullPath];
  }))).flat();
}

function mediaPathFromUrl(value: string) {
  const url = new URL(value, "http://127.0.0.1");
  const filePath = url.searchParams.get("path");
  assert.ok(filePath);
  return filePath;
}

function makeProject(folderPath: string): Project {
  return {
    id: "project-1",
    name: "Test Project",
    shortName: "TEST",
    folderPath,
    ownerId: "usr-test",
    members: [],
    groupMembers: [],
    jobCount: 0,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function makeModel(): WorkflowModel {
  return {
    id: "kling-v3-video",
    name: "Kling V3 Video",
    category: "image_to_video",
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\kling.json",
    requiredInputs: ["prompt", "single_image"],
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    outputType: "video",
  };
}

function makeJob(project: Project, model: WorkflowModel): Job {
  return {
    id: "job-test",
    runpodJobId: "rp-123",
    runpodStatus: "COMPLETED",
    projectId: project.id,
    userId: "usr-test",
    modelId: model.id,
    modelName: model.name,
    category: model.category,
    inputType: "single_image",
    prompt: "animated exterior",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: 5,
    workflowOptions: { save: { shotNumber: "0007" } },
    status: "running",
    inputImages: ["data:image/png;base64,AAA="],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "video",
    projectFolderPath: project.folderPath,
    workflowPath: model.workflowPath,
    workflowSnapshotPath: path.join(project.folderPath, "jobs", "job-test", "workflow.json"),
    creditsUsed: 12.5,
    creditUsage: {
      total_estimated_credits: 12.5,
      total_estimated_usd: 0.0592,
      source: "runpod_worker",
    },
    source: "backend_job",
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}
