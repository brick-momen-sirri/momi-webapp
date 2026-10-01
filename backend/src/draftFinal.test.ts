import assert from "node:assert/strict";
import test from "node:test";

import type { Request, Response } from "express";

import { estimateWorkflowCredits } from "./creditEstimator.js";
import {
  buildDraftFinalWorkflow,
  detectJobDraft,
  draftFinalRefusal,
  draftFinalRequest,
  isDraftTaskIdText,
  SEEDANCE_DRAFT_VALID_MS,
} from "./draftFinal.js";
import { draftFinalModelId, draftFinalWorkflowModel, parseDraftFinalModelId } from "./draftFinalModels.js";
import { createJobSubmissionHandler } from "./jobSubmissionRoute.js";
import { SEEDANCE_DRAFT_TASK_FILENAME_PREFIX } from "./seedanceVersions.js";
import type { CreateJobRequest, Job, Project, User, WorkflowModel } from "./types.js";
import { getWorkflowModel, loadWorkflowForRunpod, loadWorkflowModels } from "./workflowService.js";

await loadWorkflowModels();

const NOW = new Date("2026-09-30T12:00:00.000Z");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_draft",
    projectId: "prj_a",
    folderId: "fld_shot",
    userId: "usr_artist",
    modelId: "brick_api_seedance2_0_i2v",
    modelName: "Seedance",
    category: "image_to_video",
    inputType: "single_image",
    prompt: "the camera drifts toward the lobby",
    resolution: { width: 854, height: 480, label: "480p" },
    durationSeconds: 8,
    workflowOptions: { seedance: { version: "2.5-draft", ratio: "16:9", generateAudio: false } },
    status: "completed",
    inputImages: ["/api/media?path=frame.png"],
    resultUrls: ["/api/media?path=draft.mp4"],
    thumbnailUrls: [],
    outputType: "video",
    projectFolderPath: "C:/projects/a",
    workflowPath: "workflow/i2v/x.json",
    createdAt: "2026-09-30T11:50:00.000Z",
    completedAt: "2026-09-30T11:55:00.000Z",
    textArtifacts: [{ text: "cgt-20260930115500-abcd\n", filename: `${SEEDANCE_DRAFT_TASK_FILENAME_PREFIX}_00001_.txt`, source: "texts" }],
    ...overrides,
  };
}

function withDraft(source: Job) {
  return { ...source, draft: detectJobDraft(source, NOW) };
}

test("a Seedance 2.5 Draft graph saves the draft task id, and no other version does", async () => {
  for (const [modelId, classType] of [
    ["brick_api_seedance2_0_i2v", "ByteDance2ReferenceNodeV2"],
    ["brick_api_seedance_2_0flf2v", "ByteDance2FirstLastFrameNode"],
    ["brick_api_seedance2_0_r2v", "ByteDance2ReferenceNodeV2"],
  ] as const) {
    const model = getWorkflowModel(modelId) as WorkflowModel;
    assert.ok(model, modelId);
    const images = model.requiresStartEndFrames ? ["a.png", "b.png"] : ["a.png"];
    const base: CreateJobRequest = {
      projectId: "prj_a",
      modelId,
      prompt: "a prompt",
      resolution: { width: 854, height: 480, label: "480p" },
      durationSeconds: 6,
      inputImages: images,
      inputVideo: model.requiredInputs.includes("video") ? "clip.mp4" : undefined,
      userId: "usr_a",
    };

    const draftGraph = (await loadWorkflowForRunpod(
      model,
      { ...base, workflowOptions: { seedance: { version: "2.5-draft", generateAudio: false } } },
      "0000_base",
      images,
    )) as Record<string, any>;
    const [sourceId, source] = Object.entries(draftGraph).find(([, node]) => node.class_type === classType) ?? [];
    assert.ok(source, `${modelId}: no ${classType}`);
    assert.equal(source.inputs.model, "Seedance 2.5 Draft");
    assert.equal(source.inputs["model.resolution"], "480p");
    const capture = Object.values(draftGraph).find((node: any) => node.class_type === "SaveStringKJ") as any;
    assert.ok(capture, `${modelId}: the draft id is not saved`);
    assert.deepEqual(capture.inputs.string, [sourceId, 1]);
    assert.equal(capture.inputs.filename_prefix, SEEDANCE_DRAFT_TASK_FILENAME_PREFIX);

    // The node refuses any other model with that output connected, so it must go.
    const finalGraph = (await loadWorkflowForRunpod(
      model,
      { ...base, resolution: { width: 1920, height: 1080, label: "1080p" }, workflowOptions: { seedance: { version: "2.5" } } },
      "0000_base",
      images,
    )) as Record<string, any>;
    assert.ok(!Object.values(finalGraph).some((node: any) => node.class_type === "SaveStringKJ"), modelId);
  }
});

