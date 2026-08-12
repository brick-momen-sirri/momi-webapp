import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";

import express from "express";

import type { AuthenticatedRequest } from "./authMiddleware.js";
import { estimateWorkflowCredits } from "./creditEstimator.js";
import { createJobSubmissionHandler } from "./jobSubmissionRoute.js";
import type { CreateJobRequest, Job, Project, User, WorkflowModel } from "./types.js";

const users = {
  owner: user("usr_owner", "owner@example.com"),
  editor: user("usr_editor", "editor@example.com"),
  viewer: user("usr_viewer", "viewer@example.com"),
  outsider: user("usr_outsider", "outsider@example.com"),
  demo: user("usr_demo", "demo@brickvisual.com"),
};

const project: Project = {
  id: "prj_safe",
  name: "Safe Project",
  shortName: "SAFE",
  folderPath: "C:\\projects\\safe",
  ownerId: users.owner.id,
  members: [
    { userId: users.owner.id, role: "owner", addedAt: "2026-01-01T00:00:00.000Z", addedBy: users.owner.id },
    { userId: users.editor.id, role: "editor", addedAt: "2026-01-01T00:00:00.000Z", addedBy: users.owner.id },
    { userId: users.viewer.id, role: "viewer", addedAt: "2026-01-01T00:00:00.000Z", addedBy: users.owner.id },
  ],
  groupMembers: [],
  jobCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const model: WorkflowModel = {
  id: "safe_i2v",
  name: "Safe I2V",
  category: "image_to_video",
  workflowPath: "safe_i2v.json",
  requiredInputs: ["prompt", "single_image", "resolution"],
  supportedResolutions: ["720p", "1080p"],
  defaultResolution: "1080p",
  supportedDurations: [5, 10],
  defaultDurationSeconds: 5,
  requiresPrompt: true,
  requiresImage: true,
  requiresStartEndFrames: false,
  imageSlotCount: 1,
  outputType: "video",
  estimatedCredits: 42,
};

// Stands in for whatever graph a Still Images preset will resolve to once the
// ComfyUI workflows land. Deliberately permissive -- no required prompt, one
// nominal image slot -- so these tests exercise the preset rules rather than the
// generic model rules that happen to sit alongside them.
const stillModel: WorkflowModel = {
  id: "safe_still",
  name: "Safe Still",
  category: "image_upscaling",
  workflowPath: "safe_still.json",
  requiredInputs: ["single_image"],
  requiresPrompt: false,
  requiresImage: true,
  requiresStartEndFrames: false,
  outputType: "image",
  estimatedCredits: 8,
};

const repository: Job[] = [];
const queue: Job[] = [];
const createRequests: CreateJobRequest[] = [];
const mediaChecks: CreateJobRequest[] = [];
const providerTripwire = {
  calls: 0,
  submit(): never {
    this.calls += 1;
    throw new Error("TEST SAFETY TRIPWIRE: a provider submission was attempted");
  },
};
let currentUser = users.owner;
let creationError: Error | undefined;
let replayCreation = false;

const handler = createJobSubmissionHandler({
  getProject: (id) => (id === project.id ? project : undefined),
  getWorkflowModel: (id) => [model, stillModel].find((candidate) => candidate.id === id),
  canViewProject: (candidate, target) =>
    candidate.role === "admin" ||
    target.ownerId === candidate.id ||
    target.members.some((member) => member.userId === candidate.id),
  canCreateJobInProject: (candidate, target) =>
    candidate.role === "admin" ||
    target.members.some((member) => member.userId === candidate.id && (member.role === "owner" || member.role === "editor")),
  isDemoAccount: (candidate) => candidate.email === "demo@brickvisual.com",
  validateMedia: async (request) => {
    mediaChecks.push(request);
    if (request.inputImages?.some((value) => value === "blocked-media")) {
      throw new Error("Input image is not owned by this user or project.");
    }
  },
  createJob: async (request) => {
    createRequests.push(request);
    if (creationError) throw creationError;
    const jobModel = request.modelId === stillModel.id ? stillModel : model;
    const job: Job = {
      id: `job_fake_${createRequests.length}`,
      projectId: request.projectId,
      folderId: request.targetFolderId ?? null,
      userId: request.userId,
      modelId: jobModel.id,
      modelName: jobModel.name,
      category: jobModel.category,
      inputType: "single_image",
      prompt: request.prompt,
      resolution: request.resolution,
      durationSeconds: request.durationSeconds,
      workflowOptions: request.workflowOptions,
      status: "queued",
      inputImages: request.inputImages ?? [],
      inputVideo: request.inputVideo,
      resultUrls: [],
      thumbnailUrls: [],
      outputType: jobModel.outputType,
      projectFolderPath: project.folderPath,
      workflowPath: jobModel.workflowPath,
      creditsEstimated: estimateWorkflowCredits(jobModel, request.durationSeconds, request.resolution, request.workflowOptions),
      source: "backend_job",
      createdAt: "2026-08-04T12:00:00.000Z",
    };
    repository.push(job);
    queue.push(job);
    // The controlled queue deliberately never invokes providerTripwire.submit().
    return replayCreation ? { job, replayed: true } : job;
  },
});

const app = express();
app.use(express.json({ limit: "8kb" }));
app.use((req, _res, next) => {
  (req as AuthenticatedRequest).authUser = currentUser;
  next();
});
app.post("/api/jobs", handler);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
  res.status(Number.isInteger(status) && status >= 400 ? status : 500).json({ error: "Malformed request body." });
});

