import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteMediaIndexStore } from "./sqliteMediaIndexStore.js";
import type { Job } from "./types.js";

test("media dirty and published revisions are shared across connections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-media-index-"));
  const dbPath = path.join(dir, "app-state.sqlite");
  const a = openSqliteMediaIndexStore(dbPath);
  const b = openSqliteMediaIndexStore(dbPath);
  try {
    assert.deepEqual(a.loadState(), { dirtyRevision: 1, builtRevision: 0, publishedAt: undefined });
    assert.equal(a.publish(1, [job("existing_1")]), true);
    assert.deepEqual(b.loadPublishedIfNewer(-1)?.jobs.map((item) => item.id), ["existing_1"]);

    assert.equal(b.invalidate(), 2);
    assert.deepEqual(a.loadState().dirtyRevision, 2);
    assert.equal(a.publish(1, [job("stale")]), false);
    assert.equal(b.publish(2, [job("existing_2")]), true);
    assert.deepEqual(a.loadPublishedIfNewer(1)?.jobs.map((item) => item.id), ["existing_2"]);
  } finally {
    a.close();
    b.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("media index rejects embedded payloads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-media-index-guard-"));
  const store = openSqliteMediaIndexStore(path.join(dir, "app-state.sqlite"));
  try {
    assert.throws(
      () => store.publish(1, [{ ...job("existing_1"), resultUrls: ["data:image/png;base64,AAAA"] }]),
      /embedded media/i,
    );
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function job(id: string): Job {
  return {
    id,
    projectId: "prj_1",
    userId: "unknown_user",
    modelId: "existing_project_media",
    modelName: "Existing media",
    category: "image_editing",
    inputType: "single_image",
    prompt: "Existing file",
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
