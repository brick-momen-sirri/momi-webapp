import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Job } from "./types.js";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-media-api-it-"));
const appStatePath = path.join(tempDir, "app-state.sqlite");

process.env.ROLE = "api";
process.env.APP_STATE_DRIVER = "sqlite";
process.env.APP_STATE_SQLITE_PATH = appStatePath;

const { openSqliteMediaIndexStore } = await import("./sqliteMediaIndexStore.js");
const externalStore = openSqliteMediaIndexStore(appStatePath);
externalStore.publish(1, [mediaJob("existing_from_dispatcher")]);
const mediaService = await import("./mediaService.js");

after(() => {
  mediaService.closeMediaIndex();
  externalStore.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may retain a WAL handle briefly; the OS temp directory is transient.
  }
});

test("API role consumes dispatcher media revisions without a filesystem scan", async () => {
  await mediaService.initializeMediaIndex();
  assert.deepEqual((await mediaService.scanExistingMediaJobs()).map((job) => job.id), ["existing_from_dispatcher"]);

  const revision = externalStore.invalidate();
  externalStore.publish(revision, [mediaJob("existing_after_refresh")]);
  assert.deepEqual((await mediaService.scanExistingMediaJobs()).map((job) => job.id), ["existing_after_refresh"]);
});

function mediaJob(id: string): Job {
  return {
    id,
    projectId: "prj_shared",
    userId: "unknown_user",
    modelId: "existing_project_media",
    modelName: "Existing media",
    category: "image_editing",
    inputType: "single_image",
    prompt: "Published by dispatcher",
    resolution: { width: 1, height: 1 },
    status: "completed",
    inputImages: [],
    resultUrls: [`/api/media?path=${encodeURIComponent(`C:\\projects\\${id}.png`)}`],
    thumbnailUrls: [],
    outputType: "image",
    projectFolderPath: "C:\\projects\\1000_Client_Project",
    workflowPath: "",
    source: "existing_project_media",
    createdAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:00:00.000Z",
  };
}