let server: http.Server;
let baseUrl: URL;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  currentUser = users.owner;
  creationError = undefined;
  replayCreation = false;
  repository.length = 0;
  queue.length = 0;
  createRequests.length = 0;
  mediaChecks.length = 0;
  providerTripwire.calls = 0;
});

test("creates, persists, and queues one owned job without invoking a provider", async () => {
  const response = await call({
    projectId: project.id,
    modelId: model.id,
    prompt: "  a safe animation  ",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: 5,
    inputImages: ["https://media.example/reference.png"],
    userId: "usr_attacker_override",
  });

  assert.equal(response.status, 201);
  assert.equal(repository.length, 1);
  assert.equal(queue.length, 1);
  assert.equal(createRequests.length, 1);
  assert.equal(mediaChecks.length, 1);
  assert.equal(repository[0].userId, users.owner.id);
  assert.equal(repository[0].creditsEstimated, estimateWorkflowCredits(model, 5, response.body.job.resolution));
  assert.equal(response.body.job.id, repository[0].id);
  assert.equal(providerTripwire.calls, 0);
});

test("validates and forwards a client request id, and reports a replay without creating a new contract", async () => {
  const clientRequestId = "req_route_1234567890";
  replayCreation = true;
  const response = await call({ ...validBody(), clientRequestId });

  assert.equal(response.status, 200);
  assert.equal(response.body.replayed, true);
  assert.equal(createRequests[0]?.clientRequestId, clientRequestId);

  const invalid = await call({ ...validBody(), clientRequestId: "short" });
  assert.equal(invalid.status, 400);
  assert.match(String(invalid.body.error), /clientRequestId/i);
});

test("allows a project editor but refuses a viewer and hides the project from an outsider", async () => {
  currentUser = users.editor;
  assert.equal((await call(validBody())).status, 201);

  currentUser = users.viewer;
  assert.deepEqual(await call(validBody()), { status: 403, body: { error: "Project editor access required." } });

  currentUser = users.outsider;
  assert.deepEqual(await call(validBody()), { status: 404, body: { error: "Project not found" } });
});

test("refuses demo users before any queue or media operation", async () => {
  currentUser = users.demo;
  const response = await call(validBody());
  assert.equal(response.status, 403);
  assert.equal(createRequests.length, 0);
  assert.equal(mediaChecks.length, 0);
});

test("rejects unknown projects and workflows", async () => {
  assert.equal((await call({ ...validBody(), projectId: "prj_missing" })).status, 404);
  assert.deepEqual(await call({ ...validBody(), modelId: "missing_model" }), {
    status: 400,
    body: { error: "Unknown workflow model: missing_model" },
  });
  assert.equal(createRequests.length, 0);
});