test("a completed draft is recognized from what the worker returned", () => {
  const seedance = detectJobDraft(job(), NOW);
  assert.deepEqual(seedance, {
    kind: "seedance-2.5-draft",
    taskId: "cgt-20260930115500-abcd",
    createdAt: "2026-09-30T11:55:00.000Z",
    expiresAt: new Date(Date.parse("2026-09-30T11:55:00.000Z") + SEEDANCE_DRAFT_VALID_MS).toISOString(),
  });
  // A draft that came back without its id cannot be finalized, so it is not one.
  assert.equal(detectJobDraft(job({ textArtifacts: [] }), NOW), undefined);
  // An ordinary 2.5 render is not a draft even with a stray text artifact.
  assert.equal(detectJobDraft(job({ workflowOptions: { seedance: { version: "2.5" } } }), NOW), undefined);

  const minimax = job({
    modelId: "brick_api_minimax_h3_i2v",
    workflowOptions: {},
    textArtifacts: [],
    resolution: { width: 1366, height: 768, label: "768P" },
  });
  assert.equal(detectJobDraft(minimax, NOW)?.kind, "minimax-h3-768p");
  assert.equal(detectJobDraft({ ...minimax, resolution: { width: 2560, height: 1440, label: "2K" } }, NOW), undefined);
  // H3 Max has no Regenerate step.
  assert.equal(detectJobDraft({ ...minimax, modelId: "brick_api_minimax_h3_max_i2v" }, NOW), undefined);
});

test("the saved id is not left standing as the job's generated prompt", () => {
  const draft = withDraft(job());
  assert.equal(isDraftTaskIdText(draft, "cgt-20260930115500-abcd"), true);
  assert.equal(isDraftTaskIdText(draft, "a real generated prompt"), false);
});

test("a Seedance draft stops being finalizable before its 7 days are up", () => {
  const draft = withDraft(job());
  assert.equal(draftFinalRefusal(draft, NOW), undefined);
  const late = new Date(Date.parse(draft.draft?.expiresAt ?? "") - 10 * 60 * 1000);
  assert.match(draftFinalRefusal(draft, late) ?? "", /7 days/);
  assert.match(draftFinalRefusal({ ...draft, status: "running" }, NOW) ?? "", /completed/);
  assert.match(draftFinalRefusal({ ...draft, draft: undefined }, NOW) ?? "", /not a draft/);
});

test("a final request is built from the draft, not from anything the client sent", () => {
  const draft = withDraft(job());
  const finalModelId = draftFinalModelId("seedance-2.5-draft", "image_to_video");
  const built = draftFinalRequest(draft, finalModelId, "usr_other", { clientRequestId: "final_0123456789abcdef" }, NOW);
  assert.equal(built.modelId, "draft_final_seedance_2_5_i2v");
  assert.equal(built.prompt, draft.prompt);
  assert.equal(built.durationSeconds, 8);
  assert.deepEqual(built.resolution, { width: 1920, height: 1080, label: "1080p" });
  assert.equal(built.targetFolderId, "fld_shot");
  assert.equal(built.userId, "usr_other");
  assert.deepEqual(built.workflowOptions?.draftFinal, {
    sourceJobId: "job_draft",
    kind: "seedance-2.5-draft",
    taskId: "cgt-20260930115500-abcd",
  });
  assert.equal(built.inputImages, undefined);

  assert.throws(
    () => draftFinalRequest(draft, draftFinalModelId("seedance-2.5-draft", "video_editing"), "usr_other", {}, NOW),
    /finalized with draft_final_seedance_2_5_i2v/,
  );
  assert.throws(
    () => draftFinalRequest(draft, draftFinalModelId("minimax-h3-768p", "image_to_video"), "usr_other", {}, NOW),
    /not draft_final_minimax/,
  );
});

