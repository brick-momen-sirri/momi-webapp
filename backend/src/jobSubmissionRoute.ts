import type { RequestHandler } from "express";

import { getRequestUser } from "./authMiddleware.js";
import { remoteVideoInputRejection, requiresNormalizedVideoInput } from "./runpodVideoPreprocessService.js";
import { stillImageCategoryIdFromModelId, stillImageModelId } from "./stillImageModels.js";
import { assertStillImageInputs, normalizeStillImageOptions } from "./stillImageRequest.js";
import { supportsTextOnlyImageWorkflow } from "./textOnlyImageModels.js";
import type { CreateJobRequest, Job, Project, Resolution, User, WorkflowModel, WorkflowOptions } from "./types.js";

export type JobSubmissionDependencies = {
  getProject: (id: string) => Project | undefined;
  getWorkflowModel: (id: string) => WorkflowModel | undefined;
  canViewProject: (user: User, project: Project) => boolean;
  canCreateJobInProject: (user: User, project: Project) => boolean;
  isDemoAccount: (user: User) => boolean;
  validateMedia: (request: CreateJobRequest, project: Project, user: User) => Promise<void>;
  createJob: (request: CreateJobRequest) => Promise<Job | { job: Job; replayed: boolean }>;
};

const KLING_PROMPT_CHARACTER_LIMIT = 2500;
const NANO_BANANA_ASPECT_RATIOS = new Set(["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);

export function createJobSubmissionHandler(deps: JobSubmissionDependencies): RequestHandler {
  return async (req, res) => {
    try {
      const user = getRequestUser(req);
      if (deps.isDemoAccount(user)) {
        return res.status(403).json({ error: "Demo accounts are view-only and cannot generate tasks." });
      }

      const body = requestBody(req.body);
      const projectId = requiredIdentifier(body.projectId, "projectId");
      const project = deps.getProject(projectId);
      if (!project || !deps.canViewProject(user, project)) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (!deps.canCreateJobInProject(user, project)) {
        return res.status(403).json({ error: "Project editor access required." });
      }

      const modelId = requiredIdentifier(body.modelId, "modelId");
      const model = deps.getWorkflowModel(modelId);
      if (!model) throw new JobSubmissionError(`Unknown workflow model: ${modelId}`);

      const request = validatedRequest(body, model, user.id);
      if (user.role !== "admin" && isSeedanceModel(model) && is4KResolution(request.resolution)) {
        return res.status(403).json({ error: "Seedance 4K generation is available to administrators only." });
      }
      if (isKlingVideoModel(model) && (request.prompt?.length ?? 0) > KLING_PROMPT_CHARACTER_LIMIT) {
        throw new JobSubmissionError(
          `Kling prompts are limited to ${KLING_PROMPT_CHARACTER_LIMIT} characters; this prompt is ${request.prompt?.length}. Shorten it and try again.`,
        );
      }

      await deps.validateMedia(request, project, user);
      const creation = await deps.createJob(request);
      const result = "job" in creation ? creation : { job: creation, replayed: false };
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const status = error instanceof JobSubmissionError ? error.status : errorStatus(error, 400);
      res.status(status).json({ error: error instanceof Error ? error.message : "Could not create job" });
    }
  };
}

export function validatedRequest(body: Record<string, unknown>, model: WorkflowModel, userId: string): CreateJobRequest {
  const clientRequestId = optionalClientRequestId(body.clientRequestId);
  const projectId = requiredIdentifier(body.projectId, "projectId");
  const modelId = requiredIdentifier(body.modelId, "modelId");
  const prompt = optionalString(body.prompt, "prompt");
  const inputImages = optionalStringArray(body.inputImages, "inputImages");
  const startFrame = optionalString(body.startFrame, "startFrame");
  const endFrame = optionalString(body.endFrame, "endFrame");
  const inputVideo = optionalString(body.inputVideo, "inputVideo");
  const resolution = optionalResolution(body.resolution);
  const durationSeconds = optionalDuration(body.durationSeconds, model);
  const workflowOptions = optionalWorkflowOptions(body.workflowOptions);
  const targetFolderId = optionalFolderId(body.targetFolderId);

  // Still image presets carry their own input rules, and they are the stricter
  // ones: how many images Qwen Edit takes depends on its mode, which the model's
  // static imageSlotCount cannot express. Run them first so the preset-specific
  // message is what the artist sees rather than the generic slot-count error.
  const stillImage = workflowOptions?.stillImage;
  const stillImageModelCategory = stillImageCategoryIdFromModelId(modelId);

  // modelId and stillImage.categoryId both name the preset, and the endpoint is
  // resolved from the categoryId while the graph comes from the model. Letting them
  // disagree would run one preset's graph on another preset's pod.
  if (stillImage && modelId !== stillImageModelId(stillImage.categoryId)) {
    throw new JobSubmissionError(
      `modelId ${modelId} does not match the ${stillImage.categoryId} still image preset. Expected ${stillImageModelId(stillImage.categoryId)}.`,
    );
  }
  if (stillImageModelCategory && !stillImage) {
    throw new JobSubmissionError(`modelId ${modelId} is a still image preset and requires workflowOptions.stillImage.`);
  }

  if (stillImage) {
    try {
      assertStillImageInputs(stillImage, { prompt, inputImages, startFrame, endFrame, inputVideo });
    } catch (error) {
      throw new JobSubmissionError(error instanceof Error ? error.message : "Invalid still image request.");
    }
  }

  if (model.requiresPrompt && !prompt?.trim()) {
    throw new JobSubmissionError("A prompt is required for this workflow.");
  }
  // Nano Banana and GPT Image are the exception: their graphs are shaped like edits
  // -- so requiredInputs says single_image -- but both providers also generate from
  // a prompt alone, and buildWorkflow strips the image wiring when none is sent.
  if (model.requiredInputs.includes("single_image") && !inputImages?.length && !supportsTextOnlyImageWorkflow(model)) {
    throw new JobSubmissionError("At least one input image is required for this workflow.");
  }
  if (model.requiredInputs.includes("start_frame") && !startFrame) {
    throw new JobSubmissionError("A start frame is required for this workflow.");
  }
  if (model.requiredInputs.includes("end_frame") && !endFrame) {
    throw new JobSubmissionError("An end frame is required for this workflow.");
  }
  if (model.requiredInputs.includes("video") && !inputVideo) {
    throw new JobSubmissionError("An input video is required for this workflow.");
  }
  if (model.requiredInputs.includes("resolution") && !resolution) {
    throw new JobSubmissionError("A resolution is required for this workflow.");
  }
  // Kling O3 and Seedance 2.0 reference reject non-square pixels, so their input
  // is re-encoded before dispatch. That needs the bytes on disk: an http(s) link
  // would otherwise reach the provider untouched and fail there. Data URLs are
  // fine -- externalizeJobInputMedia writes them to the job folder first.
  if (inputVideo && !inputVideo.startsWith("data:") && requiresNormalizedVideoInput(model) && !isLocalMediaReference(inputVideo)) {
    throw new JobSubmissionError(remoteVideoInputRejection(model));
  }
  if (inputImages && model.imageSlotCount && inputImages.length > model.imageSlotCount) {
    throw new JobSubmissionError(`This workflow accepts at most ${model.imageSlotCount} input image(s).`);
  }
  if (resolution) assertSupportedResolution(resolution, model);

  return {
    clientRequestId,
    projectId,
    modelId,
    userId,
    targetFolderId,
    prompt,
    resolution,
    durationSeconds,
    inputImages,
    startFrame,
    endFrame,
    inputVideo,
    workflowOptions,
  };
}

// Only asks "does this name saved media", not whether the path is allowed --
// validateJobMediaReferences owns that check and runs right after.
function isLocalMediaReference(value: string) {
  try {
    return new URL(value, "http://127.0.0.1").pathname === "/api/media";
  } catch {
    return false;
  }
}

function optionalClientRequestId(value: unknown) {
  if (value == null) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(value)) {
    throw new JobSubmissionError("clientRequestId must be 16-200 letters, numbers, underscores, or hyphens.");
  }
  return value;
}

function errorStatus(error: unknown, fallback: number) {
  if (!error || typeof error !== "object" || !("status" in error)) return fallback;
  const status = Number(error.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

class JobSubmissionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "JobSubmissionError";
  }
}

function requestBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JobSubmissionError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredIdentifier(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new JobSubmissionError(`${field} is required.`);
  }
  if (value.length > 200) throw new JobSubmissionError(`${field} is too long.`);
  return value.trim();
}