test("rejects missing required input, invalid duration, and invalid resolution", async () => {
  const cases: Array<[Partial<CreateJobRequest>, RegExp]> = [
    [{ prompt: "   " }, /prompt is required/i],
    [{ inputImages: [] }, /image is required/i],
    [{ durationSeconds: 7 }, /duration.*supported/i],
    [{ resolution: { width: 640, height: 640, label: "square" } }, /resolution.*supported/i],
  ];

  for (const [override, message] of cases) {
    const response = await call({ ...validBody(), ...override });
    assert.equal(response.status, 400);
    assert.match(String(response.body.error), message);
  }
  assert.equal(createRequests.length, 0);
});

test("rejects malformed field types and provider-specific options", async () => {
  const malformed = await call({ ...validBody(), inputImages: "not-an-array" });
  assert.equal(malformed.status, 400);
  assert.match(String(malformed.body.error), /inputImages must be an array/i);

  const providerOptions = await call({
    ...validBody(),
    workflowOptions: { nanoBanana: { aspectRatio: "not-a-ratio", outputCount: 9 } },
  });
  assert.equal(providerOptions.status, 400);
  assert.match(String(providerOptions.body.error), /nano banana/i);
  assert.equal(createRequests.length, 0);
});

test("propagates media ownership failures without creating observable state", async () => {
  const response = await call({ ...validBody(), inputImages: ["blocked-media"] });
  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /not owned/i);
  assert.equal(repository.length, 0);
  assert.equal(queue.length, 0);
});

test("does not publish queue state when creation or persistence reports a failure", async () => {
  creationError = new Error("Isolated repository write failed.");
  const response = await call(validBody());
  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /repository write failed/i);
  assert.equal(repository.length, 0);
  assert.equal(queue.length, 0);
  assert.equal(providerTripwire.calls, 0);
});

test("malformed JSON is a client error and never reaches the submission port", async () => {
  const response = await rawCall('{"projectId":');
  assert.equal(response.status, 400);
  assert.equal(createRequests.length, 0);
});

function validBody() {
  return {
    projectId: project.id,
    modelId: model.id,
    prompt: "a safe animation",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: 5,
    inputImages: ["https://media.example/reference.png"],
  };
}

function stillBody(stillImage: unknown, overrides: Record<string, unknown> = {}) {
  return {
    projectId: project.id,
    modelId: stillModel.id,
    inputImages: ["https://media.example/source.png"],
    workflowOptions: { stillImage },
    ...overrides,
  };
}

// -- still images ------------------------------------------------------------
//
// The end-to-end half of the preset rules. stillImageRequest.test.ts covers the
// normalizer case by case; these assert that the route actually runs it, that the
// normalized options are what reach createJob, and that a rejection is a 400 with
// the preset's own message rather than a generic one.

test("a still image submission persists the normalized options, not the caller's", async () => {
  const response = await call(
    stillBody({ categoryId: "pro-upscaler", settings: { upscale: "x4", enhancement: false, creativity: 40 } }),
  );

  assert.equal(response.status, 201);
  assert.equal(createRequests.length, 1);
  // creativity is hidden while enhancement is off, so it must not have survived;
  // engine was never sent, so its default must have been filled in.
  assert.deepEqual(createRequests[0].workflowOptions?.stillImage, {
    categoryId: "pro-upscaler",
    settings: { engine: "normal", upscale: "x4", enhancement: false },
  });
  assert.equal(providerTripwire.calls, 0);
});

test("still image options survive onto the created job", async () => {
  await call(stillBody({ categoryId: "general-enhancement", settings: { details: 1.5 } }, { prompt: "keep the brickwork" }));

  assert.equal(repository.length, 1);
  assert.equal(repository[0].workflowOptions?.stillImage?.categoryId, "general-enhancement");
  assert.equal(repository[0].workflowOptions?.stillImage?.settings.details, 1.5);
});

