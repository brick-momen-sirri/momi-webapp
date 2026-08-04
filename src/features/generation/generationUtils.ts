import { uploadBackendMedia, type AuthUser } from "../../services/backendApi";
import { isSeedanceWorkflowModel, KLING_PROMPT_CHARACTER_LIMIT } from "../../services/promptRules";
import type { ArchVizGridOptions, Job, ModelType, Project, UploadedImage, UploadedVideo, WorkflowOptions } from "../../types";
import { createClientId } from "../../utils/id";
import { ALL_PROJECTS_ID } from "../workspace/workspaceUtils";

type DisabledReasonInput = {
  isDemoAccount: boolean;
  insufficientCredits: boolean;
  selectedProjectId: string;
  selectedProject?: Project;
  hasMissingImages: boolean;
  hasMissingVideo: boolean;
  hasCropIssues: boolean;
  hasMissingPrompt: boolean;
  promptOverflowCharacters: number;
  requiredImages: number;
};

export function getDisabledReason({
  isDemoAccount,
  insufficientCredits,
  selectedProjectId,
  selectedProject,
  hasMissingImages,
  hasMissingVideo,
  hasCropIssues,
  hasMissingPrompt,
  promptOverflowCharacters,
  requiredImages,
}: DisabledReasonInput) {
  if (isDemoAccount) return "Demo accounts are view-only and cannot generate tasks.";
  if (insufficientCredits) return "Insufficient credits.";
  if (selectedProjectId === ALL_PROJECTS_ID || !selectedProject) return "Please select a specific project before generating.";
  if (hasMissingPrompt) return "Add a prompt before generating.";
  if (promptOverflowCharacters > 0) {
    return `Kling prompts are limited to ${KLING_PROMPT_CHARACTER_LIMIT.toLocaleString()} characters. Shorten this prompt by ${promptOverflowCharacters.toLocaleString()} characters before generating.`;
  }
  if (hasMissingImages) {
    if (requiredImages === 2) return "Upload both required images.";
    if (requiredImages > 2) return `Upload all ${requiredImages} input images.`;
    return "Upload an input image.";
  }
  if (hasMissingVideo) return "Upload an input video.";
  if (hasCropIssues) return "Save the 16:9 crop before generating.";
  return undefined;
}

export function parseResolution(value: string) {
  const normalized = normalizeResolutionLabel(value);
  if (normalized === "auto") return { width: 1024, height: 1024, label: normalized };
  if (normalized === "1K") return { width: 1024, height: 1024, label: normalized };
  if (normalized === "2K") return { width: 2048, height: 2048, label: normalized };
  if (normalized === "720p") return { width: 1280, height: 720, label: normalized };
  if (normalized === "1080p") return { width: 1920, height: 1080, label: normalized };
  if (normalized === "4K") return { width: 3840, height: 2160, label: normalized };
  const match = normalized.match(/^(\d+)\s*x\s*(\d+)$/i) ?? value.match(/(\d+)\s*x\s*(\d+)/i);
  return {
    width: match ? Number(match[1]) : 1920,
    height: match ? Number(match[2]) : 1080,
    label: normalized,
  };
}

export function normalizeDurationSeconds(
  value: number | undefined,
  model: Pick<ModelType, "category" | "supportedDurations" | "defaultDurationSeconds">,
) {
  const options = model.category === "video" ? (model.supportedDurations ?? []) : [];
  if (!options.length) return model.defaultDurationSeconds ?? 8;
  const fallback =
    model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds) ? model.defaultDurationSeconds : options[0];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (options.includes(value)) return value;
  return options.reduce((closest, option) => (Math.abs(option - value) < Math.abs(closest - value) ? option : closest), fallback);
}

export function defaultDurationSecondsForModel(
  model: Pick<ModelType, "category" | "supportedDurations" | "defaultDurationSeconds">,
) {
  const options = model.category === "video" ? (model.supportedDurations ?? []) : [];
  if (!options.length) return model.defaultDurationSeconds ?? 8;
  return model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds)
    ? model.defaultDurationSeconds
    : options[0];
}

const gptImageResolutionValues = [
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840",
];

const nanoBananaAspectRatioValues = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

export function normalizeNanoBananaAspectRatio(value: unknown) {
  return typeof value === "string" && nanoBananaAspectRatioValues.includes(value) ? value : "auto";
}

