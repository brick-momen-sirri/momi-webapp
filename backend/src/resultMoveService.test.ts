import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { moveResultFiles } from "./resultMoveService.js";
import type { Job, Project, ProjectFolder } from "./types.js";

test("moving a result renames its media and preserves job and credit metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-result-move-"));
  const project = makeProject(path.join(root, "1234_Client_Project"));
  const folders = makeFolders();
  const source = path.join(project.folderPath, "folders", folders[0].diskName, "images", "20260716", "result.png");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.join(project.folderPath, "folders", folders[1].diskName, "images"), { recursive: true });
  await fs.writeFile(source, "image-bytes", "utf8");
  const job = makeJob(project, folders[0].folderId, mediaUrl(source));

  const result = await moveResultFiles({
    project,
    job,
    destinationFolderId: folders[1].folderId,
    folders,
  });

  const destination = path.join(project.folderPath, "folders", folders[1].diskName, "images", "20260716", "result.png");
  assert.equal(await fs.readFile(destination, "utf8"), "image-bytes");
  await assert.rejects(fs.stat(source));
  assert.equal(mediaPath(result.job.resultUrls[0]), destination);
  assert.equal(mediaPath(result.job.thumbnailUrls[0]), destination);
  assert.equal(result.job.folderId, folders[1].folderId);
  assert.equal(result.job.folderName, folders[1].name);
  assert.equal(result.job.id, job.id);
  assert.equal(result.job.runpodJobId, job.runpodJobId);
  assert.deepEqual(result.job.creditUsage, job.creditUsage);
  assert.equal(result.job.creditsUsed, job.creditsUsed);

  await result.rollback();
  assert.equal(await fs.readFile(source, "utf8"), "image-bytes");
  await assert.rejects(fs.stat(destination));
});

test("moving a result fails before mutation when the destination would collide", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-result-move-collision-"));
  const project = makeProject(path.join(root, "1234_Client_Project"));
  const folders = makeFolders();
  const relative = path.join("videos", "SHOT_0001", "result.mp4");
  const source = path.join(project.folderPath, "folders", folders[0].diskName, relative);
  const destination = path.join(project.folderPath, "folders", folders[1].diskName, relative);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(source, "source", "utf8");
  await fs.writeFile(destination, "destination", "utf8");

  await assert.rejects(
    moveResultFiles({
      project,
      job: { ...makeJob(project, folders[0].folderId, mediaUrl(source)), outputType: "video" },
      destinationFolderId: folders[1].folderId,
      folders,
    }),
    /already exists in the destination/,
  );
  assert.equal(await fs.readFile(source, "utf8"), "source");
  assert.equal(await fs.readFile(destination, "utf8"), "destination");
});

test("moving a sequence moves the whole sequence directory to the project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-result-move-sequence-"));
  const project = makeProject(path.join(root, "1234_Client_Project"));
  const folders = makeFolders();
  const sequenceFolder = path.join(project.folderPath, "folders", folders[0].diskName, "sequences", "SHOT_0002");
  const firstFrame = path.join(sequenceFolder, "0001.png");
  const secondFrame = path.join(sequenceFolder, "0002.png");
  await fs.mkdir(sequenceFolder, { recursive: true });
  await fs.writeFile(firstFrame, "frame-one", "utf8");
  await fs.writeFile(secondFrame, "frame-two", "utf8");

  const result = await moveResultFiles({
    project,
    job: { ...makeJob(project, folders[0].folderId, mediaUrl(firstFrame)), outputType: "sequence" },
    destinationFolderId: null,
    folders,
  });

  const destinationFolder = path.join(project.folderPath, "sequences", "SHOT_0002");
  assert.equal(await fs.readFile(path.join(destinationFolder, "0001.png"), "utf8"), "frame-one");
  assert.equal(await fs.readFile(path.join(destinationFolder, "0002.png"), "utf8"), "frame-two");
  assert.equal(result.job.folderId, null);
  assert.equal(result.job.folderName, "Root");
  assert.equal(mediaPath(result.job.resultUrls[0]), path.join(destinationFolder, "0001.png"));
});

test("moving a result with a missing local reference is rejected without changing the job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-result-move-missing-"));
  const project = makeProject(path.join(root, "1234_Client_Project"));
  const folders = makeFolders();
  const missing = path.join(project.folderPath, "folders", folders[0].diskName, "images", "missing.png");
  const job = makeJob(project, folders[0].folderId, mediaUrl(missing));

  await assert.rejects(
    moveResultFiles({ project, job, destinationFolderId: folders[1].folderId, folders }),
    /Result file is missing/,
  );
  assert.equal(job.folderId, folders[0].folderId);
  assert.equal(job.resultUrls[0], mediaUrl(missing));
});

function makeProject(folderPath: string): Project {
  return {
    id: "project-1",
    name: "Project",
    shortName: "1234",
    folderPath,
    ownerId: "usr-test",
    members: [],
    groupMembers: [],
    jobCount: 1,
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:00.000Z",
  };
}

function makeFolders(): ProjectFolder[] {
  return [
    makeFolder("fld_source", "Source"),
    makeFolder("fld_destination", "Destination"),
  ];
}

function makeFolder(folderId: string, name: string): ProjectFolder {
  return {
    folderId,
    parentId: null,
    name,
    slug: name.toLowerCase(),
    diskName: `${folderId}_${name.toLowerCase()}`,
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:00.000Z",
    archived: false,
  };
}

function makeJob(project: Project, folderId: string, resultUrl: string): Job {
  return {
    id: "job-result",
    runpodJobId: "runpod-123",
    projectId: project.id,
    folderId,
    folderName: "Source",
    userId: "usr-test",
    modelId: "model-1",
    modelName: "Model",
    category: "image_editing",
    inputType: "text_only",
    prompt: "prompt",
    status: "completed",
    inputImages: [],
    resultUrls: [resultUrl],
    thumbnailUrls: [resultUrl],
    outputType: "image",
    projectFolderPath: project.folderPath,
    workflowPath: "workflow.json",
    creditsUsed: 42,
    creditUsage: { total_estimated_credits: 42, source: "runpod_worker" },
    source: "backend_job",
    createdAt: "2026-07-16T10:00:00.000Z",
    completedAt: "2026-07-16T10:01:00.000Z",
  };
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

function mediaPath(value: string) {
  return new URL(value, "http://127.0.0.1").searchParams.get("path");
}
