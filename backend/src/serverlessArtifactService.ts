import fs from "node:fs/promises";
import path from "node:path";
import { getUserById } from "./authService.js";
import { runpodOutputMaxBytes } from "./config.js";
import { detectMediaResolution, resolutionLabel } from "./mediaResolutionService.js";
import { relativePathFromOutputRoot, resolveProjectOutputRoot, withProjectMutationLock } from "./projectMetadataService.js";
import { projectFolderName } from "./projectFolderName.js";
import { assertManifestRecordSafe, ensureJobFolders, fallbackProjectFolder, readJsonFile, safeSegment, writeJsonFile } from "./storageService.js";
import { invalidateMediaCache } from "./mediaService.js";
import { responseBodyToNodeStream, writeStreamAtomically } from "./streamingMediaService.js";
import type { RunpodMediaResult } from "./runpodComfyService.js";
import type { Job, Project, Resolution, WorkflowModel } from "./types.js";

type AssetType = "image" | "video";

export type PersistedServerlessArtifact = {
  media: RunpodMediaResult;
  assetType: AssetType;
  url: string;
  remoteUrl: string;
  filePath?: string;
  jobFilePath?: string;
  fileName?: string;
  resolution?: Resolution;
  manifestRecord?: Record<string, unknown>;
  error?: string;
};

export type PersistServerlessArtifactsResult = {
  artifacts: PersistedServerlessArtifact[];
  selectedArtifacts: PersistedServerlessArtifact[];
  resultUrls: string[];
  thumbnailUrls: string[];
  outputResolution?: Resolution;
  manifestRecords: Array<Record<string, unknown>>;
};

type PersistServerlessArtifactsInput = {
  project: Project;
  job: Job;
  model: WorkflowModel;
  media: RunpodMediaResult[];
  selectedMedia: RunpodMediaResult[];
  fetchImpl?: typeof fetch;
};

type MediaSource = {
  contentType: string;
  writeTo: (filePath: string) => Promise<void>;
  cancel?: () => Promise<void>;
};

type BrickProjectFolders = {
  projectRoot: string;
  outputRoot: string;
  imagesRoot: string;
  videosRoot: string;
  sequencesRoot: string;
  metadataRoot: string;
  logsRoot: string;
};

export async function persistServerlessArtifacts({
  project,
  job,
  model,
  media,
  selectedMedia,
  fetchImpl = fetch,
}: PersistServerlessArtifactsInput): Promise<PersistServerlessArtifactsResult> {
  const folders = await ensureBrickProjectFolders(project, job.folderId);
  const jobFolders = await ensureJobFolders(project, job.id);
  const artifacts: PersistedServerlessArtifact[] = [];

  for (let index = 0; index < media.length; index += 1) {
    artifacts.push(await persistOneArtifact(media[index], index, { project, job, model, folders, jobOutputFolder: jobFolders.output, fetchImpl }));
  }

  const selectedArtifacts = selectedMedia
    .map((item) => artifacts[media.indexOf(item)])
    .filter((item): item is PersistedServerlessArtifact => Boolean(item));
  const resultUrls = selectedArtifacts.map((artifact) => artifact.url);
  const thumbnailUrls = artifacts
    .filter((artifact) => artifact.assetType === "image")
    .map((artifact) => artifact.url)
    .slice(0, 1);

  if (artifacts.some((artifact) => artifact.filePath)) {
    invalidateMediaCache();
  }

  return {
    artifacts,
    selectedArtifacts,
    resultUrls,
    thumbnailUrls,
    outputResolution: selectedArtifacts.find((artifact) => artifact.resolution)?.resolution,
    manifestRecords: artifacts.map((artifact) => artifact.manifestRecord).filter((item): item is Record<string, unknown> => Boolean(item)),
  };
}