function normalizeExactResolutionValue(value: string) {
  const lower = value.toLowerCase().replace(/\s+/g, "");
  return gptImageResolutionValues.find((resolution) => resolution.toLowerCase() === lower);
}

function normalizeResolutionLabel(value: string) {
  const exact = normalizeExactResolutionValue(value);
  if (exact) return exact;
  return normalizeResolutionAlias(value);
}

function normalizeResolutionAlias(value: string) {
  const lower = value.toLowerCase().replace(/\s+/g, "");
  if (lower === "1k" || lower === "1024x1024") return "1K";
  if (lower === "2k" || lower === "2048x2048") return "2K";
  if (lower === "720p" || lower === "1280x720") return "720p";
  if (lower === "1080p" || lower === "1920x1080" || lower === "16:9landscape") return "1080p";
  if (lower === "4k" || lower === "3840x2160") return "4K";
  return "1080p";
}

export function normalizeResolutionForModel(value: string, model: ModelType, allowSeedance4K: boolean) {
  const supported = model.supportedResolutions?.length ? model.supportedResolutions : ["720p", "1080p", "4K"];
  if (isSeedanceWorkflowModel(model) && !allowSeedance4K && normalizeResolutionAlias(value) === "4K") {
    return supported.find((resolution) => resolution.toLowerCase() === "1080p") ?? supported[0] ?? "1080p";
  }
  const exact = normalizeExactResolutionValue(value);
  if (exact && supported.some((resolution) => resolution.toLowerCase() === exact.toLowerCase())) return exact;
  const alias = normalizeResolutionAlias(value);
  if (supported.some((resolution) => resolution.toLowerCase() === alias.toLowerCase())) return alias;
  const normalized = normalizeResolutionLabel(value);
  if (supported.some((resolution) => resolution.toLowerCase() === normalized.toLowerCase())) return normalized;
  if (supported.some((resolution) => resolution.toLowerCase() === "auto")) return "auto";
  if (supported.some((resolution) => resolution.toLowerCase() === "1080p")) return "1080p";
  return supported[0] ?? "1080p";
}

export function imageSlotCountForModel(
  model: Pick<ModelType, "requiresImage" | "requiresTwoImages" | "imageSlotCount"> | undefined,
) {
  if (!model) return 0;
  if (model.requiresTwoImages) return 2;
  if (typeof model.imageSlotCount === "number") return Math.max(0, model.imageSlotCount);
  return model.requiresImage ? 1 : 0;
}

export function minimumImageCountForModel(
  model: Pick<
    ModelType,
    "id" | "label" | "backendCategory" | "workflowPath" | "requiresImage" | "requiresTwoImages" | "imageSlotCount"
  >,
) {
  if (supportsTextOnlyImageWorkflow(model)) return 0;
  if (model.requiresTwoImages) return 2;
  if (model.requiresImage || (model.imageSlotCount ?? 0) > 0) return 1;
  return 0;
}

