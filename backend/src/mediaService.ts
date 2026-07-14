import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { detectMediaResolution, resolutionLabel } from "./mediaResolutionService.js";
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
const MEDIA_SCAN_CACHE_MS = 15_000;

export async function scanExistingMediaJobs() {
  if (mediaCache && Date.now() - mediaCache.createdAt < MEDIA_SCAN_CACHE_MS) {
    return mediaCache.jobs;
  }
  const projects = getProjects();
  const jobs = (await Promise.all(projects.map(scanProjectMedia))).flat();
  const sortedJobs = jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  mediaCache = { createdAt: Date.now(), jobs: sortedJobs };
  return sortedJobs;
}

export function invalidateMediaCache() {
  mediaCache = undefined;
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
      ...images.map((filePath) => mediaJob(project, target, filePath, "image", manifest)),
      ...videos.map((filePath) => mediaJob(project, target, filePath, "video", manifest)),
      ...sequences.map((sequence) => sequenceJob(project, target, sequence, manifest)),
    ])
  ).flat();
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
    fileName: path.basename(sequence.folderPath),
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