test("a MiniMax final re-sends the draft's inputs, its result and its reference clip", () => {
  const reference = withDraft(
    job({
      modelId: "brick_api_minimax_h3_r2v",
      category: "video_editing",
      workflowOptions: { save: { cameraNumber: "0042", shotNumber: "0042" } },
      textArtifacts: [],
      resolution: { width: 1366, height: 768, label: "768P" },
      inputImages: ["/api/media?path=subject.png"],
      inputVideo: "/api/media?path=motion.mp4",
    }),
  );
  const built = draftFinalRequest(reference, "draft_final_minimax_h3_2k_r2v", "usr_artist", {}, NOW);
  assert.deepEqual(built.inputImages, ["/api/media?path=subject.png"]);
  assert.equal(built.inputVideo, "/api/media?path=draft.mp4");
  assert.equal(built.workflowOptions?.draftFinal?.referenceVideo, "/api/media?path=motion.mp4");
  assert.deepEqual(built.workflowOptions?.save, { cameraNumber: "0042", shotNumber: "0042" });
  assert.deepEqual(built.resolution, { width: 2560, height: 1440, label: "2K" });
});

test("final models are registered per kind and category, and priced from the draft", () => {
  assert.deepEqual(parseDraftFinalModelId("draft_final_minimax_h3_2k_flf2v"), {
    kind: "minimax-h3-768p",
    category: "first_last_frame_to_video",
  });
  assert.equal(parseDraftFinalModelId("draft_final_nonsense_i2v"), undefined);
  const seedanceFinal = getWorkflowModel("draft_final_seedance_2_5_i2v") as WorkflowModel;
  assert.equal(seedanceFinal.category, "image_to_video");
  assert.ok(seedanceFinal.supportedDurations?.includes(30));
  assert.equal(getWorkflowModel("draft_final_minimax_h3_2k_r2v")?.category, "video_editing");

  // The 1080p 2.5 rate for the draft's length, and MiniMax's flat $0.0715/s.
  const seedanceCredits = estimateWorkflowCredits(seedanceFinal, 5);
  assert.ok(seedanceCredits > 700 && seedanceCredits < 1000, String(seedanceCredits));
  const minimaxFinal = draftFinalWorkflowModel("draft_final_minimax_h3_2k_i2v") as WorkflowModel;
  assert.equal(estimateWorkflowCredits(minimaxFinal, 10), Math.round(0.0715 * 10 * 211));
});

test("the final graphs carry the draft id, or the draft's video and inputs in the draft's order", async () => {
  const seedanceFinal = withDraft(job());
  const seedanceJob = { ...seedanceFinal, ...finalJobFields(draftFinalRequest(seedanceFinal, "draft_final_seedance_2_5_i2v", "u", {}, NOW)) };
  const seedanceGraph = await buildDraftFinalWorkflow(seedanceJob, { imageNames: [] });
  assert.equal(seedanceGraph["1"].class_type, "ByteDance2DraftToFinalVideoNode");
  assert.equal(seedanceGraph["1"].inputs.draft_task_id, "cgt-20260930115500-abcd");

  const flf = withDraft(
    job({
      modelId: "brick_api_minimax_h3_flf2v",
      category: "first_last_frame_to_video",
      workflowOptions: {},
      textArtifacts: [],
      resolution: { width: 1366, height: 768, label: "768P" },
      inputImages: ["/api/media?path=first.png", "/api/media?path=last.png"],
    }),
  );
  const flfJob = { ...flf, ...finalJobFields(draftFinalRequest(flf, "draft_final_minimax_h3_2k_flf2v", "u", {}, NOW)) };
  const flfGraph = await buildDraftFinalWorkflow(flfJob, {
    imageNames: ["0001.png", "0002.png"],
    baseVideoName: "draft_base.mp4",
  });
  const regenerate = flfGraph["10"].inputs;
  assert.equal(flfGraph["10"].class_type, "MinimaxHailuo03RegenerateNode");
  assert.equal(regenerate["model.prompt"], flf.prompt);
  assert.equal(regenerate["model.resolution"], "2K");
  assert.deepEqual(regenerate.video, ["1", 0]);
  assert.equal(flfGraph[regenerate.first_frame[0]].inputs.image, "0001.png");
  assert.equal(flfGraph[regenerate.last_frame[0]].inputs.image, "0002.png");
  assert.equal(flfGraph["4"], undefined);

  const reference = withDraft(
    job({
      modelId: "brick_api_minimax_h3_r2v",
      category: "video_editing",
      workflowOptions: {},
      textArtifacts: [],
      resolution: { width: 1366, height: 768, label: "768P" },
      inputVideo: "/api/media?path=motion.mp4",
    }),
  );
  const referenceJob = { ...reference, ...finalJobFields(draftFinalRequest(reference, "draft_final_minimax_h3_2k_r2v", "u", {}, NOW)) };
  const referenceGraph = await buildDraftFinalWorkflow(referenceJob, {
    imageNames: ["0001.png"],
    baseVideoName: "draft_base.mp4",
    referenceVideoName: "job_reference.mp4",
  });
  const referenceNode = referenceGraph["10"].inputs;
  assert.ok(!("first_frame" in referenceNode));
  assert.equal(referenceGraph[referenceNode["model.reference_videos.video_1"][0]].inputs.file, "job_reference.mp4");
  assert.equal(referenceGraph[referenceNode["model.reference_images.image_1"][0]].inputs.image, "0001.png");
  assert.equal(referenceGraph["3"], undefined);
});

