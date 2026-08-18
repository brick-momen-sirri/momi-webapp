import { isStillImageJob } from "../../features/still-images/jobSection";
import { measuredPodCredits } from "../../features/still-images/podRuntimeCost";
import type { Job, MediaResolution, ModelType, Project } from "../../types";
import { backendResultMediaUrl, resolveMediaUrl } from "./mediaAccess";
import type { AuthUser, BackendJob, BackendWorkflowModel } from "./types";

export function mapModel(model: BackendWorkflowModel): ModelType {
  const category = model.category.includes("video") ? "video" : model.category.includes("upscal") ? "upscale" : "image";
  const durationConfig = durationConfigForModel(model);
  return {
    id: model.id,
    label: model.name,
    description: model.description ?? `ComfyUI workflow loaded from ${model.workflowPath}`,
    category,
    cost: Math.max(0, Math.round(model.estimatedCredits ?? 0)),
    estimatedTime: model.estimatedTime ?? "Queued",
    requiresTwoImages: model.requiresStartEndFrames,
    requiresLandscape: category === "video",
    supportsAudio: category === "video",
    requiresPrompt: model.requiresPrompt,
    requiresImage: model.requiresImage,
    requiresVideo: model.requiredInputs.includes("video"),
    imageSlotCount: model.imageSlotCount ?? inferImageSlotCount(model),
    backendCategory: model.category,
    workflowPath: model.workflowPath,
    supportedResolutions: supportedResolutionsForModel(model),
    supportedDurations: durationConfig.supportedDurations,
    defaultDurationSeconds: durationConfig.defaultDurationSeconds,
  };
}

