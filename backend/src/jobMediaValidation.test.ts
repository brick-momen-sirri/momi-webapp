import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { CreateJobRequest, Project, User } from "./types.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-job-media-"));
const projectsRoot = path.join(tempRoot, "projects");
const uploadsRoot = path.join(tempRoot, "uploads");
const projectRoot = path.join(projectsRoot, "1234_Client_Project");
const otherProjectRoot = path.join(projectsRoot, "9999_Other_Project");

process.env.LOCAL_PROJECTS_ROOT = projectsRoot;
process.env.BRICK_PROJECTS_ROOT = path.join(tempRoot, "brick-projects");
process.env.UPLOADED_MEDIA_ROOT = uploadsRoot;
process.env.RUNPOD_INLINE_MEDIA_MAX_BYTES = "16";

const { validateJobMediaReferences } = await import("./jobMediaValidation.js");

const user: User = {
  id: "usr_owner",
  name: "Owner",
  displayName: "Owner",
  email: "owner@example.com",
  role: "user",
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const project: Project = {
  id: "prj_safe",
  name: "Safe",
  shortName: "SAFE",
  folderPath: projectRoot,
  ownerId: user.id,
  members: [],
  groupMembers: [],
  jobCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

await fs.mkdir(path.join(projectRoot, "images"), { recursive: true });
await fs.mkdir(path.join(otherProjectRoot, "images"), { recursive: true });
await fs.mkdir(path.join(uploadsRoot, project.id, user.id), { recursive: true });
await fs.mkdir(path.join(uploadsRoot, project.id, "usr_other"), { recursive: true });

const ownedProjectFile = path.join(projectRoot, "images", "owned.png");
const otherProjectFile = path.join(otherProjectRoot, "images", "other.png");
const ownedUpload = path.join(uploadsRoot, project.id, user.id, "owned.jpg");
const otherUserUpload = path.join(uploadsRoot, project.id, "usr_other", "other.jpg");
for (const filePath of [ownedProjectFile, otherProjectFile, ownedUpload, otherUserUpload]) {
  await fs.writeFile(filePath, "bytes");
}

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("accepts project media, the caller's project upload, and public HTTPS media", async () => {
  await validate([
    mediaUrl(ownedProjectFile),
    mediaUrl(ownedUpload),
    "https://cdn.example/reference.webp",
    "data:image/png;base64,AQID",
  ]);
});

test("rejects another project's media and another user's raw upload", async () => {
  await assert.rejects(() => validate([mediaUrl(otherProjectFile)]), /not owned by this user or project/i);
  await assert.rejects(() => validate([mediaUrl(otherUserUpload)]), /not owned by this user or project/i);
});

test("rejects unsupported, malformed, oversized, and cross-kind data URLs", async () => {
  await assert.rejects(() => validate(["data:video/mp4;base64,AQID"]), /expected image media/i);
  await assert.rejects(() => validate(["data:image/png;base64,%%%"]), /malformed image data URL/i);
  await assert.rejects(() => validate([`data:image/png;base64,${Buffer.alloc(17).toString("base64")}`]), /larger than/i);
  await assert.rejects(() => validate(["blob:browser-only"]), /saved media or a public http/i);
});

test("rejects unsupported local extensions and encoded traversal", async () => {
  const executable = path.join(projectRoot, "images", "payload.exe");
  await fs.writeFile(executable, "MZ");
  await assert.rejects(() => validate([mediaUrl(executable)]), /unsupported image type/i);

  const traversal = `/api/media?path=${encodeURIComponent(projectRoot)}%2F..%2F9999_Other_Project%2Fimages%2Fother.png`;
  await assert.rejects(() => validate([traversal]), /invalid local .*media path/i);
});

test("validates video inputs independently from image inputs", async () => {
  await validate([], "data:video/mp4;base64,AQID");
  await assert.rejects(() => validate([], "data:image/png;base64,AQID"), /expected video media/i);
});

async function validate(inputImages: string[], inputVideo?: string) {
  const request: CreateJobRequest = {
    projectId: project.id,
    modelId: "model",
    userId: user.id,
    inputImages,
    inputVideo,
  };
  await validateJobMediaReferences(request, project, user);
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}
