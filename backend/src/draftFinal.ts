// Draft -> Review -> Final.
//
// Two providers can render an approved preview as its final instead of the artist
// paying for the expensive render up front:
//
//   seedance-2.5-draft  Seedance 2.5 Draft (480p, ~18% of a 1080p render) returns a
//                       draft_task_id. ByteDance2DraftToFinalVideoNode renders the
//                       1080p final from that id alone, reusing the draft's prompt,
//                       references, duration, ratio and audio. Valid for 7 days.
//   minimax-h3-768p     A MiniMax H3 render at 768P. MinimaxHailuo03RegenerateNode
//                       re-renders it at 2K when given the unmodified 768P video, the
//                       exact prompt, and the same frames or references.
//
// A final is its own job, on a registered model (draftFinalModels.ts), built
// entirely on the server from the draft job: the client names the draft and
// nothing else, so a final cannot be pointed at another project's task id or at
// media the requester could not otherwise use.

import fs from "node:fs/promises";

import type { ComfyNode } from "./comfyGraph.js";
import {
  draftFinalModelId,
  draftFinalResolution,
  draftFinalWorkflowPath,
  parseDraftFinalModelId,
  type DraftFinalKind,
} from "./draftFinalModels.js";
import { partnerModelDraft } from "./partnerModels.js";
import { SEEDANCE_DRAFT_TASK_FILENAME_PREFIX, seedanceVersion, seedanceVersionIdFromOptions } from "./seedanceVersions.js";
import type { CreateJobRequest, Job, JobDraft } from "./types.js";

/** Seedance keeps a draft renderable for 7 days after it was created. */
export const SEEDANCE_DRAFT_VALID_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A little inside the provider's window, so a final started at the last minute is
 * not refused by BytePlus after the job has been queued and the artist has waited.
 */
const SEEDANCE_DRAFT_SAFETY_MS = 30 * 60 * 1000;

const DRAFT_TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{4,200}$/;

export class DraftFinalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DraftFinalError";
  }
}

/**
 * What this finished job offers as a draft, if anything.
 *
 * Read off the job itself, so it is decided once, when the job completes, from what
 * actually ran: a Seedance draft that came back without a task id is not offered,
 * however it was requested.
 */
export function detectJobDraft(job: Job, now = new Date()): JobDraft | undefined {
  if (job.status !== "completed" && job.status !== "running") return undefined;
  const createdAt = job.completedAt ?? now.toISOString();

  if (job.workflowOptions?.seedance && seedanceVersion(seedanceVersionIdFromOptions(job.workflowOptions)).draft) {
    const taskId = seedanceDraftTaskId(job);
    if (!taskId) return undefined;
    return {
      kind: "seedance-2.5-draft",
      taskId,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + SEEDANCE_DRAFT_VALID_MS).toISOString(),
    };
  }

  const draft = partnerModelDraft(job.modelId);
  if (draft?.kind === "minimax-h3-768p") {
    if (draft.resolution && normalize(job.resolution?.label) !== normalize(draft.resolution)) return undefined;
    return { kind: "minimax-h3-768p", createdAt };
  }

  return undefined;
}

/** The task id a Seedance draft saved through SaveStringKJ, from the job's text artifacts. */
export function seedanceDraftTaskId(job: Pick<Job, "textArtifacts">) {
  for (const artifact of job.textArtifacts ?? []) {
    const filename = (artifact.filename ?? "").split(/[\\/]/).pop() ?? "";
    if (!filename.startsWith(SEEDANCE_DRAFT_TASK_FILENAME_PREFIX)) continue;
    const taskId = artifact.text.trim();
    if (DRAFT_TASK_ID_PATTERN.test(taskId)) return taskId;
  }
  return undefined;
}

/** Whether the saved draft id is also what ended up as the job's "generated prompt". */
export function isDraftTaskIdText(job: Pick<Job, "draft">, text: string | undefined) {
  return Boolean(job.draft?.taskId && text?.trim() === job.draft.taskId);
}

/**
 * Why this draft cannot be finalized now, or undefined when it can.
 *
 * Shared by the route, which refuses, and the job payload, which lets the card say
 * so before anyone clicks.
 */
export function draftFinalRefusal(source: Job, now = new Date()) {
  const draft = source.draft;
  if (!draft) return "This job is not a draft that can be finalized.";
  if (source.status !== "completed") return "Only a completed draft can be finalized.";
  if (source.workflowOptions?.draftFinal) return "This job is already a final render.";
  if (draft.kind === "seedance-2.5-draft") {
    if (!draft.taskId) return "This Seedance draft did not return a task id, so it cannot be finalized.";
    const expiresAt = Date.parse(draft.expiresAt ?? "");
    if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt - SEEDANCE_DRAFT_SAFETY_MS) {
      return "This Seedance draft is older than 7 days and can no longer be finalized. Render a new draft.";
    }
  }
  if (draft.kind === "minimax-h3-768p") {
    if (!source.resultUrls[0]) return "This draft has no saved video to re-render.";
    if (!source.prompt?.trim()) return "This draft has no prompt, and the 2K re-render needs the exact one it used.";
  }
  return undefined;
}