function supportsTextOnlyImageWorkflow(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return (
    (key.includes("nano") && key.includes("banana")) ||
    ((key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid"))
  );
}

export function isArchVizGridModel(model: Pick<ModelType, "id" | "label" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("exteriorgrid") || key.includes("exterior grid");
}

export function isImageToVideoModel(model: Pick<ModelType, "id" | "label" | "category" | "backendCategory" | "workflowPath">) {
  if (model.backendCategory) return model.backendCategory === "image_to_video";
  if (model.category !== "video") return false;
  const key = `${model.id} ${model.label ?? ""} ${model.workflowPath ?? ""}`.toLowerCase().replaceAll("\\", "/");
  return (
    key.includes("/i2v/") ||
    key.includes("image_to_video") ||
    key.includes("image-to-video") ||
    key.includes("image to video") ||
    model.id === "video_generation" ||
    model.id === "google_veo"
  );
}

export function workflowOptionsForJob(
  model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">,
  archVizGrid: ArchVizGridOptions,
  saveNumber: string,
  imageOutputCount: 1 | 2,
  nanoBananaAspectRatio: string,
): WorkflowOptions {
  const normalizedSaveNumber = normalizeSaveNumber(saveNumber);
  return {
    ...(isArchVizGridModel(model) ? { archVizGrid } : {}),
    ...(isNanoBananaModel(model)
      ? { nanoBanana: { aspectRatio: normalizeNanoBananaAspectRatio(nanoBananaAspectRatio), outputCount: imageOutputCount } }
      : {}),
    ...(isGptImageModel(model) ? { gptImage: { outputCount: imageOutputCount } } : {}),
    save: {
      cameraNumber: normalizedSaveNumber,
      shotNumber: normalizedSaveNumber,
    },
  };
}

export function isNanoBananaModel(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("nano") && key.includes("banana");
}

function isGptImageModel(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return (key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid");
}

export function supportsImageOutputCount(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  return isNanoBananaModel(model) || isGptImageModel(model);
}

export function isDemoAccount(user: Pick<AuthUser, "email" | "username">) {
  const email = user.email.toLowerCase();
  const username = (user.username ?? "").toLowerCase();
  return (
    email === "demo@brickvisual.com" || email === "momi.demo@brickvisual.com" || username === "demo" || username === "momi-demo"
  );
}

export function createLocalJob({
  account,
  selectedModel,
  selectedProjectId,
  prompt,
  selectedResolution,
  selectedDurationSeconds,
  images,
  video,
  archVizGridOptions,
  saveNumber,
  imageOutputCount,
  selectedNanoBananaAspectRatio,
  use16By9Cropping,
  requiredImages,
}: {
  account: AuthUser;
  selectedModel: ModelType;
  selectedProjectId: string;
  prompt: string;
  selectedResolution: string;
  selectedDurationSeconds: number;
  images: UploadedImage[];
  video?: UploadedVideo;
  archVizGridOptions: ArchVizGridOptions;
  saveNumber: string;
  imageOutputCount: 1 | 2;
  selectedNanoBananaAspectRatio: string;
  use16By9Cropping: boolean;
  requiredImages: number;
}): Job {
  const inputImages = images
    .slice(0, requiredImages)
    .filter(Boolean)
    .map((image) => jobImageUrl(image, use16By9Cropping));
  const resultUrl =
    inputImages[0] ?? "https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1180&q=90";
  return {
    id: createClientId("job_").slice(0, 28),
    projectId: selectedProjectId,
    userId: account.id,
    modelId: selectedModel.id,
    modelType: selectedModel.label,
    backendCategory: selectedModel.backendCategory,
    workflowPath: selectedModel.workflowPath,
    inputType: selectedModel.requiresVideo
      ? "video"
      : !selectedModel.requiresImage && !selectedModel.requiresTwoImages
        ? "text_only"
        : selectedModel.requiresTwoImages
          ? "start_end_frames"
          : requiredImages > 1
            ? "multi_image"
            : "single_image",
    prompt: prompt.trim(),
    resolution: selectedResolution,
    durationSeconds: selectedModel.category === "video" ? selectedDurationSeconds : undefined,
    workflowOptions: workflowOptionsForJob(
      selectedModel,
      archVizGridOptions,
      saveNumber,
      imageOutputCount,
      selectedNanoBananaAspectRatio,
    ),
    status: "queued",
    inputImages,
    inputVideo: video?.url,
    resultUrl,
    resultUrls: [resultUrl],
    thumbnailUrl: resultUrl,
    thumbnailUrls: [resultUrl],
    outputType: selectedModel.category === "video" ? "video" : "image",
    videoLength: selectedModel.category === "video" ? `${selectedDurationSeconds} seconds` : undefined,
    creditsUsed: selectedModel.cost,
    createdAt: new Date().toISOString(),
  };
}

export function jobImageUrl(image: UploadedImage, use16By9Cropping: boolean) {
  return use16By9Cropping ? (image.croppedUrl ?? image.url) : image.url;
}

export function normalizeSaveNumber(value: unknown) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  return (digits || "0000").padStart(4, "0");
}

export function normalizeRequiredSaveNumber(value: unknown) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  return digits ? digits.padStart(4, "0") : "";
}

export function workflowOptionsWithSaveNumber(options: WorkflowOptions | undefined, saveNumber: string): WorkflowOptions {
  return {
    ...(options ?? {}),
    save: {
      ...(options?.save ?? {}),
      cameraNumber: saveNumber,
      shotNumber: saveNumber,
    },
  };
}

export async function uploadJobMediaUrl(url: string, options: { projectId: string; kind: "image" | "video"; name?: string }) {
  if (!url.startsWith("blob:") && !url.startsWith("data:")) return url;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not read ${options.kind} before upload.`);
  }

  const blob = await response.blob();
  return uploadBackendMedia(blob, options);
}
