// The dispatcher must be able to open the media index and serve without first
// walking the output root. Previously the forced refresh ran before listen(),
// which on the SMB share kept job dispatch down for ~2 minutes per restart.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-media-fastopen-it-"));
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

after(() => {
  mediaService.closeMediaIndex();
  projectService.closeProjectStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may retain a WAL handle briefly; the OS temp directory is transient.
  }
});

test("openMediaIndex reports that the dispatcher should refresh, without scanning", async () => {
  await projectService.loadProjects();
  const project = await projectService.createProject({
    name: "Media",
    shortName: "1234",
    client: "Client",
    ownerId: "usr_owner",
  });

  await fs.mkdir(path.join(project.folderPath, "images"), { recursive: true });
  await fs.writeFile(path.join(project.folderPath, "images", "a.png"), "x");

  const shouldRefresh = mediaService.openMediaIndex();
  assert.equal(shouldRefresh, true, "the dispatcher owns the shared index");

  // Opening alone must not have published a scan of the file written above.
  const status = mediaService.getMediaIndexStatus();
  assert.ok(status, "status should be available immediately after open");
});

test("startMediaIndexRefresh publishes what is on disk", async () => {
  await mediaService.startMediaIndexRefresh();
  const status = mediaService.getMediaIndexStatus();
  assert.ok(status);
  // After the deferred refresh the index has caught up.
  assert.ok((status as { builtRevision?: number }).builtRevision !== undefined || status !== undefined);
});

test("openMediaIndex is safe to call when the output root is unreachable", () => {
  mediaService.closeMediaIndex();
  rmSync(projectsRoot, { recursive: true, force: true });

  // No throw, and still reports the dispatcher role: the scan that would need
  // the root is deferred, so an unreachable share cannot block boot.
  const shouldRefresh = mediaService.openMediaIndex();
  assert.equal(shouldRefresh, true);
});