async function persistOneArtifact(
  media: RunpodMediaResult,
  index: number,
  context: {
    project: Project;
    job: Job;
    model: WorkflowModel;
    folders: BrickProjectFolders;
    jobOutputFolder: string;
    fetchImpl: typeof fetch;
  },
): Promise<PersistedServerlessArtifact> {
  const assetType: AssetType = media.isVideo ? "video" : "image";
  let mediaSource: MediaSource | undefined;
  let reservationPath: string | undefined;

  try {
    mediaSource = await openMediaSource(media.url, context.fetchImpl);
    const extension = resultExtension(media, mediaSource.contentType, assetType);
    const target = await reserveArtifactTarget(context.project, context.job, context.model, context.folders, assetType, extension);
    reservationPath = target.reservationPath;
    await mediaSource.writeTo(target.filePath);
    const resolution = await detectMediaResolution(target.filePath, assetType).catch(() => undefined);

    const jobFileName = `${safeSegment(context.job.id)}_${String(index + 1).padStart(2, "0")}_${path.basename(target.filePath)}`;
    const jobFilePath = path.join(context.jobOutputFolder, jobFileName);
    await fs.copyFile(target.filePath, jobFilePath);

    const manifestRecord = buildManifestRecord({
      project: context.project,
      job: context.job,
      model: context.model,
      media,
      assetType,
      filePath: target.filePath,
      outputRoot: context.folders.outputRoot,
      version: target.version,
      modelPrefix: target.modelPrefix,
      cameraToken: target.cameraToken,
      cameraNumber: target.cameraNumber,
      shotToken: target.shotToken,
      shotNumber: target.shotNumber,
      outputResolution: resolution,
    });
    await appendManifestRecord(context.folders.metadataRoot, manifestRecord);

    return {
      media: safeMediaRecord(media),
      assetType,
      url: mediaUrl(target.filePath),
      remoteUrl: safeRemoteUrl(media, target.filePath),
      filePath: target.filePath,
      jobFilePath,
      fileName: path.basename(target.filePath),
      resolution,
      manifestRecord,
    };
  } catch (error) {
    await mediaSource?.cancel?.().catch(() => undefined);
    return {
      media: safeMediaRecord(media),
      assetType,
      url: safeRemoteUrl(media),
      remoteUrl: safeRemoteUrl(media),
      error: error instanceof Error ? error.message : "Could not persist serverless output media.",
    };
  } finally {
    if (reservationPath) {
      await fs.rm(reservationPath, { force: true }).catch(() => undefined);
    }
  }
}

async function ensureBrickProjectFolders(project: Project, folderId?: string | null): Promise<BrickProjectFolders> {
  const projectRoot = project.folderPath || fallbackProjectFolder(project);
  const outputRoot = (await resolveProjectOutputRoot(project, folderId)).root;
  const folders = {
    projectRoot,
    outputRoot,
    imagesRoot: path.join(outputRoot, "images"),
    videosRoot: path.join(outputRoot, "videos"),
    sequencesRoot: path.join(outputRoot, "sequences"),
    metadataRoot: path.join(projectRoot, "metadata"),
    logsRoot: path.join(projectRoot, "logs"),
  };

  for (const folder of Object.values(folders)) {
    await fs.mkdir(folder, { recursive: true });
  }

  return folders;
}