test("still image options coexist with the save numbers", async () => {
  // Normalizing stillImage must not drop the sibling keys it travels with -- the
  // camera number is what names the file on disk.
  const response = await call(
    stillBody(
      { categoryId: "pro-upscaler" },
      {
        workflowOptions: { stillImage: { categoryId: "pro-upscaler" }, save: { cameraNumber: "0012" } },
      },
    ),
  );

  assert.equal(response.status, 201);
  assert.equal(createRequests[0].workflowOptions?.save?.cameraNumber, "0012");
  assert.equal(createRequests[0].workflowOptions?.stillImage?.categoryId, "pro-upscaler");
});

test("an out-of-range setting is a 400 carrying the catalogue bounds", async () => {
  const response = await call(stillBody({ categoryId: "pro-upscaler", settings: { creativity: 99 } }));

  assert.equal(response.status, 400);
  assert.match(response.body.error, /must be between 10 and 40/);
  assert.equal(createRequests.length, 0, "a rejected request must never reach createJob");
  assert.equal(mediaChecks.length, 0, "and must be rejected before the media check");
});

test("an unknown preset and an unknown setting are both rejected", async () => {
  const badPreset = await call(stillBody({ categoryId: "super-upscaler" }));
  assert.equal(badPreset.status, 400);
  assert.match(badPreset.body.error, /not a known still image preset/);

  const badSetting = await call(stillBody({ categoryId: "pro-upscaler", settings: { upscaleee: "x4" } }));
  assert.equal(badSetting.status, 400);
  assert.match(badSetting.body.error, /Unsupported pro-upscaler setting/);
  assert.equal(createRequests.length, 0);
});

test("the preset's slot rule beats the model's static slot count", async () => {
  // Reference Generator needs two images. The model behind it declares no
  // imageSlotCount at all, so this rejection can only come from the preset.
  const short = await call(stillBody({ categoryId: "reference-generator" }));
  assert.equal(short.status, 400);
  assert.match(short.body.error, /needs exactly 2 input images; received 1/);

  const paired = await call(
    stillBody(
      { categoryId: "reference-generator" },
      { inputImages: ["https://media.example/a.png", "https://media.example/b.png"] },
    ),
  );
  assert.equal(paired.status, 201);
});

test("qwen edit's slot count follows the mode it was submitted with", async () => {
  const twoUp = { categoryId: "qwen-edit", settings: { mode: "edit", imageCount: "2" } };
  const short = await call(stillBody(twoUp, { prompt: "swap the cladding" }));
  assert.equal(short.status, 400);
  assert.match(short.body.error, /needs exactly 2 input images; received 1/);

  const paired = await call(
    stillBody(twoUp, {
      prompt: "swap the cladding",
      inputImages: ["https://media.example/a.png", "https://media.example/b.png"],
    }),
  );
  assert.equal(paired.status, 201);
});

test("a prompt sent to a promptless preset is rejected", async () => {
  const response = await call(stillBody({ categoryId: "pro-upscaler" }, { prompt: "make it dramatic" }));
  assert.equal(response.status, 400);
  assert.match(response.body.error, /does not take a prompt/);
});

test("animation media on a still image request is rejected", async () => {
  const response = await call(stillBody({ categoryId: "pro-upscaler" }, { inputVideo: "https://media.example/clip.mp4" }));
  assert.equal(response.status, 400);
  assert.match(response.body.error, /do not take an input video/);
  assert.equal(mediaChecks.length, 0);
});

test("stillImage is still governed by the workflowOptions allowlist", async () => {
  const response = await call(
    stillBody({ categoryId: "pro-upscaler" }, { workflowOptions: { stillImage: { categoryId: "pro-upscaler" }, sneaky: {} } }),
  );
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unsupported provider-specific workflow option: sneaky/);
});

test("an animation submission is unaffected by the still image path", async () => {
  const response = await call(validBody());
  assert.equal(response.status, 201);
  assert.equal(createRequests[0].workflowOptions, undefined);
});

async function call(body: unknown) {
  return rawCall(JSON.stringify(body));
}

function rawCall(body: string): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL("/api/jobs", baseUrl),
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function user(id: string, email: string): User {
  return {
    id,
    name: id,
    displayName: id,
    email,
    role: "user",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
