import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { mediaIndexRefreshMs } from "./config.js";
import {
  closeSharedMediaIndexStore,
  getSharedMediaIndexStore,
  initializeSharedMediaIndexStore,
  invalidateSharedMediaIndex,
  registerMediaIndexInvalidationListener,
} from "./mediaIndexCoordinator.js";
import { detectMediaResolution, resolutionLabel } from "./mediaResolutionService.js";
import { isDispatcher } from "./processRole.js";
import { projectFolderName } from "./projectFolderName.js";
import { getProjects } from "./projectService.js";
import { loadProjectFolders, resolveProjectMediaPath } from "./projectMetadataService.js";
import type { Job, Project, ProjectFolder, Resolution } from "./types.js";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".exr"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".gif"]);
const previewLimitedExtensions = new Set([".tif", ".tiff", ".exr", ".avi", ".mkv"]);

type ManifestRecord = Record<string, any>;
type ManifestSaveNumber = {
  cameraNumber?: string;
  shotNumber?: string;
};
type ManifestIndex = {
  records: Map<string, ManifestRecord>;
  jobTitles: Map<string, string>;
  jobSaveNumbers: Map<string, ManifestSaveNumber>;
};
type ScanTarget = {
  folderId: string | null;
  folderName?: string;
  root: string;
};
let mediaCache: { createdAt: number; jobs: Job[] } | undefined;
let mediaScanVersion = 0;
let mediaScanInFlight: { version: number; promise: Promise<Job[]> } | undefined;
let sharedMediaCache: { revision: number; jobs: Job[] } | undefined;
let sharedMediaRefreshInFlight: Promise<Job[]> | undefined;
let sharedMediaRefreshTimer: NodeJS.Timeout | undefined;
const MEDIA_SCAN_CACHE_MS = Math.max(15_000, Number(process.env.MEDIA_SCAN_CACHE_MS ?? 60_000) || 60_000);
const MEDIA_METADATA_CONCURRENCY = boundedPositiveInteger(process.env.MEDIA_METADATA_CONCURRENCY, 32, 128);
let activeMediaMetadataReads = 0;
const mediaMetadataWaiters: Array<() => void> = [];

registerMediaIndexInvalidationListener(() => {
  mediaScanVersion += 1;
  mediaCache = undefined;
});

export async function scanExistingMediaJobs() {
  const sharedStore = getSharedMediaIndexStore();
  if (sharedStore) {
    const state = sharedStore.loadState();
    if (isDispatcher() && state.dirtyRevision > state.builtRevision) {
      await refreshSharedMediaIndex();
    }
    return loadSharedMediaIndex();
  }

  if (mediaCache && Date.now() - mediaCache.createdAt < MEDIA_SCAN_CACHE_MS) {
    return mediaCache.jobs;
  }

  if (mediaScanInFlight?.version === mediaScanVersion) {
    return mediaScanInFlight.promise;
  }

  const version = mediaScanVersion;
  const promise = scanExistingMediaJobsUncached(version);
  mediaScanInFlight = { version, promise };

  try {
    return await promise;
  } finally {
    if (mediaScanInFlight?.promise === promise) {
      mediaScanInFlight = undefined;
    }
  }
}

async function scanExistingMediaJobsUncached(version: number) {
  const sortedJobs = await scanExistingMediaJobsFromDisk();
  if (version === mediaScanVersion) {
    mediaCache = { createdAt: Date.now(), jobs: sortedJobs };
  }
  return sortedJobs;
}

