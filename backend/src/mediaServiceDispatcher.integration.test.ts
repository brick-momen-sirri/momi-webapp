import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-media-dispatcher-it-"));
const projectsRoot = path.join(tempDir, "brick-projects");
const projectsJsonPath = path.join(tempDir, "projects.json");
const appStatePath = path.join(tempDir, "app-state.sqlite");

process.env.ROLE = "monolith";
process.env.APP_STATE_DRIVER = "sqlite";
process.env.APP_STATE_SQLITE_PATH = appStatePath;
process.env.PROJECTS_STORE_PATH = projectsJsonPath;
process.env.BRICK_PROJECTS_ROOT = projectsRoot;
process.env.LOCAL_PROJECTS_ROOT = path.join(tempDir, "local-projects");
process.env.MEDIA_INDEX_REFRESH_MS = "100";

writeFileSync(projectsJsonPath, "[]", "utf8");

const projectService = await import("./projectService.js");
const mediaService = await import("./mediaService.js");
const { openSqliteMediaIndexStore } = await import("./sqliteMediaIndexStore.js");
let externalStore: ReturnType<typeof openSqliteMediaIndexStore> | undefined;

after(() => {
  externalStore?.close();
  mediaService.closeMediaIndex();
  projectService.closeProjectStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may retain a WAL handle briefly; the OS temp directory is transient.
  }
});

test("dispatcher publishes dirty filesystem media while clean reads stay indexed", async () => {
  await projectService.loadProjects();
  const project = await projectService.createProject({
    name: "Media",
    shortName: "1234",
    client: "Client",
    ownerId: "usr_owner",
  });
  await mediaService.initializeMediaIndex();
  externalStore = openSqliteMediaIndexStore(appStatePath);

  const firstPath = path.join(project.folderPath, "images", "first.png");
  await fs.writeFile(firstPath, "first-image", "utf8");
  externalStore.invalidate();
  await waitForPublishedFiles(["first.png"]);

  const firstPublished = await mediaService.scanExistingMediaJobs();
  assert.equal(firstPublished.length, 1);
  assert.equal(firstPublished[0]?.fileName, "first.png");
  assert.equal(externalStore.loadPublishedIfNewer(0)?.jobs[0]?.fileName, "first.png");

  const secondPath = path.join(project.folderPath, "images", "second.png");
  await fs.writeFile(secondPath, "second-image", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await mediaService.scanExistingMediaJobs()).length, 1);

  externalStore.invalidate();
  await waitForPublishedFiles(["first.png", "second.png"]);
  assert.deepEqual(
    (await mediaService.scanExistingMediaJobs()).map((job) => job.fileName).sort(),
    ["first.png", "second.png"],
  );
});

async function waitForPublishedFiles(expected: string[]) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const names = externalStore?.loadPublishedIfNewer(-1)?.jobs.map((job) => job.fileName).sort() ?? [];
    if (JSON.stringify(names) === JSON.stringify([...expected].sort())) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for published media: ${expected.join(", ")}`);
}
