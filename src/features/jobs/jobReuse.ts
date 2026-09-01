import { defaultArchVizGridOptions } from "../../components/archVizGridDefaults";
import { getStoredAuthToken } from "../../services/backendApi";
import type { ArchVizGridOptions, Job, ModelType, UploadedImage, UploadedVideo, WorkflowOptions } from "../../types";
import { getImageSize } from "../../utils/imageCrop";
import { createClientId } from "../../utils/id";
import { normalizeNanoBananaAspectRatio, normalizeSeedanceRatio } from "../generation/generationUtils";
import { normalizeSeedanceVersion } from "../generation/seedanceVersions";

export function canReuseJobSettings(job: Job, models: ModelType[]) {
  return Boolean(
    findReusableModel(job, models) ||
    hasPromptMetadata(job) ||
    hasKnownResolution(job) ||
    (typeof job.durationSeconds === "number" && Number.isFinite(job.durationSeconds) && job.durationSeconds > 0) ||
    hasReusableWorkflowOptions(job.workflowOptions) ||
    (hasInputImageMetadata(job) && job.inputImages.length > 0) ||
    hasInputVideoMetadata(job),
  );
}

export function findReusableModel(job: Job, models: ModelType[]) {
  const modelId = normalizeModelText(job.modelId);
  if (modelId && modelId !== "existing project media") {
    const exactMatch = models.find((model) => normalizeModelText(model.id) === modelId);
    if (exactMatch) return exactMatch;
  }

  const jobWorkflowPath = job.workflowPath;
  if (jobWorkflowPath) {
    const workflowMatch = models.find((model) =>
      Boolean(model.workflowPath && sameWorkflowPath(model.workflowPath, jobWorkflowPath)),
    );
    if (workflowMatch) return workflowMatch;
  }

  const jobModelName = normalizeModelText(job.modelType);
  if (!jobModelName || jobModelName === "unknown model" || jobModelName === "missing model data") {
    return undefined;
  }

  return models.find((model) => {
    const label = normalizeModelText(model.label);
    const id = normalizeModelText(model.id);
    return (
      label === jobModelName ||
      id === jobModelName ||
      (label.length > 4 && jobModelName.includes(label)) ||
      (jobModelName.length > 4 && label.includes(jobModelName))
    );
  });
}

function sameWorkflowPath(left: string, right: string) {
  const normalizedLeft = normalizeWorkflowPath(left);
  const normalizedRight = normalizeWorkflowPath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight || workflowFileName(normalizedLeft) === workflowFileName(normalizedRight);
}

function normalizeWorkflowPath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase().trim();
}

function workflowFileName(value: string) {
  return value.split("/").filter(Boolean).pop() ?? value;
}