async function scanExistingMediaJobsFromDisk() {
  const projects = getProjects();
  const jobs = (await Promise.all(projects.map(scanProjectMedia))).flat();
  return jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function invalidateMediaCache() {
  invalidateSharedMediaIndex();
}

export async function initializeMediaIndex() {
  closeMediaIndex();
  const sharedStore = initializeSharedMediaIndexStore();
  sharedMediaCache = undefined;
  if (!sharedStore || !isDispatcher()) return;

  await refreshSharedMediaIndex({ force: true });
  sharedMediaRefreshTimer = setInterval(() => {
    void refreshSharedMediaIndex().catch((error) => {
      console.error(`Could not refresh shared media index: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(100, mediaIndexRefreshMs));
  sharedMediaRefreshTimer.unref?.();
}

export function closeMediaIndex() {
  if (sharedMediaRefreshTimer) {
    clearInterval(sharedMediaRefreshTimer);
    sharedMediaRefreshTimer = undefined;
  }
  closeSharedMediaIndexStore();
  sharedMediaCache = undefined;
  sharedMediaRefreshInFlight = undefined;
}

export function getMediaIndexStatus() {
  const sharedStore = getSharedMediaIndexStore();
  if (sharedStore) {
    const state = sharedStore.loadState();
    return {
      driver: "sqlite" as const,
      dirtyRevision: state.dirtyRevision,
      builtRevision: state.builtRevision,
      publishedAt: state.publishedAt,
      cachedRevision: sharedMediaCache?.revision,
      cachedItems: sharedMediaCache?.jobs.length ?? 0,
    };
  }
  return {
    driver: "local" as const,
    cachedItems: mediaCache?.jobs.length ?? 0,
    cachedAt: mediaCache ? new Date(mediaCache.createdAt).toISOString() : undefined,
  };
}

export function refreshSharedMediaIndex(options: { force?: boolean } = {}) {
  const sharedStore = getSharedMediaIndexStore();
  if (!sharedStore || !isDispatcher()) return Promise.resolve(sharedMediaCache?.jobs ?? []);
  if (sharedMediaRefreshInFlight) return sharedMediaRefreshInFlight;

  sharedMediaRefreshInFlight = (async () => {
    let state = sharedStore.loadState();
    const publishedAt = state.publishedAt ? new Date(state.publishedAt).getTime() : 0;
    const periodicallyStale = !Number.isFinite(publishedAt) || Date.now() - publishedAt >= MEDIA_SCAN_CACHE_MS;
    if (state.dirtyRevision <= state.builtRevision) {
      if (!options.force && !periodicallyStale) return loadSharedMediaIndex();
      sharedStore.invalidate();
      state = sharedStore.loadState();
    }

    const revision = state.dirtyRevision;
    const jobs = await scanExistingMediaJobsFromDisk();
    sharedStore.publish(revision, jobs);
    return loadSharedMediaIndex();
  })().finally(() => {
    sharedMediaRefreshInFlight = undefined;
  });
  return sharedMediaRefreshInFlight;
}

function loadSharedMediaIndex() {
  const sharedStore = getSharedMediaIndexStore();
  if (!sharedStore) return [];
  const published = sharedStore.loadPublishedIfNewer(sharedMediaCache?.revision ?? -1);
  if (published) {
    sharedMediaCache = { revision: published.builtRevision, jobs: published.jobs };
  }
  return sharedMediaCache?.jobs ?? [];
}

async function scanProjectMedia(project: Project): Promise<Job[]> {
  const folders = (await loadProjectFolders(project)).filter((folder) => !folder.archived);
  const manifest = await readManifest(project, folders);
  const targets: ScanTarget[] = [
    { folderId: null, folderName: "Root", root: project.folderPath },
    ...folders.map((folder) => ({
      folderId: folder.folderId,
      folderName: folder.name,
      root: path.join(project.folderPath, "folders", folder.diskName),
    })),
  ];

  return (await Promise.all(targets.map((target) => scanMediaTarget(project, target, manifest)))).flat();
}

async function scanMediaTarget(project: Project, target: ScanTarget, manifest: ManifestIndex): Promise<Job[]> {
  const [imageFiles, videoFiles, sequences] = await Promise.all([
    scanFiles(path.join(target.root, "images"), imageExtensions),
    scanFiles(path.join(target.root, "videos"), videoExtensions),
    scanSequences(path.join(target.root, "sequences")),
  ]);
  const mediaFiles = [...imageFiles, ...videoFiles];
  const sequenceFramePaths = new Set(sequences.flatMap((sequence) => sequence.files.map(normalizePath)));
  const images = mediaFiles.filter((filePath) => imageExtensions.has(path.extname(filePath).toLowerCase()) && !sequenceFramePaths.has(normalizePath(filePath)));
  const videos = mediaFiles.filter((filePath) => videoExtensions.has(path.extname(filePath).toLowerCase()));

  return (
    await Promise.all([
      ...images.map((filePath) => withMediaMetadataSlot(() => mediaJob(project, target, filePath, "image", manifest))),
      ...videos.map((filePath) => withMediaMetadataSlot(() => mediaJob(project, target, filePath, "video", manifest))),
      ...sequences.map((sequence) => withMediaMetadataSlot(() => sequenceJob(project, target, sequence, manifest))),
    ])
  ).flat();
}

async function withMediaMetadataSlot<T>(operation: () => Promise<T>) {
  const release = await acquireMediaMetadataSlot();
  try {
    return await operation();
  } finally {
    release();
  }
}

function acquireMediaMetadataSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const start = () => {
      activeMediaMetadataReads += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeMediaMetadataReads = Math.max(0, activeMediaMetadataReads - 1);
        mediaMetadataWaiters.shift()?.();
      });
    };

    if (activeMediaMetadataReads < MEDIA_METADATA_CONCURRENCY) {
      start();
    } else {
      mediaMetadataWaiters.push(start);
    }
  });
}

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

async function scanFiles(root: string, extensions: Set<string>): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) return scanFiles(fullPath, extensions);
        if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) return [fullPath];
        return [];
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

async function scanSequences(root: string) {
  const frameFiles = await scanFiles(root, imageExtensions);
  const byFolder = new Map<string, string[]>();
  for (const filePath of frameFiles) {
    const folder = path.dirname(filePath);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), filePath]);
  }
  return Array.from(byFolder.entries()).map(([folderPath, files]) => ({
    folderPath,
    files: files.sort((a, b) => a.localeCompare(b)),
  }));
}

async function mediaJob(project: Project, target: ScanTarget, filePath: string, outputType: "image" | "video", manifestIndex: ManifestIndex): Promise<Job> {
  const manifest = manifestIndex.records.get(normalizePath(filePath));
  const stat = await fs.stat(filePath).catch(() => undefined);
  const fileName = path.basename(filePath);
  const createdAt = manifest?.timestamp_utc || stat?.mtime?.toISOString() || new Date().toISOString();
  const modelName = modelNameFromManifest(manifest);
  const missingMetadata = missingFields(manifest, ["prompt", "model name", "workflow path", "resolution", "user name", "user ID", "credits used", "ComfyUI prompt ID", "original input image"]);
  const limitedPreview = previewLimitedExtensions.has(path.extname(filePath).toLowerCase());
  const jobId = manifestJobId(manifest) ?? existingId(project.id, filePath);
  const title = manifestTitle(manifest, manifestIndex.jobTitles.get(jobId));
  const workflowOptions = manifestWorkflowOptions(manifest, manifestIndex.jobSaveNumbers.get(jobId));
  const outputResolution = manifestOutputResolution(manifest)
    ?? (outputType === "image" ? await detectMediaResolution(filePath, outputType).catch(() => undefined) : undefined);

  return {
    id: jobId,
    projectId: project.id,
    folderId: target.folderId,
    folderName: target.folderName,
    userId: "unknown_user",
    modelId: "existing_project_media",
    modelName,
    title,
    category: outputType === "video" ? "video_editing" : "image_editing",
    inputType: "single_image",
    prompt: manifest?.prompt_text || manifest?.prompt || "Missing prompt data",
    resolution: manifestRequestedResolution(manifest),
    outputResolution,
    durationSeconds: durationFromManifest(manifest),
    status: "completed",
    inputImages: [],
    resultUrls: [mediaUrl(filePath)],
    thumbnailUrls: outputType === "image" ? [mediaUrl(filePath)] : [],
    outputType,
    projectFolderPath: target.root,
    workflowPath: manifest?.workflowPath || "",
    ...(workflowOptions ? { workflowOptions } : {}),
    creditsUsed: undefined,
    createdAt,
    completedAt: createdAt,
    fileName,
    source: "existing_project_media",
    missingMetadata: limitedPreview ? [...missingMetadata, "limited browser preview"] : missingMetadata,
  };
}

async function sequenceJob(project: Project, target: ScanTarget, sequence: { folderPath: string; files: string[] }, manifestIndex: ManifestIndex): Promise<Job> {
  const manifest = manifestIndex.records.get(normalizePath(sequence.folderPath));
  const stat = await fs.stat(sequence.folderPath).catch(() => undefined);
  const firstFrame = sequence.files[0];
  const createdAt = manifest?.timestamp_utc || stat?.mtime?.toISOString() || new Date().toISOString();
  const missingMetadata = missingFields(manifest, ["prompt", "model name", "workflow path", "resolution", "user name", "user ID", "credits used", "ComfyUI prompt ID", "original input image"]);
  const jobId = manifestJobId(manifest) ?? existingId(project.id, sequence.folderPath);
  const title = manifestTitle(manifest, manifestIndex.jobTitles.get(jobId));
  const workflowOptions = manifestWorkflowOptions(manifest, manifestIndex.jobSaveNumbers.get(jobId));
  const outputResolution = manifestOutputResolution(manifest)
    ?? (firstFrame ? await detectMediaResolution(firstFrame, "sequence").catch(() => undefined) : undefined);

  return {
    id: jobId,
    projectId: project.id,
    folderId: target.folderId,
    folderName: target.folderName,
    userId: "unknown_user",
    modelId: "existing_project_media",
    modelName: modelNameFromManifest(manifest),
    title,
    category: "video_editing",
    inputType: "single_image",
    prompt: manifest?.prompt_text || manifest?.prompt || "Missing prompt data",
    resolution: manifestRequestedResolution(manifest),
    outputResolution,
    durationSeconds: durationFromManifest(manifest),
    status: "completed",
    inputImages: [],
    resultUrls: firstFrame ? [mediaUrl(firstFrame)] : [],
    thumbnailUrls: firstFrame ? [mediaUrl(firstFrame)] : [],
    outputType: "sequence",
    projectFolderPath: target.root,
    workflowPath: manifest?.workflowPath || "",
    ...(workflowOptions ? { workflowOptions } : {}),
    createdAt,
    completedAt: createdAt,
    fileName: projectFolderName(sequence.folderPath),
    source: "existing_project_media",
    missingMetadata,
  };
}

async function readManifest(project: Project, folders: ProjectFolder[]): Promise<ManifestIndex> {
  const records = new Map<string, ManifestRecord>();
  const jobTitles = new Map<string, string>();
  const jobSaveNumbers = new Map<string, ManifestSaveNumber>();
  const manifestPath = path.join(project.folderPath, "metadata", "manifest.jsonl");
  const foldersById = new Map(folders.map((folder) => [folder.folderId, folder]));
  try {
    const lines = createInterface({
      input: createReadStream(manifestPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as ManifestRecord;
      sanitizeManifestRecord(record);
      if (record.event === "job.renamed") {
        const jobId = stringField(record.jobId) || stringField(record.job_id);
        const title = stringField(record.title) || stringField(record.newTitle) || stringField(record.new_title);
        if (jobId && title) jobTitles.set(jobId, title);
        continue;
      }
      if (record.event === "job.saveNumber.updated") {
        const jobId = stringField(record.jobId) || stringField(record.job_id);
        const cameraNumber = normalizeManifestSaveNumber(record.cameraNumber ?? record.camera_number);
        const shotNumber = normalizeManifestSaveNumber(record.shotNumber ?? record.shot_number);
        if (jobId && (cameraNumber || shotNumber)) {
          jobSaveNumbers.set(jobId, { cameraNumber, shotNumber });
        }
        continue;
      }
      if (record.event === "job.moved") {
        applyManifestMove(records, record);
        continue;
      }
      const folderId = manifestFolderId(record);
      if (folderId && !foldersById.has(folderId)) {
        continue;
      }
      if (typeof record.relativePath === "string") {
        try {
          const resolved = await resolveProjectMediaPath(project, folderId, record.relativePath);
          if (resolved) records.set(normalizePath(resolved), record);
        } catch {
          // Fall back to legacy absolute file_path matching below.
        }
      }
      if (typeof record.file_path === "string") {
        records.set(normalizePath(record.file_path), record);
      }
    }
  } catch {
    return { records, jobTitles, jobSaveNumbers };
  }
  return { records, jobTitles, jobSaveNumbers };
}

function applyManifestMove(records: Map<string, ManifestRecord>, event: ManifestRecord) {
  const files = Array.isArray(event.files) ? event.files : [];
  const destinationFolderId = stringField(event.destinationFolderId) || null;
  for (const value of files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const file = value as Record<string, unknown>;
    const from = stringField(file.from);
    const to = stringField(file.to);
    if (!from || !to) continue;

    const fromPath = path.resolve(from);
    const toPath = path.resolve(to);
    for (const [recordPath, original] of Array.from(records.entries())) {
      const relative = path.relative(fromPath, path.resolve(recordPath));
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const movedPath = relative ? path.join(toPath, relative) : toPath;
      const toRelativePath = stringField(file.toRelativePath);
      records.set(normalizePath(movedPath), {
        ...original,
        folder_id: destinationFolderId,
        folderId: destinationFolderId,
        file_path: movedPath,
        relativePath: relative
          ? path.join(toRelativePath, relative).replaceAll("\\", "/")
          : toRelativePath || original.relativePath,
      });
    }
  }
}

function sanitizeManifestRecord(record: ManifestRecord) {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.startsWith("data:")) {
      record[key] = "[embedded data URL omitted]";
    }
  }
}

function modelNameFromManifest(manifest?: ManifestRecord) {
  const prefix = manifest?.model_prefix || manifest?.model_prefix_token;
  return typeof prefix === "string" && prefix.trim() ? prefix.trim() : "Unknown model";
}

function durationFromManifest(manifest?: ManifestRecord) {
  const raw = manifest?.durationSeconds ?? manifest?.duration_seconds ?? manifest?.duration;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
  return value && Number.isFinite(value) ? value : undefined;
}

function manifestRequestedResolution(manifest?: ManifestRecord) {
  return resolutionFromManifestFields(manifest?.width, manifest?.height, manifest?.resolution);
}

function manifestOutputResolution(manifest?: ManifestRecord) {
  return resolutionFromManifestFields(
    manifest?.output_width ?? manifest?.outputWidth,
    manifest?.output_height ?? manifest?.outputHeight,
    manifest?.output_resolution ?? manifest?.outputResolution,
  );
}

function resolutionFromManifestFields(widthValue: unknown, heightValue: unknown, labelValue: unknown): Resolution | undefined {
  const width = numberField(widthValue);
  const height = numberField(heightValue);
  if (!width || !height) return undefined;
  const resolution = { width, height };
  return { ...resolution, label: stringField(labelValue) || resolutionLabel(resolution) };
}

function numberField(value: unknown) {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  if (!numberValue || !Number.isFinite(numberValue) || numberValue <= 0) return undefined;
  return Math.round(numberValue);
}

function manifestJobId(manifest?: ManifestRecord) {
  return stringField(manifest?.jobId) || stringField(manifest?.job_id);
}

function manifestFolderId(manifest?: ManifestRecord) {
  const folderId = stringField(manifest?.folderId) || stringField(manifest?.folder_id);
  return folderId || null;
}

function manifestTitle(manifest: ManifestRecord | undefined, renameTitle: string | undefined) {
  return renameTitle || stringField(manifest?.title) || undefined;
}

function manifestWorkflowOptions(manifest: ManifestRecord | undefined, updatedSaveNumber: ManifestSaveNumber | undefined) {
  const cameraNumber = updatedSaveNumber?.cameraNumber ?? normalizeManifestSaveNumber(manifest?.cameraNumber ?? manifest?.camera_number);
  const shotNumber = updatedSaveNumber?.shotNumber ?? normalizeManifestSaveNumber(manifest?.shotNumber ?? manifest?.shot_number);
  if (!cameraNumber && !shotNumber) return undefined;

  return {
    save: {
      ...(cameraNumber ? { cameraNumber } : {}),
      ...(shotNumber ? { shotNumber } : {}),
    },
  };
}

function normalizeManifestSaveNumber(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return digits ? digits.padStart(4, "0") : undefined;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function missingFields(manifest: ManifestRecord | undefined, fields: string[]) {
  if (!manifest) return fields;
  return fields.filter((field) => {
    if (field === "model name") return !manifest.model_prefix && !manifest.model_prefix_token;
    if (field === "workflow path") return !manifest.workflowPath && !manifest.workflow_path;
    if (field === "ComfyUI prompt ID") return !manifest.prompt_id;
    if (field === "credits used") return !manifest.credits_used && !manifest.creditsUsed;
    if (field === "user name") return !manifest.user_name && !manifest.userName;
    if (field === "user ID") return !manifest.user_id && !manifest.userId;
    if (field === "original input image") return !manifest.input_image && !manifest.inputImages;
    return !manifest[field.replaceAll(" ", "_")];
  });
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

function existingId(projectId: string, value: string) {
  const hash = crypto.createHash("sha1").update(`${projectId}|${normalizePath(value)}`).digest("hex").slice(0, 20);
  return `existing_${hash}`;
}

function normalizePath(value: string) {
  return path.resolve(value).toLowerCase();
}
