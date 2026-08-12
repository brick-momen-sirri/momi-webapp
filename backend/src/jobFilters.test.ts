import test from "node:test";
import assert from "node:assert/strict";

import { filterJobs, getJobSaveSearchValue, isVideoSaveJob, jobSection, normalizeJobSaveNumber } from "./jobFilters.js";
import type { Job } from "./types.js";

// This is what GET /api/jobs narrows on. A filter that drops a job the caller
// should have seen reads to an artist as "my render is missing".

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "proj_1",
    userId: "usr_a",
    modelName: "Nano Banana",
    category: "image_editing",
    inputType: "single_image",
    prompt: "a glass tower",
    status: "completed",
    outputType: "image",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

const noFilters = { projectId: "", folderId: "", source: "", status: "", outputType: "", q: "" };
const ids = (jobs: Job[]) => jobs.map((item) => item.id);

test("no filters keeps everything", () => {
  const jobs = [job({ id: "a" }), job({ id: "b" })];
  assert.deepEqual(ids(filterJobs(jobs, noFilters)), ["a", "b"]);
});

test("each scalar filter narrows on exact equality", () => {
  const jobs = [
    job({ id: "a", projectId: "proj_1", status: "completed", outputType: "image", source: "backend_job" }),
    job({ id: "b", projectId: "proj_2", status: "failed", outputType: "video", source: "existing_project_media" }),
  ];

  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, projectId: "proj_2" })), ["b"]);
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, status: "failed" })), ["b"]);
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, outputType: "video" })), ["b"]);
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, source: "backend_job" })), ["a"]);
});

test("an empty filter value means 'no filter', not 'match empty'", () => {
  // Every filter is a plain string, so "" has to mean unset -- otherwise a
  // missing query parameter would match nothing.
  const jobs = [job({ id: "a", status: "completed" })];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, status: "" })), ["a"]);
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, projectId: "" })), ["a"]);
});

test("folderId 'root' means jobs with no folder", () => {
  const jobs = [job({ id: "a", folderId: null }), job({ id: "b", folderId: "fld_1" })];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, folderId: "root" })), ["a"]);
});

test("a specific folderId matches only that folder", () => {
  const jobs = [job({ id: "a", folderId: null }), job({ id: "b", folderId: "fld_1" }), job({ id: "c", folderId: "fld_2" })];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, folderId: "fld_1" })), ["b"]);
});

const stillImage = { categoryId: "pro-upscaler", settings: { engine: "normal" } } as const;

test("a job's section is derived from its still image options", () => {
  assert.equal(jobSection(job()), "animation");
  assert.equal(jobSection(job({ workflowOptions: {} })), "animation");
  assert.equal(jobSection(job({ workflowOptions: { save: { cameraNumber: "12" } } })), "animation");
  assert.equal(jobSection(job({ workflowOptions: { stillImage } })), "still_images");
});

test("media scanned off disk stays in the animation list", () => {
  // Existing project media has no workflowOptions at all. It has always listed
  // under Animation and must keep doing so -- the section split is about where a
  // job was submitted from, and these were not submitted at all.
  assert.equal(jobSection(job({ source: "existing_project_media" })), "animation");
});

test("the section filter separates the two workspaces", () => {
  const jobs = [
    job({ id: "anim", workflowOptions: { save: { shotNumber: "0010" } } }),
    job({ id: "still", workflowOptions: { stillImage } }),
    job({ id: "scanned", source: "existing_project_media" }),
  ];

  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, section: "animation" })), ["anim", "scanned"]);
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, section: "still_images" })), ["still"]);
  // Unset means both, the same as every other filter here.
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, section: "" })), ["anim", "still", "scanned"]);
  assert.deepEqual(ids(filterJobs(jobs, noFilters)), ["anim", "still", "scanned"]);
});

