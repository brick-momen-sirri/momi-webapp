import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-project-service-it-"));
const projectsRoot = path.join(tempDir, "brick-projects");
const projectsJsonPath = path.join(tempDir, "projects.json");
const appStatePath = path.join(tempDir, "app-state.sqlite");

process.env.APP_STATE_DRIVER = "sqlite";
process.env.APP_STATE_SQLITE_PATH = appStatePath;
process.env.PROJECTS_STORE_PATH = projectsJsonPath;
process.env.BRICK_PROJECTS_ROOT = projectsRoot;
process.env.LOCAL_PROJECTS_ROOT = path.join(tempDir, "local-projects");

writeFileSync(projectsJsonPath, "[]", "utf8");

const projectService = await import("./projectService.js");
const { openSqliteProjectStore } = await import("./sqliteProjectStore.js");
let externalStore: ReturnType<typeof openSqliteProjectStore> | undefined;

after(() => {
  externalStore?.close();
  projectService.closeProjectStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may retain a WAL handle briefly; the OS temp directory is transient.
  }
});

test("projectService observes cross-connection ACL, folder, and rename changes", async () => {
  await projectService.loadProjects();
  externalStore = openSqliteProjectStore(appStatePath);

  const created = await projectService.createProject({
    name: "Original",
    shortName: "1234",
    client: "Client",
    ownerId: "usr_owner",
    members: [{
      userId: "usr_owner",
      role: "owner",
      addedAt: "2026-07-21T00:00:00.000Z",
      addedBy: "usr_owner",
    }],
  });
  assert.equal(externalStore.loadProjectById(created.id)?.folderPath, created.folderPath);

  externalStore.applyToProject(created.id, (project) => {
    project.members.push({
      userId: "usr_viewer",
      role: "viewer",
      addedAt: "2026-07-21T01:00:00.000Z",
      addedBy: "usr_owner",
    });
    project.updatedAt = "2026-07-21T01:00:00.000Z";
  });
  assert.equal(projectService.getProject(created.id)?.members.some((item) => item.userId === "usr_viewer"), true);

  const folder = await projectService.createProjectFolder(created.id, { name: "Concepts" }, "usr_owner");
  assert.ok(folder);
  assert.equal(externalStore.loadProjectById(created.id)?.folders?.some((item) => item.folderId === folder?.folderId), true);

  const renamed = await projectService.renameProject(created.id, { name: "Renamed" }, "usr_owner");
  assert.ok(renamed);
  const externallyRenamed = externalStore.loadProjectById(created.id);
  assert.equal(externallyRenamed?.folderName, "1234_Client_Renamed");
  assert.equal(externallyRenamed?.members.some((item) => item.userId === "usr_viewer"), true);

  externalStore.applyToProject(created.id, (project) => {
    project.members = project.members.filter((item) => item.userId !== "usr_viewer");
    project.members.push({
      userId: "usr_recovery",
      role: "editor",
      addedAt: "2026-07-21T02:00:00.000Z",
      addedBy: "usr_owner",
    });
    project.updatedAt = "2026-07-21T02:00:00.000Z";
  });
  assert.equal(projectService.getProject(created.id)?.members.some((item) => item.userId === "usr_viewer"), false);

  // Simulate a crash after the directory rename but before the path row commit.
  externalStore.applyToProject(created.id, (project) => {
    project.name = "Original";
    project.folderName = "1234_Client_Original";
    project.diskName = project.folderName;
    project.folderPath = created.folderPath;
    project.updatedAt = "2026-07-21T03:00:00.000Z";
  });
  projectService.closeProjectStore();
  await projectService.loadProjects();
  const recovered = projectService.getProject(created.id);
  assert.equal(recovered?.folderName, "1234_Client_Renamed");
  assert.equal(recovered?.members.some((item) => item.userId === "usr_recovery"), true);

  assert.equal(readFileSync(projectsJsonPath, "utf8"), "[]");
});
