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

// Like readJsonFile, but for critical stores (the job list): if the main file
// exists yet fails to parse, fall back to the ".bak" that writeJsonFile keeps
// before each replace, instead of silently returning an empty list and losing
// the entire history. Returns the fallback only when nothing parseable exists.
export async function readJsonFileWithBackup<T>(filePath: string, fallback: T): Promise<T> {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf8");
    } catch {
      continue; // Missing file: try the next candidate.
    }
    try {
      const parsed = JSON.parse(raw) as T;
      if (candidate !== filePath) {
        console.warn(`Recovered ${path.basename(filePath)} from backup ${path.basename(candidate)}.`);
      }
      return parsed;
    } catch (error) {
      console.error(
        `Could not parse ${path.basename(candidate)}: ${error instanceof Error ? error.message : String(error)}.`
        + " Trying the next backup...",
      );
    }
  }
  return fallback;
}

// Keep a daily timestamped copy of a store (one per day, pruned after
// retentionDays) so a lost/corrupt main file and .bak are still recoverable to
// a recent point in time. Best-effort: failures are logged, never thrown.
export async function snapshotJsonStore(filePath: string, retentionDays = 7) {
  try {
    await fs.access(filePath);
  } catch {
    return; // Nothing to snapshot yet.
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const day = new Date().toISOString().slice(0, 10);
  const snapshotPath = path.join(dir, `${base}.${day}.snapshot`);
  try {
    await fs.copyFile(filePath, snapshotPath);
    const entries = await fs.readdir(dir);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".snapshot"))
        .map(async (name) => {
          const full = path.join(dir, name);
          const stat = await fs.stat(full).catch(() => undefined);
          if (stat && stat.mtimeMs < cutoff) {
            await fs.rm(full, { force: true }).catch(() => undefined);
          }
        }),
    );
  } catch (error) {
    console.warn(`Could not snapshot ${base}: ${error instanceof Error ? error.message : String(error)}`);
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