function optionalString(value: unknown, field: string) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new JobSubmissionError(`${field} must be a string.`);
  return value;
}

function optionalStringArray(value: unknown, field: string) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new JobSubmissionError(`${field} must be an array of media URLs.`);
  if (!value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new JobSubmissionError(`${field} must contain only non-empty media URLs.`);
  }
  return value as string[];
}

function optionalFolderId(value: unknown) {
  if (value == null || value === "") return value === null ? null : undefined;
  if (typeof value !== "string") throw new JobSubmissionError("targetFolderId must be a string or null.");
  return value.trim() || null;
}

function optionalDuration(value: unknown, model: WorkflowModel) {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new JobSubmissionError("durationSeconds must be a positive whole number.");
  }
  if (model.supportedDurations?.length && !model.supportedDurations.includes(value)) {
    throw new JobSubmissionError(
      `Duration ${value}s is not supported by this workflow. Supported durations: ${model.supportedDurations.join(", ")}.`,
    );
  }
  return value;
}

function optionalResolution(value: unknown): Resolution | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JobSubmissionError("resolution must be an object with width and height.");
  }
  const candidate = value as { width?: unknown; height?: unknown; label?: unknown };
  const width = candidate.width;
  const height = candidate.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 8192 ||
    height > 8192
  ) {
    throw new JobSubmissionError("resolution width and height must be positive whole numbers no larger than 8192.");
  }
  if (candidate.label != null && typeof candidate.label !== "string") {
    throw new JobSubmissionError("resolution label must be a string.");
  }
  return { width, height, label: candidate.label as string | undefined };
}

