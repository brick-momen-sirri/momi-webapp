import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProjectFolder,
  ensureProjectMetadata,
  renameProjectFolder,
  renameProjectOnDisk,
  validateDisplayName,
} from "./projectMetadataService.js";
import type { Project } from "./types.js";

test("project folder metadata keeps folder IDs stable across rename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-project-folders-"));
  const projectRoot = path.join(root, "1234_Client_Test_Project");
  const project = await ensureProjectMetadata(makeProject(projectRoot));

  const folder = await createProjectFolder(project, { name: "Final Selects" }, "usr-admin");
  const oldFilePath = path.join(projectRoot, "folders", folder.diskName, "images", "result.png");
  await fs.writeFile(oldFilePath, "image-bytes", "utf8");

  const renamed = await renameProjectFolder(project, folder.folderId, { name: "Approved Shots" }, "usr-admin");

  assert.equal(renamed.folderId, folder.folderId);
  assert.equal(renamed.name, "Approved Shots");
  assert.match(renamed.diskName, new RegExp(`^${folder.folderId}_approved-shots$`));
  await assert.rejects(fs.stat(path.join(projectRoot, "folders", folder.diskName)));
  assert.equal(await fs.readFile(path.join(projectRoot, "folders", renamed.diskName, "images", "result.png"), "utf8"), "image-bytes");

  const foldersFile = JSON.parse(await fs.readFile(path.join(projectRoot, "metadata", "folders.json"), "utf8"));
  assert.equal(foldersFile.folders[0].folderId, folder.folderId);
  assert.equal(foldersFile.folders[0].diskName, renamed.diskName);
});

test("project rename changes disk path without changing project ID", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-project-rename-"));
  const projectRoot = path.join(root, "1234_Client_Test_Project");
  const project = await ensureProjectMetadata(makeProject(projectRoot));

  const result = await renameProjectOnDisk(project, { client: "Client", name: "District Two" }, "usr-admin");

  assert.equal(result.metadata.projectId, project.id);
  assert.equal(result.folderName, "1234_Client_District_Two");
  await assert.rejects(fs.stat(projectRoot));
  const metadata = JSON.parse(await fs.readFile(path.join(result.folderPath, "metadata", "project.json"), "utf8"));
  assert.equal(metadata.projectId, project.id);
  assert.deepEqual(metadata.renamedFrom, ["1234_Client_Test_Project"]);
});

test("display name validation rejects Windows-dangerous names", () => {
  assert.throws(() => validateDisplayName("../escape"), /invalid filesystem characters/);
  assert.throws(() => validateDisplayName("CON"), /reserved by Windows/);
  assert.throws(() => validateDisplayName("bad:name"), /invalid filesystem characters/);
});

function makeProject(folderPath: string): Project {
  return {
    id: "proj_1234_stable",
    name: "Test Project",
    shortName: "1234",
    folderName: path.basename(folderPath),
    folderPath,
    ownerId: "usr-admin",
    members: [],
    groupMembers: [],
    jobCount: 0,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
  };
}