test("an unknown section narrows to nothing rather than defaulting", () => {
  // A typo in the query parameter should read as an empty list, not as the
  // animation list quietly standing in for what was asked for.
  const jobs = [job({ id: "anim" }), job({ id: "still", workflowOptions: { stillImage } })];
  assert.deepEqual(filterJobs(jobs, { ...noFilters, section: "stillimages" }), []);
});

test("the section filter combines with the other filters", () => {
  const jobs = [
    job({ id: "a", projectId: "proj_1", workflowOptions: { stillImage } }),
    job({ id: "b", projectId: "proj_2", workflowOptions: { stillImage } }),
    job({ id: "c", projectId: "proj_1" }),
  ];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, section: "still_images", projectId: "proj_1" })), ["a"]);
});

test("dateDays keeps only jobs newer than the cutoff", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const jobs = [
    job({ id: "recent", createdAt: new Date(Date.now() - 1 * dayMs).toISOString() }),
    job({ id: "old", createdAt: new Date(Date.now() - 40 * dayMs).toISOString() }),
  ];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, dateDays: 7 })), ["recent"]);
  // Without the filter both survive, so the assertion above is about the cutoff
  // rather than about the fixture.
  assert.deepEqual(ids(filterJobs(jobs, noFilters)), ["recent", "old"]);
});

test("dateDays of 0 or undefined applies no cutoff", () => {
  const jobs = [job({ id: "old", createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() })];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, dateDays: 0 })), ["old"]);
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, dateDays: undefined })), ["old"]);
});

test("search matches across the fields an artist would type", () => {
  const jobs = [
    job({ id: "job_alpha", prompt: "a glass tower", modelName: "Nano Banana", fileName: "TWR_0001.png" }),
    job({ id: "job_beta", prompt: "a timber cabin", modelName: "Kling Video 2.6", fileName: "CAB_0002.mp4" }),
  ];

  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "timber" })), ["job_beta"], "prompt");
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "Kling" })), ["job_beta"], "model name");
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "TWR_0001" })), ["job_alpha"], "file name");
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "job_beta" })), ["job_beta"], "job id");
});

test("search is case-insensitive and matches nothing rather than everything", () => {
  const jobs = [job({ id: "a", prompt: "a glass tower" })];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "GLASS" })), ["a"]);
  assert.deepEqual(filterJobs(jobs, { ...noFilters, q: "zzznomatch" }), []);
});

test("search combines with the scalar filters rather than overriding them", () => {
  const jobs = [
    job({ id: "a", prompt: "a glass tower", status: "completed" }),
    job({ id: "b", prompt: "a glass tower", status: "failed" }),
  ];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "glass", status: "failed" })), ["b"]);
});

test("search finds a job by its save number and label", () => {
  const jobs = [
    job({
      id: "a",
      outputType: "image",
      category: "image_editing",
      workflowOptions: { save: { cameraNumber: "12" } },
    } as Partial<Job>),
    job({
      id: "b",
      outputType: "image",
      category: "image_editing",
      workflowOptions: { save: { cameraNumber: "99" } },
    } as Partial<Job>),
  ];
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "0012" })), ["a"]);
  // The label is searchable too, so typing "camera" surfaces the stills.
  assert.deepEqual(ids(filterJobs(jobs, { ...noFilters, q: "camera" })), ["a", "b"]);
});

test("normalizeJobSaveNumber pads, strips and truncates", () => {
  assert.equal(normalizeJobSaveNumber(7), "0007");
  assert.equal(normalizeJobSaveNumber("cam-12"), "0012");
  assert.equal(normalizeJobSaveNumber(123456), "1234");
  for (const value of [undefined, null, "", "abc"]) {
    assert.equal(normalizeJobSaveNumber(value), "0000");
  }
});

test("existing project media has no save number to search on", () => {
  const media = job({
    source: "existing_project_media",
    workflowOptions: { save: { cameraNumber: "12" } },
  } as Partial<Job>);
  // Scanned media was not produced by a tracked job, so it must not appear to
  // carry a save number of its own.
  assert.equal(getJobSaveSearchValue(media), "");
});