function supportedResolutionsForModel(model: BackendWorkflowModel) {
  const key = modelKey(model);
  if (key.includes("flux3") || key.includes("flux 3")) return ["720p", "1080p"];
  if (key.includes("nano") && key.includes("banana")) return ["1K", "2K", "4K"];
  if ((key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid")) {
    return ["auto", "1024x1024", "1024x1536", "1536x1024", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840"];
  }
  if (key.includes("kling") && key.includes("video_edit")) return ["720p", "1080p"];
  return model.supportedResolutions?.length ? model.supportedResolutions : ["720p", "1080p", "4K"];
}

function inferImageSlotCount(model: BackendWorkflowModel) {
  const key = modelKey(model);
  if (model.requiresStartEndFrames) return 2;
  if (key.includes("openai_gpt_image_2_i2i")) return 5;
  if (key.includes("nano") && key.includes("banana")) return 3;
  if (key.includes("ref_transfer")) return 2;
  if (key.includes("exteriorgrid")) return 1;
  return model.requiresImage ? 1 : 0;
}

function durationConfigForModel(model: BackendWorkflowModel) {
  const key = modelKey(model);
  if (key.includes("flux3") || key.includes("flux 3")) {
    return { supportedDurations: range(5, 20), defaultDurationSeconds: 5 };
  }
  if (key.includes("kling_v3_flf2v")) return { supportedDurations: range(3, 15), defaultDurationSeconds: 5 };
  if (key.includes("seedance") && key.includes("flf2v")) return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  if (key.includes("veo3") && key.includes("flf2v")) return { supportedDurations: [4, 6, 8], defaultDurationSeconds: 6 };
  if (key.includes("kling_v2_6_video") || key.includes("kling_v2.6_video")) {
    return { supportedDurations: [5, 10], defaultDurationSeconds: 5 };
  }
  if (key.includes("kling_v3_video")) return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  if (key.includes("seedance") && (key.includes("i2v") || key.includes("r2v"))) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("veo3") && key.includes("i2v")) return { supportedDurations: [4, 6, 8], defaultDurationSeconds: 4 };
  return { supportedDurations: model.supportedDurations, defaultDurationSeconds: model.defaultDurationSeconds };
}

function modelKey(model: BackendWorkflowModel) {
  return `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
}

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function mapJob(job: BackendJob): Job {
  const resolution = job.resolution?.label ?? (job.resolution ? `${job.resolution.width} x ${job.resolution.height}` : "Unknown");
  const outputResolution = normalizeResolution(job.outputResolution);
  const hasUnsavedRemoteMedia = jobHasUnsavedRemoteMedia(job);
  const shouldProxyResults = job.source !== "existing_project_media";
  const resultUrls = shouldProxyResults
    ? job.resultUrls.map((_, index) => backendResultMediaUrl(job.id, index))
    : job.resultUrls.map(resolveMediaUrl);
  const thumbnailUrls = job.thumbnailUrls.map(resolveMediaUrl);
  const inputImages = job.inputImages.map(resolveMediaUrl);
  const inputVideo = job.inputVideo ? resolveMediaUrl(job.inputVideo) : undefined;
  const resultUrl = resultUrls[0] ?? thumbnailUrls[0];
  return {
    id: job.id,
    projectId: job.projectId,
    folderId: job.folderId ?? null,
    folderName: job.folderName,
    userId: job.userId,
    modelId: job.modelId,
    modelType: job.modelName,
    title: job.title,
    backendCategory: job.category,
    workflowPath: job.workflowPath,
    inputType: job.inputType,
    prompt: job.prompt ?? "",
    resolution,
    outputResolution,
    durationSeconds: job.durationSeconds,
    workflowOptions: job.workflowOptions,
    status: job.status,
    cancelRequested: job.cancelRequested,
    runpodProgress: job.runpodProgress,
    runpodTiming: job.runpodTiming,
    inputImages,
    inputVideo,
    resultUrls,
    resultUrl,
    thumbnailUrls,
    thumbnailUrl: thumbnailUrls[0] ?? resultUrl,
    outputType: job.outputType,
    fileName: job.fileName,
    generatedPrompt: job.generatedPrompt,
    textArtifacts: job.textArtifacts,
    creditsEstimated: job.creditsEstimated,
    creditsActual: job.creditsActual,
    creditsActualSource: job.creditsActualSource,
    creditBalanceBefore: job.creditBalanceBefore,
    creditBalanceAfter: job.creditBalanceAfter,
    source: job.source,
    missingMetadata: job.missingMetadata,
    hasUnsavedRemoteMedia,
    archivedAt: job.archivedAt,
    archivedBy: job.archivedBy,
    videoLength: job.durationSeconds
      ? `${job.durationSeconds} seconds`
      : job.outputType === "video"
        ? "Backend video"
        : job.outputType === "sequence"
          ? "Image sequence"
          : undefined,
    creditsUsed: mappedCreditsUsed(job),
    creditUsage: job.creditUsage,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    generationTime: generationTimeForJob(job),
  };
}

function jobHasUnsavedRemoteMedia(job: BackendJob) {
  if (job.status !== "completed") return false;
  return [...(job.resultUrls ?? []), ...(job.thumbnailUrls ?? [])].some(
    (url) => /^https?:\/\//i.test(url ?? "") && !url.includes("/api/media"),
  );
}

function mappedCreditsUsed(job: BackendJob) {
  // Still Images presets are exempt from credit accounting until their cost has
  // been measured (isCreditExemptJob on the backend). Gated here, at the boundary,
  // so no consumer has to remember: the backend writes no creditsUsed for an
  // unmeasured one, but creditUsage lingers on jobs that ran before the exemption
  // and the branches below would happily resurrect a number from its estimate.
  //
  // A measured figure is let through. It is priced from the worker time RunPod
  // reported for this job, so it is spend, not a projection.
  if (isStillImageJob(job)) return measuredPodCredits(job);

  const actualCredits = nonNegativeNumber(job.creditsActual);
  if (actualCredits != null) return actualCredits;
  if (isCountedCreditUsage(job.creditUsage)) {
    return nonNegativeNumber(job.creditsUsed) ?? nonNegativeNumber(job.creditUsage?.total_estimated_credits);
  }
  if (!job.creditUsage) return positiveNumber(job.creditsUsed);
  return undefined;
}

function isCountedCreditUsage(creditUsage?: Job["creditUsage"]) {
  const source = (creditUsage?.source ?? "").trim().toLowerCase();
  return Boolean(
    creditUsage && source !== "local_kling_estimate" && !(source.startsWith("local_") && source.includes("estimate")),
  );
}

function positiveNumber(value: unknown) {
  const number = nonNegativeNumber(value);
  return number != null && number > 0 ? number : undefined;
}

function nonNegativeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  return undefined;
}

function normalizeResolution(value?: MediaResolution) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return undefined;
  const width = Math.round(value.width);
  const height = Math.round(value.height);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height, label: value.label };
}

export function mapProject(project: Project): Project {
  return {
    ...project,
    folders: Array.isArray(project.folders) ? project.folders : [],
    memberCount: project.members.length + project.groupMembers.length,
    visibility: project.visibility ?? "team",
  };
}

export function mapUser(user: AuthUser): AuthUser {
  return {
    ...user,
    name: user.displayName ?? user.name,
    displayName: user.displayName ?? user.name,
    avatar: user.avatar ?? initialsFor(user.displayName ?? user.name),
    avatarColor: user.avatarColor ?? "#11b8a5",
    pinnedProjectIds: Array.isArray(user.pinnedProjectIds)
      ? user.pinnedProjectIds.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "US"
  );
}

function generationTimeForJob(job: BackendJob) {
  if (job.source === "existing_project_media") return undefined;
  if (job.status === "queued") return "queued";
  if (job.status === "sending") return "sending";
  if (job.status === "running") return "running";
  const startedAt = parseDate(job.startedAt ?? job.createdAt);
  const completedAt = parseDate(job.completedAt);
  if (startedAt == null || completedAt == null || completedAt < startedAt) {
    return job.status === "completed" ? undefined : job.status;
  }
  return formatDuration(completedAt - startedAt);
}

function parseDate(value: string | undefined) {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds} sec`;
  if (!seconds) return `${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}
