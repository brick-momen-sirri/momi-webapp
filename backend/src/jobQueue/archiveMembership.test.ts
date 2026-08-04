import assert from "node:assert/strict";
import test from "node:test";

import { buildJobListing } from "./archiveMembership.js";
import type { Job } from "../types.js";

test("active listing de-duplicates scanned media represented by generated results", () => {
  const generated = job("job_generated", "2026-08-04T12:00:00.000Z", {
    resultUrls: ["/api/media?path=C%3A%5Cproject%5Cresult.png"],
  });
  const duplicateScan = job("scan_duplicate", "2026-08-04T11:00:00.000Z", {
    source: "existing_project_media",
    resultUrls: ["/api/media?path=C%3A%5Cproject%5Cresult.png"],
  });
  const distinctScan = job("scan_distinct", "2026-08-04T10:00:00.000Z", {
    source: "existing_project_media",
    resultUrls: ["/api/media?path=C%3A%5Cproject%5Cother.png"],
  });

  const listing = buildJobListing({
    jobs: [generated],
    mediaJobs: [duplicateScan, distinctScan],
    archivedMediaJobs: [],
    archived: false,
    mediaFilePathFromUrl,
  });

  assert.deepEqual(
    listing.map((item) => item.id),
    ["job_generated", "scan_distinct"],
  );
});

test("archive listing combines archived generated/scanned rows and excludes active rows", () => {
  const active = job("active", "2026-08-04T13:00:00.000Z");
  const archivedGenerated = job("archived_generated", "2026-08-04T12:00:00.000Z", {
    archivedAt: "2026-08-04T14:00:00.000Z",
  });
  const archivedScan = job("archived_scan", "2026-08-04T11:00:00.000Z", { source: "existing_project_media" });

  const listing = buildJobListing({
    jobs: [active, archivedGenerated],
    mediaJobs: [],
    archivedMediaJobs: [archivedScan],
    archived: true,
    mediaFilePathFromUrl,
  });

  assert.deepEqual(
    listing.map((item) => [item.id, item.source]),
    [
      ["archived_generated", "backend_job"],
      ["archived_scan", "existing_project_media"],
    ],
  );
});

test("an archived scanned-media ID stays out of the active listing", () => {
  const scan = job("scan_1", "2026-08-04T11:00:00.000Z", { source: "existing_project_media" });
  const listing = buildJobListing({
    jobs: [],
    mediaJobs: [scan],
    archivedMediaJobs: [{ ...scan, archivedAt: "later" }],
    archived: false,
    mediaFilePathFromUrl,
  });
  assert.deepEqual(listing, []);
});

function mediaFilePathFromUrl(value: string) {
  const url = new URL(value, "http://127.0.0.1");
  return url.searchParams.get("path") ?? undefined;
}

function job(id: string, createdAt: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    projectId: "prj_1",
    userId: "usr_1",
    modelId: "model_1",
    modelName: "Model",
    category: "image_generation",
    inputType: "text_only",
    status: "completed",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "image",
    projectFolderPath: "C:\\project",
    workflowPath: "workflow.json",
    createdAt,
    ...overrides,
  };
}