function assertSupportedResolution(resolution: Resolution, model: WorkflowModel) {
  const supported = model.supportedResolutions ?? [];
  if (!supported.length) return;
  const candidates = new Set(
    [resolution.label, `${resolution.width}x${resolution.height}`, resolutionAlias(resolution.width, resolution.height)]
      .filter((value): value is string => Boolean(value))
      .map(normalizeResolution),
  );
  if (!supported.some((value) => candidates.has(normalizeResolution(value)))) {
    throw new JobSubmissionError(
      `Resolution ${resolution.label || `${resolution.width}x${resolution.height}`} is not supported by this workflow.`,
    );
  }
}

function resolutionAlias(width: number, height: number) {
  if (width === 1024 && height === 1024) return "1K";
  if (width === 2048 && height === 2048) return "2K";
  if (width === 1280 && height === 720) return "720p";
  if (width === 1920 && height === 1080) return "1080p";
  if ((width === 3840 && height === 2160) || (width === 2160 && height === 3840)) return "4K";
  return undefined;
}

function normalizeResolution(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function optionalWorkflowOptions(value: unknown): WorkflowOptions | undefined {
  if (value == null) return undefined;
  const options = plainRecord(value, "workflowOptions");
  const allowedKeys = new Set(["archVizGrid", "nanoBanana", "gptImage", "save", "stillImage"]);
  const unknown = Object.keys(options).find((key) => !allowedKeys.has(key));
  if (unknown) throw new JobSubmissionError(`Unsupported provider-specific workflow option: ${unknown}.`);

  if (options.nanoBanana != null) {
    const nano = plainRecord(options.nanoBanana, "Nano Banana options");
    if (nano.outputCount != null && nano.outputCount !== 1 && nano.outputCount !== 2) {
      throw new JobSubmissionError("Nano Banana outputCount must be 1 or 2.");
    }
    if (nano.aspectRatio != null && (typeof nano.aspectRatio !== "string" || !NANO_BANANA_ASPECT_RATIOS.has(nano.aspectRatio))) {
      throw new JobSubmissionError("Nano Banana aspectRatio is not supported.");
    }
  }
  if (options.gptImage != null) {
    const gpt = plainRecord(options.gptImage, "GPT image options");
    if (gpt.outputCount != null && gpt.outputCount !== 1 && gpt.outputCount !== 2) {
      throw new JobSubmissionError("GPT image outputCount must be 1 or 2.");
    }
  }
  if (options.archVizGrid != null) plainRecord(options.archVizGrid, "ArchViz grid options");
  if (options.save != null) plainRecord(options.save, "save options");

  if (options.stillImage == null) return options as WorkflowOptions;

  // Replace the caller's bag with the normalized one: defaults filled in, hidden
  // settings dropped. This is the object that gets persisted on the job and later
  // drives the graph, so nothing unvalidated may survive past this point.
  try {
    return { ...options, stillImage: normalizeStillImageOptions(options.stillImage) } as WorkflowOptions;
  } catch (error) {
    throw new JobSubmissionError(error instanceof Error ? error.message : "Invalid still image options.");
  }
}

function plainRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JobSubmissionError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isSeedanceModel(model: WorkflowModel) {
  return `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase().includes("seedance");
}

function isKlingVideoModel(model: WorkflowModel) {
  return (
    model.outputType === "video" &&
    `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase().includes("kling")
  );
}

function is4KResolution(value: Resolution | undefined) {
  if (!value) return false;
  const label = value.label?.toLowerCase().replace(/\s+/g, "") ?? "";
  return label === "4k" || (Math.max(value.width, value.height) === 3840 && Math.min(value.width, value.height) === 2160);
}