/**
 * The job request a final is created from, built from the draft alone.
 *
 * @param finalModelId what the client asked for, checked against the draft so a
 *   Seedance final cannot be requested for a MiniMax draft or filed in another category.
 */
export function draftFinalRequest(
  source: Job,
  finalModelId: string,
  userId: string,
  options: { clientRequestId?: string; targetFolderId?: string | null } = {},
  now = new Date(),
): CreateJobRequest {
  const refusal = draftFinalRefusal(source, now);
  if (refusal) throw new DraftFinalError(refusal, 409);
  const draft = source.draft as JobDraft;

  const expected = draftFinalModelId(draft.kind, source.category);
  if (finalModelId !== expected) {
    throw new DraftFinalError(`This draft is finalized with ${expected}, not ${finalModelId}.`);
  }

  const base: CreateJobRequest = {
    clientRequestId: options.clientRequestId,
    projectId: source.projectId,
    targetFolderId: options.targetFolderId === undefined ? (source.folderId ?? null) : options.targetFolderId,
    modelId: finalModelId,
    prompt: source.prompt,
    resolution: draftFinalResolution(draft.kind),
    durationSeconds: source.durationSeconds,
    userId,
    workflowOptions: {
      draftFinal: { sourceJobId: source.id, kind: draft.kind, ...(draft.taskId ? { taskId: draft.taskId } : {}) },
      ...(source.workflowOptions?.save ? { save: source.workflowOptions.save } : {}),
    },
  };

  if (draft.kind === "seedance-2.5-draft") return base;

  // MiniMax re-renders the draft's own video with the same inputs, in the same order.
  // A reference draft's clip rides in the options, because a job has one inputVideo
  // and that slot carries the 768P render being re-rendered.
  return {
    ...base,
    inputImages: [...source.inputImages],
    inputVideo: source.resultUrls[0],
    workflowOptions: {
      ...base.workflowOptions,
      draftFinal: {
        ...base.workflowOptions?.draftFinal,
        sourceJobId: source.id,
        kind: draft.kind,
        ...(source.inputVideo ? { referenceVideo: source.inputVideo } : {}),
      },
    },
  };
}

export type DraftFinalInputNames = {
  imageNames: string[];
  baseVideoName?: string;
  referenceVideoName?: string;
};

/**
 * The graph a final runs.
 *
 * Built from the template in backend/workflow-draft-final so the exported node and
 * its fixed inputs stay reviewable as a file, with only the per-job values and the
 * category's wiring written here.
 */
export async function buildDraftFinalWorkflow(job: Job, names: DraftFinalInputNames): Promise<ComfyNode> {
  const parsed = parseDraftFinalModelId(job.modelId);
  if (!parsed) throw new Error(`${job.modelId} is not a Draft -> Final model.`);
  const graph = JSON.parse(await fs.readFile(draftFinalWorkflowPath(parsed.kind), "utf8")) as ComfyNode;
  const options = job.workflowOptions?.draftFinal;

  if (parsed.kind === "seedance-2.5-draft") {
    const taskId = options?.taskId?.trim();
    if (!taskId || !DRAFT_TASK_ID_PATTERN.test(taskId)) throw new Error("This final has no Seedance draft task id to render.");
    graph["1"].inputs.draft_task_id = taskId;
    return graph;
  }

  return buildMinimaxRegenerateGraph(graph, job, parsed.category, names);
}

function buildMinimaxRegenerateGraph(
  graph: ComfyNode,
  job: Job,
  category: string,
  names: DraftFinalInputNames,
): ComfyNode {
  if (!names.baseVideoName) throw new Error("The 2K re-render has no draft video to work from.");
  const prompt = job.prompt?.trim();
  if (!prompt) throw new Error("The 2K re-render needs the exact prompt the draft used.");

  const node = graph["10"].inputs as ComfyNode;
  graph["1"].inputs.file = names.baseVideoName;
  node["model.prompt"] = job.prompt;
  delete node.first_frame;
  delete node.last_frame;

  const [first, second] = names.imageNames;
  if (category === "video_editing") {
    // Reference media, in the order the draft sent it: Image 1 and Video 1.
    if (!first || !names.referenceVideoName) {
      throw new Error("The 2K re-render of a reference draft needs its reference image and clip.");
    }
    graph["2"].inputs.image = first;
    graph["4"].inputs.file = names.referenceVideoName;
    node["model.reference_images.image_1"] = ["2", 0];
    node["model.reference_videos.video_1"] = ["4", 0];
    delete graph["3"];
    return graph;
  }

  if (!first) throw new Error("The 2K re-render needs the draft's first frame.");
  graph["2"].inputs.image = first;
  node.first_frame = ["2", 0];
  if (category === "first_last_frame_to_video") {
    if (!second) throw new Error("The 2K re-render of a first-last-frame draft needs its last frame.");
    graph["3"].inputs.image = second;
    node.last_frame = ["3", 0];
  } else {
    delete graph["3"];
  }
  delete graph["4"];
  return graph;
}

export function draftFinalKindOf(job: Pick<Job, "modelId">): DraftFinalKind | undefined {
  return parseDraftFinalModelId(job.modelId)?.kind;
}

function normalize(value: string | undefined) {
  return (value ?? "").toLowerCase().replace(/\s+/g, "");
}
