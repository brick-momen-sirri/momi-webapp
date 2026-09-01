// Boot must be able to serve the project list without touching the output
// root. These tests point BRICK_PROJECTS_ROOT at a path that does not exist,
// which stands in for an unreachable share: openProjectStore() must still
// return the persisted projects, and loadProjects() must be the only thing
// that needs the filesystem.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-fast-open-it-"));
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

after(() => {
  projectService.closeProjectStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold a WAL handle briefly; the OS temp directory is transient.
  }
});

test("openProjectStore returns persisted projects without reading the output root", async () => {
  // Seed one project through the normal path first.
  await projectService.loadProjects();
  const created = await projectService.createProject({
    name: "Seeded",
    shortName: "4242",
    client: "Client",
    ownerId: "usr_owner",
    members: [{ userId: "usr_owner", role: "owner", addedAt: new Date().toISOString() }],
  });
  assert.ok(created.id);

  projectService.closeProjectStore();

  // Now make the output root unreachable and re-open. A boot that depended on
  // the share would come back empty here.
  rmSync(projectsRoot, { recursive: true, force: true });

  const onOpen = projectService.openProjectStore();
  assert.ok(Array.isArray(onOpen), "openProjectStore should return the project list");
  assert.ok(
    onOpen.some((project) => project.id === created.id),
    "the persisted project must be visible before any filesystem reconciliation",
  );
  assert.equal(projectService.getProjects().some((p) => p.id === created.id), true);
});

test("openProjectStore is idempotent and keeps the list populated", () => {
  const first = projectService.getProjects().length;
  projectService.openProjectStore();
  projectService.openProjectStore();
  assert.equal(projectService.getProjects().length, first, "re-opening must not empty or duplicate the list");
});

test("loadProjects still reconciles and never leaves the store unset mid-flight", async () => {
  const before = projectService.getProjects().length;
  assert.ok(before > 0);

  const reconciled = await projectService.loadProjects();
  assert.ok(Array.isArray(reconciled));
  // The seeded project's folder was deleted above, but the row is row-owned and
  // must survive reconciliation rather than being dropped.
  assert.ok(projectService.getProjects().length >= before);
});