test("isVideoSaveJob requires positive evidence, so an absent outputType is not video", () => {
  // This used to return true for a missing outputType, via an `outputType !==
  // "image"` clause -- the one signal that fired on absence rather than presence,
  // and the only thing the frontend's equivalent disagreed with. An unknown output
  // type is not evidence of video, so it now falls to Camera on both sides.
  assert.equal(isVideoSaveJob(job({ outputType: undefined }) as never), false);
  assert.equal(isVideoSaveJob(job({ outputType: "image" }) as never), false);
  assert.equal(isVideoSaveJob(job({ outputType: "video" }) as never), true);
  assert.equal(isVideoSaveJob(job({ outputType: "sequence" }) as never), true);
});

test("isVideoSaveJob also keys off category, inputType and model name", () => {
  assert.equal(isVideoSaveJob(job({ outputType: "image", category: "i2v_video" }) as never), true);
  assert.equal(isVideoSaveJob(job({ outputType: "image", inputType: "video" }) as never), true);
  assert.equal(isVideoSaveJob(job({ outputType: "image", modelName: "Kling Video 2.6" }) as never), true);
  assert.equal(isVideoSaveJob(job({ outputType: "image", modelName: "Nano Banana" }) as never), false);
});

test("getJobSaveSearchValue prefers shot for video and camera for stills", () => {
  const save = { save: { shotNumber: "12", cameraNumber: "99" } } as Job["workflowOptions"];
  assert.equal(getJobSaveSearchValue(job({ outputType: "video", workflowOptions: save })), "0012");
  assert.equal(getJobSaveSearchValue(job({ outputType: "image", workflowOptions: save })), "0099");
  // Falls back to the other field when the preferred one is absent.
  assert.equal(
    getJobSaveSearchValue(
      job({ outputType: "video", workflowOptions: { save: { cameraNumber: "5" } } as Job["workflowOptions"] }),
    ),
    "0005",
  );
});

// --- Cross-side truth table -------------------------------------------------
//
// The same cases are asserted in src/utils/saveNumber.test.ts against
// isVideoLikeJob. Both predicates decide the same question -- this one picks the
// save number indexed for search, the frontend's picks the number displayed --
// and they drifted once already, so any change to one must fail the other.
//
// Keep the two tables identical. Field names differ across the two Job shapes
// (modelName/category here, modelType/backendCategory there); the CASES do not.
const VIDEO_TRUTH_TABLE: Array<{ name: string; job: Partial<Job>; isVideo: boolean }> = [
  { name: "explicit video output", job: { outputType: "video" }, isVideo: true },
  { name: "sequence output", job: { outputType: "sequence" }, isVideo: true },
  { name: "carries a video length", job: { outputType: undefined, durationSeconds: 5 }, isVideo: true },
  { name: "video input", job: { outputType: undefined, inputType: "video" }, isVideo: true },
  { name: "video in the category", job: { outputType: undefined, category: "i2v_video" }, isVideo: true },
  { name: "video in the model name", job: { outputType: undefined, modelName: "Kling Video 2.6" }, isVideo: true },
  { name: "explicit image output", job: { outputType: "image" }, isVideo: false },
  // The case the two sides disagreed on: no evidence either way is NOT video.
  { name: "no outputType and no other video signal", job: { outputType: undefined }, isVideo: false },
  { name: "image category and image model", job: { outputType: "image", category: "image_editing" }, isVideo: false },
];

for (const entry of VIDEO_TRUTH_TABLE) {
  test(`truth table: ${entry.name} -> ${entry.isVideo ? "Shot" : "Camera"}`, () => {
    const subject = job({ modelName: "Nano Banana", category: "image_editing", inputType: "single_image", ...entry.job });
    assert.equal(isVideoSaveJob(subject as never), entry.isVideo);
  });
}