async function openMediaSource(value: string, fetchImpl: typeof fetch): Promise<MediaSource> {
  if (value.startsWith("data:")) {
    return dataUrlMediaSource(value);
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new Error("RunPod output media was not a data URL or http(s) URL.");
  }

  const response = await fetchImpl(value, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) {
    throw new Error(`Could not download RunPod output media: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > runpodOutputMaxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`RunPod output is ${formatBytes(contentLength)}, above the ${formatBytes(runpodOutputMaxBytes)} limit.`);
  }

  return {
    contentType: response.headers.get("content-type") ?? "",
    writeTo: (filePath) => writeStreamAtomically(responseBodyToNodeStream(response), filePath, runpodOutputMaxBytes).then(() => undefined),
    cancel: () => response.body?.cancel().then(() => undefined) ?? Promise.resolve(),
  };
}

function dataUrlMediaSource(value: string): MediaSource {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0 || !value.startsWith("data:")) {
    throw new Error("Unsupported RunPod output data URL.");
  }

  const header = value.slice(5, commaIndex);
  const isBase64 = header.endsWith(";base64");
  const contentType = (isBase64 ? header.slice(0, -";base64".length) : header).split(";")[0];
  const payload = value.slice(commaIndex + 1);
  const byteLength = isBase64 ? estimateBase64Bytes(payload) : Buffer.byteLength(decodeURIComponent(payload), "utf8");
  if (byteLength > runpodOutputMaxBytes) {
    throw new Error(`Embedded RunPod output is ${formatBytes(byteLength)}, above the ${formatBytes(runpodOutputMaxBytes)} limit.`);
  }

  return {
    contentType,
    writeTo: async (filePath) => {
      const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
      await fs.writeFile(filePath, buffer);
    },
  };
}

function estimateBase64Bytes(base64: string) {
  const clean = base64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib >= 1 ? mib.toFixed(1) : (value / 1024).toFixed(1)} ${mib >= 1 ? "MiB" : "KiB"}`;
}

async function reserveArtifactTarget(
  project: Project,
  job: Job,
  model: WorkflowModel,
  folders: BrickProjectFolders,
  assetType: AssetType,
  extension: string,
) {
  return withProjectMutationLock(project, async () => {
    const projectName = projectFolderName(folders.projectRoot);
    const date = todayCompact();
    const modelPrefix = normalizeModelPrefix(model.name || model.id);
    const prefixToken = normalizeModelPrefix(modelPrefix);
    const cameraNumber = normalizedSaveNumber(job.workflowOptions?.save?.cameraNumber ?? job.workflowOptions?.save?.shotNumber);
    const shotNumber = normalizedSaveNumber(job.workflowOptions?.save?.shotNumber ?? job.workflowOptions?.save?.cameraNumber);
    const cameraToken = normalizeCameraNumber(cameraNumber);
    const shotToken = normalizeShotNumber(shotNumber);
    const versionItem = assetType === "image"
      ? [prefixToken, cameraToken].filter(Boolean).join("|") || cameraToken
      : [prefixToken, shotToken].filter(Boolean).join("|") || shotToken;
    const versionKey = `${assetType}|${projectName}|${versionItem}`;
    const scopedVersionKey = job.folderId ? `${assetType}|${projectName}|${job.folderId}|${versionItem}` : versionKey;

    for (let attempts = 0; attempts < 1000; attempts += 1) {
      const version = await reserveNextVersion(folders.metadataRoot, scopedVersionKey);
      const filePath = assetType === "image"
        ? path.join(folders.imagesRoot, date, `${imageStem(date, projectName, cameraToken, version, modelPrefix)}${extension}`)
        : path.join(folders.videosRoot, shotToken, `${sequenceStem(date, projectName, shotNumber, version, modelPrefix)}${extension}`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const reservationPath = `${filePath}.momi-reservation`;
      let reservation: fs.FileHandle | undefined;
      try {
        reservation = await fs.open(reservationPath, "wx");
        await reservation.writeFile(JSON.stringify({ jobId: job.id, createdAt: new Date().toISOString() }), "utf8");
        if (await fileExists(filePath)) {
          await reservation.close();
          reservation = undefined;
          await fs.rm(reservationPath, { force: true });
          continue;
        }
        await reservation.close();
        reservation = undefined;
        return { filePath, reservationPath, version, modelPrefix, cameraToken, cameraNumber, shotToken, shotNumber };
      } catch (error) {
        await reservation?.close().catch(() => undefined);
        const code = typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "EEXIST") continue;
        await fs.rm(reservationPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    throw new Error("Could not reserve a unique Brick output filename.");
  });
}

async function reserveNextVersion(metadataRoot: string, key: string) {
  const versionsPath = path.join(metadataRoot, "latest_versions.json");
  const versions = await readJsonFile<Record<string, unknown>>(versionsPath, {});
  const current = Number(versions[key] ?? 0);
  const next = Number.isFinite(current) ? Math.max(0, Math.floor(current)) + 1 : 1;
  versions[key] = next;
  await writeJsonFile(versionsPath, versions);
  return next;
}

function buildManifestRecord({
  project,
  job,
  model,
  media,
  assetType,
  filePath,
  outputRoot,
  version,
  modelPrefix,
  cameraToken,
  cameraNumber,
  shotToken,
  shotNumber,
  outputResolution,
}: {
  project: Project;
  job: Job;
  model: WorkflowModel;
  media: RunpodMediaResult;
  assetType: AssetType;
  filePath: string;
  outputRoot: string;
  version: number;
  modelPrefix: string;
  cameraToken: string;
  cameraNumber: number;
  shotToken: string;
  shotNumber: number;
  outputResolution?: Resolution;
}) {
  const user = getUserById(job.userId);
  const userName = user?.displayName || user?.name || user?.username || job.userId;
  const projectName = projectFolderName(project.folderPath || fallbackProjectFolder(project));
  const creditUsage = job.creditUsage;
  const creditsUsed = creditUsage?.total_estimated_credits ?? job.creditsUsed ?? 0;
  const resolution = resolutionText(job);
  const promptId = `runpod:${job.runpodJobId ?? job.id}`;
  const record: Record<string, unknown> = {
    timestamp_utc: utcTimestamp(),
    asset_type: assetType,
    source: "runpod_serverless",
    project_name: projectName,
    project_display_name: project.name,
    project_id: project.id,
    projectId: project.id,
    project_code: projectCode(projectName),
    folder_id: job.folderId ?? null,
    folderId: job.folderId ?? null,
    job_id: job.id,
    jobId: job.id,
    title: job.title ?? "",
    runpod_job_id: job.runpodJobId ?? "",
    runpod_status: job.runpodStatus ?? "",
    prompt_id: promptId,
    user_id: job.userId,
    userId: job.userId,
    user_name: userName,
    userName,
    model_id: job.modelId,
    model_name: job.modelName,
    model_prefix: modelPrefix,
    model_prefix_token: normalizeModelPrefix(modelPrefix),
    workflowPath: job.workflowPath,
    workflow_path: job.workflowPath,
    workflow_snapshot_path: job.workflowSnapshotPath ?? "",
    prompt: job.prompt ?? "",
    prompt_text: job.prompt ?? "",
    resolution,
    width: job.resolution?.width,
    height: job.resolution?.height,
    output_resolution: resolutionLabel(outputResolution),
    output_width: outputResolution?.width,
    output_height: outputResolution?.height,
    durationSeconds: job.durationSeconds ?? 0,
    duration_seconds: job.durationSeconds ?? 0,
    file_path: filePath,
    relativePath: relativePathFromOutputRoot(outputRoot, filePath),
    remote_url: safeRemoteUrl(media, filePath),
    output_source: media.source,
    output_type: media.type ?? "",
    output_filename: media.filename ?? "",
    credits_used: creditsUsed,
    creditsUsed,
    credit_usage: creditUsage ?? null,
    total_estimated_credits: creditUsage?.total_estimated_credits,
    total_estimated_usd: creditUsage?.total_estimated_usd,
    credit_source: creditUsage?.source,
    input_image: safeMetadataMediaRef(job.inputImages[0] ?? ""),
    inputImages: job.inputImages.map(safeMetadataMediaRef),
    input_images: job.inputImages.map(safeMetadataMediaRef),
    version,
    backend_model_id: model.id,
    backend_workflow_path: model.workflowPath,
  };

  if (assetType === "image") {
    record.camera_mode = "camera_number";
    record.camera_number = cameraNumber;
    record.camera_token = cameraToken;
  } else {
    record.shot_number = shotNumber;
    record.shot_token = shotToken;
  }

  return record;
}

async function appendManifestRecord(metadataRoot: string, record: Record<string, unknown>) {
  await fs.mkdir(metadataRoot, { recursive: true });
  const line = assertManifestRecordSafe(record, "manifest.jsonl");
  await fs.appendFile(path.join(metadataRoot, "manifest.jsonl"), `${line}\n`, "utf8");
}

function safeMediaRecord(media: RunpodMediaResult): RunpodMediaResult {
  if (!media.url.startsWith("data:")) return media;
  return {
    ...media,
    url: "[embedded data URL omitted]",
  };
}

function safeRemoteUrl(media: RunpodMediaResult, filePath?: string) {
  if (!media.url.startsWith("data:")) return media.url;
  return filePath ? mediaUrl(filePath) : "[embedded data URL omitted]";
}

function safeMetadataMediaRef(value: string) {
  return value.startsWith("data:") ? "[embedded data URL omitted]" : value;
}

function resultExtension(media: RunpodMediaResult, contentType: string, assetType: AssetType) {
  const filenameExtension = cleanExtension(path.extname(media.filename ?? ""));
  if (filenameExtension) return filenameExtension;

  try {
    const url = new URL(media.url);
    const name = url.searchParams.get("filename") || url.searchParams.get("path") || path.basename(url.pathname);
    const urlExtension = cleanExtension(path.extname(name));
    if (urlExtension) return urlExtension;
  } catch {
    const localExtension = cleanExtension(path.extname(media.url));
    if (localExtension) return localExtension;
  }

  const mimeExtension = extensionFromContentType(contentType);
  if (mimeExtension) return mimeExtension;
  return assetType === "video" ? ".mp4" : ".png";
}

function cleanExtension(extension: string) {
  const clean = extension.toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(clean)) return "";
  return clean;
}

function extensionFromContentType(contentType: string) {
  const clean = contentType.toLowerCase();
  if (clean.includes("image/jpeg")) return ".jpg";
  if (clean.includes("image/png")) return ".png";
  if (clean.includes("image/webp")) return ".webp";
  if (clean.includes("image/gif")) return ".gif";
  if (clean.includes("video/mp4")) return ".mp4";
  if (clean.includes("video/quicktime")) return ".mov";
  if (clean.includes("video/webm")) return ".webm";
  if (clean.includes("video/x-matroska")) return ".mkv";
  if (clean.includes("video/x-msvideo")) return ".avi";
  return "";
}

function imageStem(date: string, projectName: string, cameraToken: string, version: number, modelPrefix: string) {
  return applyModelPrefix(date, `${projectCode(projectName)}_${cameraToken}_${normalizeVersion(version)}`, modelPrefix);
}

function sequenceStem(date: string, projectName: string, shotNumber: number, version: number, modelPrefix: string) {
  return applyModelPrefix(date, `${projectCode(projectName)}_${normalizeShotNumber(shotNumber)}_${normalizeVersion(version)}`, modelPrefix);
}

function applyModelPrefix(date: string, stemAfterDate: string, modelPrefix: string) {
  const prefix = normalizeModelPrefix(modelPrefix);
  return prefix ? `${date}_${prefix}_${stemAfterDate}` : `${date}_${stemAfterDate}`;
}

function projectCode(projectName: string) {
  const leadingDigits = projectName.match(/\D*(\d{4,})/);
  if (leadingDigits) return leadingDigits[1].slice(0, 4);

  const anyDigits = projectName.replace(/\D/g, "");
  if (anyDigits.length >= 4) return anyDigits.slice(0, 4);

  const alnum = sanitizeForFilename(projectName, "PROJ").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (alnum.slice(0, 4) || "PROJ").padEnd(4, "0");
}

function normalizeVersion(version: number) {
  return `v${Math.max(0, Math.floor(version)).toString().padStart(3, "0")}`;
}

function normalizeCameraNumber(value: number) {
  return `cam-${Math.max(0, Math.floor(value)).toString().padStart(2, "0")}`;
}

function normalizeShotNumber(value: number) {
  return `SHOT_${Math.max(0, Math.floor(value)).toString().padStart(4, "0")}`;
}

function normalizeModelPrefix(value: string) {
  return sanitizeForFilename(value, "", 48)
    .replace(/\s+/g, "-")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[ ._-]+|[ ._-]+$/g, "")
    .toLowerCase();
}

function sanitizeForFilename(value: string, fallback = "", maxLength = 140) {
  const clean = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (clean || fallback).slice(0, maxLength);
}

function normalizedSaveNumber(value: string | number | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return Number(digits || "0");
}

function todayCompact() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

function utcTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolutionText(job: Job) {
  if (job.resolution?.label) return job.resolution.label;
  if (job.resolution) return `${job.resolution.width}x${job.resolution.height}`;
  return "";
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
