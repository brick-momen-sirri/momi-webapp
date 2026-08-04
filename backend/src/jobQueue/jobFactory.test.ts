import assert from "node:assert/strict";
import test from "node:test";

import { buildQueuedJob } from "./jobFactory.js";
import type { CreateJobRequest, Project, ProjectFolder, WorkflowModel } from "../types.js";

test("builds the durable queued shape with normalized media, folder, duration, and credits", async () => {
  const request: CreateJobRequest = {
    projectId: "prj_1",
    targetFolderId: "fld_1",
    modelId: "model_1",
    userId: "usr_1",
    prompt: "a tower",
    durationSeconds: 9,
    resolution: { width: 1920, height: 1080, label: "1080p" },
    inputImages: ["data:image/png;base64,AQID"],
  };
  const prepared = { ...request, inputImages: ["/api/media?path=owned.png"] };
  const job = await buildQueuedJob(request, {
    getWorkflowModel: (id) => (id === model.id ? model : undefined),
    getProject: (id) => (id === project.id ? project : undefined),
    externalizeInputMedia: async (_project, jobId, value) => {
      assert.equal(jobId, "job_deterministic");
      assert.equal(value, request);
      return prepared;
    },
    loadProjectFolders: async () => folders,
    createJobId: () => "job_deterministic",
    now: () => "2026-08-04T12:00:00.000Z",
  });

  assert.equal(job.id, "job_deterministic");
  assert.equal(job.status, "queued");
  assert.equal(job.folderId, "fld_1");
  assert.equal(job.folderName, "Shots");
  assert.equal(job.durationSeconds, 10, "unsupported values retain the existing nearest-duration normalization");
  assert.deepEqual(job.inputImages, ["/api/media?path=owned.png"]);
  assert.equal(job.creditsEstimated, 42);
  assert.equal(job.createdAt, "2026-08-04T12:00:00.000Z");
});

test("rejects unknown models, projects, and archived target folders", async () => {
  const base: CreateJobRequest = { projectId: project.id, modelId: model.id, userId: "usr_1" };
  const deps = {
    getWorkflowModel: (id: string) => (id === model.id ? model : undefined),
    getProject: (id: string) => (id === project.id ? project : undefined),
    externalizeInputMedia: async (_project: Project, _jobId: string, request: CreateJobRequest) => request,
    loadProjectFolders: async () => folders,
    createJobId: () => "job_1",
    now: () => "now",
  };

  await assert.rejects(() => buildQueuedJob({ ...base, modelId: "missing" }, deps), /unknown workflow model/i);
  await assert.rejects(() => buildQueuedJob({ ...base, projectId: "missing" }, deps), /unknown project/i);
  await assert.rejects(() => buildQueuedJob({ ...base, targetFolderId: "fld_archived" }, deps), /target folder not found/i);
});

const model: WorkflowModel = {
  id: "model_1",
  name: "Model",
  category: "image_generation",
  workflowPath: "workflow.json",
  requiredInputs: ["prompt"],
  supportedDurations: [5, 10],
  defaultDurationSeconds: 5,
  requiresPrompt: true,
  requiresImage: false,
  requiresStartEndFrames: false,
  outputType: "image",
  estimatedCredits: 42,
};

const project: Project = {
  id: "prj_1",
  name: "Project",
  shortName: "PRJ",
  folderPath: "C:\\projects\\one",
  ownerId: "usr_1",
  members: [],
  groupMembers: [],
  jobCount: 0,
  createdAt: "now",
  updatedAt: "now",
};

const folders: ProjectFolder[] = [
  {
    folderId: "fld_1",
    parentId: null,
    name: "Shots",
    slug: "shots",
    diskName: "fld_1_Shots",
    createdAt: "now",
    updatedAt: "now",
    archived: false,
  },
  {
    folderId: "fld_archived",
    parentId: null,
    name: "Old",
    slug: "old",
    diskName: "fld_archived_Old",
    createdAt: "now",
    updatedAt: "now",
    archived: true,
  },
];