test("the route builds a final from the requester's own draft and refuses anyone else's", async () => {
  const project = { id: "prj_a" } as Project;
  const user = { id: "usr_artist", role: "user" } as User;
  const draft = withDraft(job());
  const created: CreateJobRequest[] = [];
  const handler = createJobSubmissionHandler({
    getProject: (id) => (id === "prj_a" ? project : undefined),
    getWorkflowModel,
    canViewProject: () => true,
    canCreateJobInProject: () => true,
    isDemoAccount: () => false,
    validateMedia: async () => undefined,
    createJob: async (request) => {
      created.push(request);
      return { ...draft, id: "job_final", modelId: request.modelId };
    },
    readMaintenance: () => ({ enabled: false, message: "" }),
    getJob: (id) => (id === draft.id ? draft : undefined),
    canAccessJob: () => true,
  });

  const accepted = await invoke(handler, user, {
    projectId: "prj_a",
    modelId: "draft_final_seedance_2_5_i2v",
    // Ignored: a final re-renders its draft.
    prompt: "something else entirely",
    inputImages: ["/api/media?path=elsewhere.png"],
    workflowOptions: { draftFinal: { sourceJobId: draft.id, taskId: "cgt-forged" } },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(created[0].prompt, draft.prompt);
  assert.equal(created[0].inputImages, undefined);
  assert.equal(created[0].workflowOptions?.draftFinal?.taskId, "cgt-20260930115500-abcd");

  const otherProject = await invoke(handler, user, {
    projectId: "prj_a",
    modelId: "draft_final_seedance_2_5_i2v",
    workflowOptions: { draftFinal: { sourceJobId: "job_missing" } },
  });
  assert.equal(otherProject.status, 404);

  // A final cannot be smuggled onto an ordinary model either.
  const smuggled = await invoke(handler, user, {
    projectId: "prj_a",
    modelId: "brick_api_seedance2_0_i2v",
    prompt: "x",
    inputImages: ["/api/media?path=a.png"],
    workflowOptions: { draftFinal: { sourceJobId: draft.id } },
  });
  assert.equal(smuggled.status, 400);
  assert.match(String((smuggled.body as { error?: string }).error), /draftFinal/);
});

function finalJobFields(request: CreateJobRequest): Partial<Job> {
  return {
    modelId: request.modelId,
    prompt: request.prompt,
    workflowOptions: request.workflowOptions,
    inputImages: request.inputImages ?? [],
    inputVideo: request.inputVideo,
  };
}

async function invoke(handler: ReturnType<typeof createJobSubmissionHandler>, user: User, body: unknown) {
  let status = 0;
  let payload: unknown;
  const req = { body, authUser: user } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
  } as unknown as Response;
  await handler(req, res, () => undefined);
  return { status, body: payload };
}
