import fs from "node:fs/promises";
import path from "node:path";
import { localProjectsRoot } from "./config.js";
import type { Job, Project } from "./types.js";

export const MAX_METADATA_STRING_LENGTH = 100_000;
export const MAX_JSON_METADATA_BYTES = 10 * 1024 * 1024;
export const MAX_MANIFEST_LINE_BYTES = 256 * 1024;

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_JSON_METADATA_BYTES) {
      throw new Error(`Metadata JSON file is too large: ${filePath} (${stat.size} bytes)`);
    }
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Metadata JSON file is too large")) {
      console.warn(error.message);
    }
    return fallback;
  }
}

export async function writeJsonFile(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  assertNoEmbeddedMedia(data, path.basename(filePath));
  const json = `${JSON.stringify(data, null, 2)}\n`;
  assertMetadataTextSize(json, filePath, MAX_JSON_METADATA_BYTES);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const backupPath = `${filePath}.bak`;
  await fs.writeFile(tempPath, json, "utf8");
  try {
    await fs.copyFile(filePath, backupPath).catch(() => undefined);
    await replaceFile(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function assertNoEmbeddedMedia(value: unknown, location = "metadata") {
  assertNoEmbeddedMediaInner(value, location, new WeakSet<object>());
}

export function assertManifestRecordSafe(record: unknown, location = "manifest record") {
  assertNoEmbeddedMedia(record, location);
  const line = JSON.stringify(record);
  assertMetadataTextSize(line, location, MAX_MANIFEST_LINE_BYTES);
  return line;
}

function assertNoEmbeddedMediaInner(value: unknown, location: string, seen: WeakSet<object>) {
  if (typeof value === "string") {
    if (isEmbeddedMediaString(value)) {
      throw new Error(`Refusing to write embedded media into metadata at ${location}`);
    }
    if (value.length > MAX_METADATA_STRING_LENGTH) {
      throw new Error(`Refusing to write oversized metadata string at ${location}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    value.forEach((item, index) => assertNoEmbeddedMediaInner(item, `${location}[${index}]`, seen));
    return;
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      assertNoEmbeddedMediaInner(child, `${location}.${key}`, seen);
    }
  }
}

function isEmbeddedMediaString(value: string) {
  return value.startsWith("data:image/")
    || value.startsWith("data:video/")
    || value.startsWith("data:audio/")
    || value.startsWith("data:application/octet-stream");
}

function assertMetadataTextSize(text: string, filePath: string, maxBytes: number) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Refusing to write oversized metadata file: ${filePath} (${bytes} bytes)`);
  }
}

async function replaceFile(tempPath: string, filePath: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }

  await fs.copyFile(tempPath, filePath);
  await fs.rm(tempPath, { force: true });
}

export function safeSegment(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_").slice(0, 140);
}

export function fallbackProjectFolder(project: Project) {
  return path.join(localProjectsRoot, `${safeSegment(project.shortName)}_${safeSegment(project.name)}`);
}

export async function ensureJobFolders(project: Project, jobId: string) {
  const projectFolder = project.folderPath || fallbackProjectFolder(project);
  const jobRoot = path.join(projectFolder, "jobs", safeSegment(jobId));
  const input = path.join(jobRoot, "input");
  const output = path.join(jobRoot, "output");
  const thumbnails = path.join(jobRoot, "thumbnails");

  for (const folder of [input, output, thumbnails]) {
    await fs.mkdir(folder, { recursive: true });
  }

  return { jobRoot, input, output, thumbnails, workflowSnapshotPath: path.join(jobRoot, "workflow.json") };
}

export async function saveJobMetadata(job: Job, project?: Project) {
  if (!project) {
    return;
  }
  const folders = await ensureJobFolders(project, job.id);
  const metadata = {
    jobId: job.id,
    comfyPromptId: job.comfyPromptId ?? "",
    runpodJobId: job.runpodJobId ?? "",
    runpodStatus: job.runpodStatus ?? "",
    projectId: project.id,
    folderId: job.folderId ?? null,
    title: job.title ?? "",
    projectName: project.name,
    projectShortName: project.shortName,
    userId: job.userId,
    modelId: job.modelId,
    modelName: job.modelName,
    category: job.category,
    prompt: job.prompt ?? "",
    resolution: job.resolution,
    outputResolution: job.outputResolution,
    durationSeconds: job.durationSeconds ?? 0,
    workflowOptions: job.workflowOptions,
    generatedPrompt: job.generatedPrompt ?? "",
    textArtifacts: job.textArtifacts ?? [],
    inputFiles: job.inputImages,
    outputFiles: job.resultUrls,
    thumbnailFiles: job.thumbnailUrls,
    workflowPath: job.workflowPath,
    workflowSnapshotPath: job.workflowSnapshotPath ?? "",
    creditsEstimated: job.creditsEstimated ?? 0,
    creditsUsed: job.creditsUsed ?? 0,
    creditsActual: job.creditsActual ?? null,
    creditsActualSource: job.creditsActualSource ?? "",
    creditBalanceBefore: job.creditBalanceBefore ?? null,
    creditBalanceAfter: job.creditBalanceAfter ?? null,
    creditUsage: job.creditUsage,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? "",
    completedAt: job.completedAt ?? "",
    errorMessage: job.errorMessage ?? "",
  };
  await writeJsonFile(path.join(folders.jobRoot, "metadata.json"), metadata);
}