function normalizeModelText(value: unknown) {
  return typeof value === "string"
    ? value
        .replace(/^api\s+/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/[^a-z0-9.]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    : "";
}

export function hasPromptMetadata(job: Job) {
  if (jobMissingMetadata(job, "prompt")) return false;
  if (job.source === "existing_project_media") {
    const prompt = job.prompt.trim().toLowerCase();
    return Boolean(prompt && prompt !== "missing prompt data");
  }
  return typeof job.prompt === "string";
}

export function hasKnownResolution(job: Job) {
  const resolution = job.resolution.trim().toLowerCase();
  return Boolean(resolution && resolution !== "unknown");
}

export function hasInputImageMetadata(job: Job) {
  if (job.source !== "existing_project_media") return true;
  return job.inputImages.length > 0 && !jobMissingMetadata(job, "original input image");
}

export function hasInputVideoMetadata(job: Job) {
  return Boolean(job.inputVideo && !jobMissingMetadata(job, "original input video"));
}

function hasReusableWorkflowOptions(options: WorkflowOptions | undefined) {
  return Boolean(options?.archVizGrid || options?.save || options?.nanoBanana || options?.gptImage);
}

function jobMissingMetadata(job: Job, field: string) {
  const normalizedField = normalizeMetadataField(field);
  return Boolean(
    job.missingMetadata?.some((item) => {
      const normalizedItem = normalizeMetadataField(item);
      return (
        normalizedItem === normalizedField || normalizedItem.includes(normalizedField) || normalizedField.includes(normalizedItem)
      );
    }),
  );
}

function normalizeMetadataField(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeReusableArchVizGridOptions(value: unknown): ArchVizGridOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<ArchVizGridOptions>;
  const defaults = defaultArchVizGridOptions();
  const slotCount = isArchVizSlotCount(input.slotCount) ? input.slotCount : defaults.slotCount;
  const sourceSlots = Array.isArray(input.cameraSlots) ? input.cameraSlots : [];

  return {
    slotCount,
    useSmartDefaults: typeof input.useSmartDefaults === "boolean" ? input.useSmartDefaults : defaults.useSmartDefaults,
    cameraSlots: Array.from({ length: 9 }, (_, index) => {
      const value = sourceSlots[index];
      return typeof value === "string" && value.trim()
        ? value
        : (defaults.cameraSlots[index] ?? "Professional regular archviz view");
    }),
  };
}

function isArchVizSlotCount(value: unknown): value is ArchVizGridOptions["slotCount"] {
  return value === "1" || value === "2" || value === "4" || value === "6" || value === "8" || value === "9";
}

export function reusableSaveNumber(job: Job) {
  const save = job.workflowOptions?.save;
  if (!save) return undefined;
  const value = isVideoLikeJob(job) ? (save.shotNumber ?? save.cameraNumber) : (save.cameraNumber ?? save.shotNumber);
  return value == null || String(value).trim() === "" ? undefined : value;
}

export function reusableImageOutputCount(options: WorkflowOptions | undefined): 1 | 2 | undefined {
  const value = options?.gptImage?.outputCount ?? options?.nanoBanana?.outputCount;
  return value === 1 || value === 2 ? value : undefined;
}

export function reusableNanoBananaAspectRatio(options: WorkflowOptions | undefined) {
  return typeof options?.nanoBanana?.aspectRatio === "string"
    ? normalizeNanoBananaAspectRatio(options.nanoBanana.aspectRatio)
    : undefined;
}

export function reusableSeedanceRatio(options: WorkflowOptions | undefined) {
  return typeof options?.seedance?.ratio === "string" ? normalizeSeedanceRatio(options.seedance.ratio) : undefined;
}

/**
 * Which Seedance version the job ran on, if it recorded one.
 *
 * Undefined rather than the default for a job that has no version: those predate
 * the picker and reusing one should leave the current choice alone, not silently
 * reset it to 2.0.
 */
export function reusableSeedanceVersion(options: WorkflowOptions | undefined) {
  const version = options?.seedance?.version;
  return typeof version === "string" ? normalizeSeedanceVersion(version) : undefined;
}

export function reusableSeedanceVideoEditing(options: WorkflowOptions | undefined) {
  return typeof options?.seedance?.videoEditing === "boolean" ? options.seedance.videoEditing : undefined;
}

export async function rehydrateJobInputImages(job: Job, slotCount: number) {
  const limit = slotCount > 0 ? slotCount : job.inputImages.length;
  const hydrated = await Promise.all(
    job.inputImages.slice(0, limit).map((url, index) => rehydrateUploadedImage(url, index).catch(() => undefined)),
  );
  const nextImages: UploadedImage[] = [];
  hydrated.forEach((image, index) => {
    if (image) nextImages[index] = image;
  });
  return nextImages;
}

async function rehydrateUploadedImage(url: string, index: number): Promise<UploadedImage> {
  const media = await rehydrateMediaUrl(url, "image");
  const size = await getImageSize(media.url).catch(() => undefined);
  return {
    id: createClientId("img_"),
    name: mediaNameFromUrl(url, `input-image-${index + 1}`, media.type, "image"),
    url: media.url,
    cropRequired: false,
    width: size?.width,
    height: size?.height,
  };
}

export async function rehydrateJobInputVideo(url: string): Promise<UploadedVideo | undefined> {
  try {
    const media = await rehydrateMediaUrl(url, "video");
    return {
      id: createClientId("vid_"),
      name: mediaNameFromUrl(url, "input-video", media.type, "video"),
      url: media.url,
    };
  } catch {
    return undefined;
  }
}

async function rehydrateMediaUrl(url: string, expectedType: "image" | "video") {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return { url, type: mediaTypeFromDataUrl(url) };
  }

  const response = await fetch(url, mediaFetchInit(url));
  if (!response.ok) {
    throw new Error(`Could not read saved ${expectedType} (${response.status}).`);
  }

  const blob = await response.blob();
  if (blob.type && !blob.type.startsWith(`${expectedType}/`)) {
    throw new Error(`Saved input is not a ${expectedType}.`);
  }

  return {
    url: URL.createObjectURL(blob),
    type: blob.type,
  };
}

function mediaFetchInit(url: string): RequestInit {
  const token = getStoredAuthToken();
  if (!token || !isBackendApiUrl(url)) {
    return { credentials: "include" };
  }
  return {
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  };
}

function isBackendApiUrl(url: string) {
  try {
    return new URL(url, window.location.href).pathname.startsWith("/api/");
  } catch {
    return url.startsWith("/api/");
  }
}

function mediaTypeFromDataUrl(url: string) {
  return url.match(/^data:([^;,]+)/i)?.[1];
}

function mediaNameFromUrl(url: string, fallbackBase: string, type: string | undefined, expectedType: "image" | "video") {
  const fallback = `${fallbackBase}.${extensionForMediaType(type, expectedType)}`;
  if (url.startsWith("data:") || url.startsWith("blob:")) return fallback;

  try {
    const parsed = new URL(url, window.location.href);
    const pathLike = parsed.searchParams.get("path") ?? parsed.searchParams.get("filename") ?? parsed.pathname;
    const name = decodeURIComponent(pathLike.split(/[\\/]/).filter(Boolean).pop() ?? "");
    return sanitizeMediaName(name || fallback, fallback);
  } catch {
    return fallback;
  }
}

function sanitizeMediaName(name: string, fallback: string) {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || fallback
  );
}

function extensionForMediaType(type: string | undefined, expectedType: "image" | "video") {
  if (!type) return expectedType === "image" ? "png" : "mp4";
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("quicktime")) return "mov";
  return type.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || (expectedType === "image" ? "png" : "mp4");
}

function isVideoLikeJob(job: Pick<Job, "inputType" | "modelType" | "outputType" | "videoLength">) {
  const modelName = job.modelType.toLowerCase();
  return (
    job.outputType === "video" ||
    job.outputType === "sequence" ||
    Boolean(job.videoLength) ||
    job.inputType === "video" ||
    modelName.includes("video")
  );
}
