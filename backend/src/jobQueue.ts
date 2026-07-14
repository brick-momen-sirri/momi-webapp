import path from "node:path";
import fs from "node:fs/promises";
import { getHistory, queuePrompt, toViewUrl, uploadImage, uploadInputFile } from "./comfyClient.js";
import { acquireIdleServer, releaseServer } from "./comfyPool.js";
import {
  archivedItemsStorePath,
  brickProjectsRoot,
  comfyRoot,
  generationBackend,
  jobsStorePath,
  localProjectsRoot,
  runpodInlineMediaMaxBytes,
  runpodInputBaseUrl,
} from "./config.js";
import { estimateFallbackCreditUsage, estimateWorkflowCredits } from "./creditEstimator.js";
import { syncServerlessCreditUsage } from "./creditTrackerSyncService.js";
import { getActualCreditsByPromptIds } from "./creditUsageService.js";
import { detectMediaResolution } from "./mediaResolutionService.js";
import { incrementProjectJobCount, getProject } from "./projectService.js";
import {
  appendAudit,
  appendManifestEvent,
  folderDisplayName,
  loadProjectFolders,
  validateDisplayName,
} from "./projectMetadataService.js";
import {
  RunpodComfyError,
  runComfyWorkflowOnRunpod,
  type RunpodComfyImageInput,
  type RunpodMediaResult,
} from "./runpodComfyService.js";
import { createRunpodInputUrl, type RunpodInputKind } from "./runpodInputUrlService.js";
import { persistServerlessArtifacts } from "./serverlessArtifactService.js";
import { ensureJobFolders, readJsonFile, safeSegment, saveJobMetadata, writeJsonFile } from "./storageService.js";
import { invalidateMediaCache, scanExistingMediaJobs } from "./mediaService.js";
import {
  detectWorkflowLoadImageNames,
  detectWorkflowLoadVideoNames,
  getWorkflowModel,
  loadWorkflowForRunpod,
  loadWorkflowPrompt,
  saveWorkflowSnapshot,
} from "./workflowService.js";
import type { CreateJobRequest, Job, Project, WorkflowModel } from "./types.js";

let jobs: Job[] = [];
let archivedMediaJobs: Job[] = [];
let dispatching = false;
let activeRunpodJobs = 0;
const runpodJobConcurrency = Math.max(1, Number(process.env.RUNPOD_MAX_CONCURRENT_JOBS ?? 1) || 1);

export async function loadJobs() {
  let changed = false;
  jobs = (await readJsonFile<Job[]>(jobsStorePath, [])).map((job) => {
    const normalized: Job = {
      ...job,
      userId: typeof job.userId === "string" && job.userId.trim() ? job.userId : "usr_momen",
      source: job.source ?? "backend_job",
      folderId: typeof job.folderId === "string" && job.folderId.trim() ? job.folderId : null,
      title: typeof job.title === "string" && job.title.trim() ? job.title.trim() : undefined,
    };

    if (generationBackend === "runpod" && (normalized.status === "sending" || normalized.status === "running")) {
      normalized.status = "failed";
      normalized.completedAt = normalized.completedAt ?? new Date().toISOString();
      normalized.errorMessage = normalized.errorMessage ?? "Backend restarted before this RunPod job returned. Retry the job if needed.";
      normalized.creditsUsed = normalized.creditsUsed ?? 0;
      changed = true;
    }

    return normalized;
  });
  if (changed) {
    await persistJobs();
  }
  archivedMediaJobs = await readJsonFile<Job[]>(archivedItemsStorePath, []);
  return jobs;
}

export function getJobs() {
  return jobs;
}

export async function getJobsWithExistingMedia(options: { archived?: boolean } = {}) {
  await reconcileActualCreditsForStoredJobs();
  const archived = Boolean(options.archived);
  const mediaJobs = archived ? [] : await scanExistingMediaJobs();
  const backendResultPaths = new Set(
    jobs.flatMap((job) => [...job.resultUrls, ...job.thumbnailUrls])
      .map(mediaFilePathFromUrl)
      .filter((item): item is string => Boolean(item)),
  );
  const archivedMediaIds = new Set(archivedMediaJobs.map((job) => job.id));
  const map = new Map<string, Job>();
  for (const job of mediaJobs) {
    if (archivedMediaIds.has(job.id)) {
      continue;
    }
    const mediaPaths = [...job.resultUrls, ...job.thumbnailUrls]
      .map(mediaFilePathFromUrl)
      .filter((item): item is string => Boolean(item));
    if (mediaPaths.some((filePath) => backendResultPaths.has(filePath))) {
      continue;
    }
    map.set(job.id, job);
  }
  for (const job of jobs) {
    if (Boolean(job.archivedAt) !== archived) continue;
    map.set(job.id, { ...job, source: job.source ?? "backend_job" });
  }
  if (archived) {
    for (const job of archivedMediaJobs) {
      map.set(job.id, { ...job, source: "existing_project_media" });
    }
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getJob(id: string) {
  return jobs.find((job) => job.id === id);
}

export async function getJobFromAnySource(id: string, options: { archived?: boolean } = {}) {
  const backendJob = getJob(id);
  if (backendJob && Boolean(backendJob.archivedAt) === Boolean(options.archived)) {
    return backendJob;
  }
  return (await getJobsWithExistingMedia({ archived: options.archived })).find((job) => job.id === id);
}

export function getQueueSnapshot() {
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const sendingJobs = jobs.filter((job) => job.status === "sending");
  const runningJobs = jobs.filter((job) => job.status === "running");
  const activeJobs = [...sendingJobs, ...runningJobs];

  return {
    queued: queuedJobs.length,
    sending: sendingJobs.length,
    running: runningJobs.length,
    active: activeJobs.length,
    runpodActive: activeRunpodJobs,
    capacity: runpodJobConcurrency,
    activeJobs: activeJobs.map(jobStatusSummary),
    waitingJobs: queuedJobs.slice(0, 5).map(jobStatusSummary),
  };
}

function jobStatusSummary(job: Job) {
  return {
    id: job.id,
    modelName: job.modelName,
    status: job.status,
    projectId: job.projectId,
    startedAt: job.startedAt,
    createdAt: job.createdAt,
    comfyServerUrl: job.comfyServerUrl,
    runpodJobId: job.runpodJobId,
    runpodStatus: job.runpodStatus,
  };
}

export async function createJob(request: CreateJobRequest) {
  const model = getWorkflowModel(request.modelId);
  if (!model) {
    throw new Error(`Unknown workflow model: ${request.modelId}`);
  }
  const project = getProject(request.projectId);
  if (!project) {
    throw new Error(`Unknown project: ${request.projectId}`);
  }
  const jobId = `job_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const preparedRequest = await externalizeJobInputMedia(project, jobId, request);
  const durationSeconds = normalizeDurationSeconds(request.durationSeconds, model);
  const targetFolderId = typeof request.targetFolderId === "string" && request.targetFolderId.trim() ? request.targetFolderId.trim() : null;
  const projectFolders = await loadProjectFolders(project);
  if (targetFolderId && !projectFolders.some((folder) => folder.folderId === targetFolderId && !folder.archived)) {
    throw new Error("Target folder not found.");
  }

  const job: Job = {
    id: jobId,
    projectId: project.id,
    folderId: targetFolderId,
    folderName: folderDisplayName(targetFolderId, projectFolders),
    userId: preparedRequest.userId,
    modelId: model.id,
    modelName: model.name,
    title: model.name,
    category: model.category,
    inputType: inferInputType(preparedRequest),
    prompt: preparedRequest.prompt,
    resolution: preparedRequest.resolution,
    durationSeconds,
    workflowOptions: preparedRequest.workflowOptions,
    status: "queued",
    inputImages: preparedRequest.inputImages ?? [preparedRequest.startFrame, preparedRequest.endFrame].filter(Boolean) as string[],
    inputVideo: preparedRequest.inputVideo,
    resultUrls: [],
    thumbnailUrls: [],
    outputType: model.outputType,
    projectFolderPath: project.folderPath,
    workflowPath: model.workflowPath,
    creditsEstimated: estimateWorkflowCredits(model, durationSeconds, preparedRequest.resolution, preparedRequest.workflowOptions),
    source: "backend_job",
    createdAt: new Date().toISOString(),
  };

  jobs = [job, ...jobs];
  await persistJobs();
  void dispatchQueue();
  return job;
}

async function externalizeJobInputMedia(project: Project, jobId: string, request: CreateJobRequest) {
  const prepared: CreateJobRequest = { ...request };

  if (request.inputImages) {
    prepared.inputImages = [];
    for (let index = 0; index < request.inputImages.length; index += 1) {
      prepared.inputImages.push(await persistInputDataUrl(project, jobId, request.inputImages[index], `input_${String(index + 1).padStart(2, "0")}`));
    }
  }

  if (request.startFrame) {
    prepared.startFrame = await persistInputDataUrl(project, jobId, request.startFrame, "start_frame");
  }

  if (request.endFrame) {
    prepared.endFrame = await persistInputDataUrl(project, jobId, request.endFrame, "end_frame");
  }

  if (request.inputVideo) {
    prepared.inputVideo = await persistInputDataUrl(project, jobId, request.inputVideo, "input_video");
  }

  return prepared;
}

async function persistInputDataUrl(project: Project, jobId: string, value: string, fileBase: string) {
  const parsed = parseMediaDataUrl(value);
  if (!parsed) return value;

  const folders = await ensureJobFolders(project, jobId);
  const filePath = path.join(folders.input, `${safeSegment(fileBase)}.${parsed.extension}`);
  await fs.writeFile(filePath, parsed.buffer);
  return mediaUrl(filePath);
}

function parseMediaDataUrl(value: string) {
  const match = value.match(/^data:(image|video)\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/);
  if (!match) return undefined;

  const kind = match[1].toLowerCase();
  const subtype = match[2].toLowerCase();
  return {
    kind,
    subtype,
    mimeType: `${kind}/${subtype}`,
    extension: mediaExtension(kind, subtype),
    buffer: Buffer.from(match[3], "base64"),
  };
}

function normalizeDurationSeconds(value: number | undefined, model: { supportedDurations?: number[]; defaultDurationSeconds?: number }) {
  const options = model.supportedDurations ?? [];
  if (!options.length) return undefined;
  if (typeof value === "number" && options.includes(value)) return value;

  const fallback = model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds)
    ? model.defaultDurationSeconds
    : options[0];

  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return options.reduce((closest, option) => (
    Math.abs(option - value) < Math.abs(closest - value) ? option : closest
  ), fallback);
}

export async function cancelJob(jobId: string) {
  const job = getJob(jobId);
  if (!job || job.status === "completed" || job.status === "failed") return job;
  job.status = "canceled";
  job.completedAt = new Date().toISOString();
  await persistJobs();
  return job;
}

export async function archiveJob(jobId: string, userId: string) {
  const archivedAt = new Date().toISOString();
  const backendJob = getJob(jobId);
  if (backendJob) {
    backendJob.archivedAt = archivedAt;
    backendJob.archivedBy = userId;
    await persistJobs();
    return backendJob;
  }

  const existingJob = (await getJobsWithExistingMedia()).find((job) => job.id === jobId);
  if (!existingJob) return undefined;

  const archivedJob = { ...existingJob, source: "existing_project_media" as const, archivedAt, archivedBy: userId };
  archivedMediaJobs = [archivedJob, ...archivedMediaJobs.filter((job) => job.id !== jobId)];
  await persistArchivedMediaJobs();
  return archivedJob;
}

export async function restoreArchivedJob(jobId: string) {
  const backendJob = getJob(jobId);
  if (backendJob?.archivedAt) {
    delete backendJob.archivedAt;
    delete backendJob.archivedBy;
    await persistJobs();
    return backendJob;
  }

  const archivedJob = archivedMediaJobs.find((job) => job.id === jobId);
  if (!archivedJob) return undefined;
  archivedMediaJobs = archivedMediaJobs.filter((job) => job.id !== jobId);
  await persistArchivedMediaJobs();
  const restored = { ...archivedJob };
  delete restored.archivedAt;
  delete restored.archivedBy;
  return restored;
}

export async function permanentlyDeleteArchivedJob(jobId: string) {
  const backendJob = getJob(jobId);
  if (backendJob?.archivedAt) {
    jobs = jobs.filter((job) => job.id !== jobId);
    await persistJobs();
    return backendJob;
  }

  const archivedJob = archivedMediaJobs.find((job) => job.id === jobId);
  if (!archivedJob) return undefined;
  archivedMediaJobs = archivedMediaJobs.filter((job) => job.id !== jobId);
  await persistArchivedMediaJobs();
  return archivedJob;
}

export async function renameJob(projectId: string, jobId: string, title: string, userId: string) {
  const project = getProject(projectId);
  if (!project) return undefined;

  const cleanTitle = validateDisplayName(title, "Job title");
  const backendJob = getJob(jobId);
  if (backendJob && backendJob.projectId !== projectId) {
    return undefined;
  }

  const existingJob = backendJob ?? (await getJobsWithExistingMedia()).find((job) => job.id === jobId && job.projectId === projectId);
  if (!existingJob) {
    return undefined;
  }

  const oldTitle = existingJob.title || existingJob.fileName || existingJob.prompt || "Untitled Job";
  if (backendJob) {
    backendJob.title = cleanTitle;
    await persistJobs();
    await saveJobMetadata(backendJob, project);
  }

  await appendManifestEvent(project, {
    event: "job.renamed",
    projectId,
    jobId,
    title: cleanTitle,
    oldTitle,
    newTitle: cleanTitle,
    renamedBy: userId,
  });
  await appendAudit(project.folderPath, {
    event: "job.renamed",
    projectId,
    jobId,
    oldTitle,
    newTitle: cleanTitle,
    changedBy: userId,
  });
  invalidateMediaCache();

  return { ...existingJob, title: cleanTitle };
}

export async function updateJobSaveNumber(projectId: string, jobId: string, value: unknown, userId: string) {
  const project = getProject(projectId);
  if (!project) return undefined;

  const saveNumber = normalizeEditableSaveNumber(value);
  const backendJob = getJob(jobId);
  if (backendJob && backendJob.projectId !== projectId) {
    return undefined;
  }

  const existingJob = backendJob ?? (await getJobsWithExistingMedia()).find((job) => job.id === jobId && job.projectId === projectId);
  if (!existingJob) {
    return undefined;
  }

  const oldSave = existingJob.workflowOptions?.save ?? {};
  const workflowOptions = {
    ...(existingJob.workflowOptions ?? {}),
    save: {
      ...(existingJob.workflowOptions?.save ?? {}),
      cameraNumber: saveNumber,
      shotNumber: saveNumber,
    },
  };

  if (backendJob) {
    backendJob.workflowOptions = workflowOptions;
    await persistJobs();
    await saveJobMetadata(backendJob, project);
  }

  await appendManifestEvent(project, {
    event: "job.saveNumber.updated",
    projectId,
    jobId,
    cameraNumber: saveNumber,
    shotNumber: saveNumber,
    oldCameraNumber: oldSave.cameraNumber,
    oldShotNumber: oldSave.shotNumber,
    changedBy: userId,
  });
  await appendAudit(project.folderPath, {
    event: "job.saveNumber.updated",
    projectId,
    jobId,
    oldCameraNumber: oldSave.cameraNumber,
    oldShotNumber: oldSave.shotNumber,
    cameraNumber: saveNumber,
    shotNumber: saveNumber,
    changedBy: userId,
  });
  invalidateMediaCache();

  return { ...existingJob, workflowOptions };
}

async function dispatchQueue() {
  if (dispatching) return;
  dispatching = true;

  try {
    if (generationBackend === "runpod") {
      dispatchRunpodJobs();
      return;
    }

    while (true) {
      const next = jobs.find((job) => job.status === "queued");
      if (!next) return;

      const serverUrl = await acquireIdleServer();
      if (!serverUrl) return;

      void runLocalComfyJob(next, serverUrl).finally(() => {
        releaseServer(serverUrl);
        void dispatchQueue();
      });
    }
  } finally {
    dispatching = false;
  }
}

function dispatchRunpodJobs() {
  while (activeRunpodJobs < runpodJobConcurrency) {
    const next = jobs.find((job) => job.status === "queued");
    if (!next) return;

    activeRunpodJobs += 1;
    void runRunpodJob(next).finally(() => {
      activeRunpodJobs = Math.max(0, activeRunpodJobs - 1);
      void dispatchQueue();
    });
  }
}

async function runRunpodJob(job: Job) {
  const project = getProject(job.projectId);
  const model = getWorkflowModel(job.modelId);
  if (!project || !model) {
    job.status = "failed";
    job.errorMessage = "Missing project or workflow model.";
    await persistJobs();
    return;
  }

  try {
    job.status = "sending";
    job.startedAt = new Date().toISOString();
    await persistJobs();

    const folders = await ensureJobFolders(project, job.id);
    const projectFolderName = path.basename(project.folderPath);
    const runpodImages = await materializeRunpodInputImages(job, model);
    const runpodVideo = await materializeRunpodInputVideo(job, model);
    const workflow = await loadWorkflowForRunpod(
      model,
      {
        projectId: job.projectId,
        modelId: job.modelId,
        prompt: job.prompt,
        resolution: job.resolution,
        durationSeconds: job.durationSeconds,
        inputImages: runpodImages.imageNames,
        startFrame: model.requiresStartEndFrames ? runpodImages.imageNames[0] : undefined,
        endFrame: model.requiresStartEndFrames ? runpodImages.imageNames[1] : undefined,
        inputVideo: runpodVideo?.videoName,
        workflowOptions: job.workflowOptions,
        userId: job.userId,
      },
      projectFolderName,
      runpodImages.imageNames,
    );
    await saveWorkflowSnapshot(folders.workflowSnapshotPath, workflow);
    job.workflowSnapshotPath = folders.workflowSnapshotPath;
    job.status = "running";
    await persistJobs();

    const result = await runComfyWorkflowOnRunpod({
      workflow,
      images: runpodImages.images,
      videos: runpodVideo?.videos ?? [],
    });
    job.runpodJobId = result.jobId;
    job.runpodStatus = result.status;

    const media = result.media;
    const selectedMedia = preferredResultMedia(media);
    if (!selectedMedia.length) {
      throw new Error("RunPod completed without returning any output media.");
    }

    const creditUsage = result.creditUsage ?? estimateFallbackCreditUsage(model, workflow, job.durationSeconds, job.resolution);
    job.creditUsage = creditUsage;
    if (creditUsage) {
      job.creditsUsed = creditUsage.total_estimated_credits;
    }
    job.outputType = selectedMedia.some((item) => item.isVideo) ? "video" : job.outputType;

    const artifacts = await persistServerlessArtifacts({ project, job, model, media, selectedMedia });
    job.resultUrls = artifacts.resultUrls;
    job.thumbnailUrls = artifacts.thumbnailUrls;
    job.fileName = artifacts.selectedArtifacts[0]?.fileName ?? selectedMedia[0]?.filename;
    job.outputResolution = artifacts.outputResolution;

    if (creditUsage) {
      const syncResult = await syncServerlessCreditUsage({
        project,
        job,
        model,
        creditUsage,
        outputFiles: artifacts.artifacts.map((artifact) => artifact.filePath).filter((item): item is string => Boolean(item)),
      });
      if (!syncResult.ok) {
        console.warn(`Credit Tracker sync failed for ${job.id}: ${syncResult.error ?? "unknown error"}`);
      }
    }

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await incrementProjectJobCount(job.projectId);
  } catch (error) {
    if (job.status !== "canceled") {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      if (error instanceof RunpodComfyError) {
        job.runpodStatus = error.status;
        job.errorMessage = error.message;
        if (error.creditUsage) {
          job.creditUsage = error.creditUsage;
          job.creditsUsed = error.creditUsage.total_estimated_credits;
        } else {
          job.creditsUsed = 0;
        }
      } else {
        job.errorMessage = error instanceof Error ? error.message : "Unknown RunPod job error";
        job.creditsUsed = 0;
      }
    }
  } finally {
    await persistJobs();
    await saveJobMetadata(job, project);
  }
}

async function runLocalComfyJob(job: Job, serverUrl: string) {
  const project = getProject(job.projectId);
  const model = getWorkflowModel(job.modelId);
  if (!project || !model) {
    job.status = "failed";
    job.errorMessage = "Missing project or workflow model.";
    await persistJobs();
    return;
  }

  try {
    job.status = "sending";
    job.comfyServerUrl = serverUrl;
    job.startedAt = new Date().toISOString();
    await persistJobs();

    const folders = await ensureJobFolders(project, job.id);
    await ensureWorkerProjectFolder(serverUrl, project.folderName ?? path.basename(project.folderPath));
    const projectFolderName = path.basename(project.folderPath);
    const workflow = await loadWorkflowPrompt(
      model,
      {
        projectId: job.projectId,
        modelId: job.modelId,
        prompt: job.prompt,
        resolution: job.resolution,
        durationSeconds: job.durationSeconds,
        inputImages: await materializeComfyInputImages(job, serverUrl),
        inputVideo: await materializeComfyInputVideo(job, serverUrl),
        workflowOptions: job.workflowOptions,
        userId: job.userId,
      },
      projectFolderName,
      serverUrl,
    );
    await saveWorkflowSnapshot(folders.workflowSnapshotPath, workflow);
    job.workflowSnapshotPath = folders.workflowSnapshotPath;

    const queued = await queuePrompt(serverUrl, workflow, `momi-${job.id}`);
    job.comfyPromptId = queued.prompt_id;
    job.status = "running";
    await persistJobs();

    const history = await waitForHistory(serverUrl, queued.prompt_id, job);
    const resultUrls = extractResultUrls(serverUrl, history, queued.prompt_id);
    const persistedResultUrls = await persistResultMedia(resultUrls, folders.output, job.id);
    job.resultUrls = persistedResultUrls;
    job.thumbnailUrls = persistedResultUrls.slice(0, 1);
    job.outputResolution = await detectFirstPersistedResultResolution(persistedResultUrls, job.outputType);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await incrementProjectJobCount(job.projectId);
    await reconcileActualCreditsForStoredJobs();
  } catch (error) {
    if (job.status !== "canceled") {
      job.status = "failed";
      job.errorMessage = error instanceof Error ? error.message : "Unknown ComfyUI job error";
      job.completedAt = new Date().toISOString();
    }
  } finally {
    await persistJobs();
    await saveJobMetadata(job, project);
  }
}

async function waitForHistory(serverUrl: string, promptId: string, job: Job) {
  const maxChecks = Number(process.env.COMFY_HISTORY_CHECKS ?? 180);
  const intervalMs = Number(process.env.COMFY_HISTORY_INTERVAL_MS ?? 2500);

  for (let index = 0; index < maxChecks; index += 1) {
    if (job.status === "canceled") throw new Error("Job canceled.");
    const history = await getHistory(serverUrl, promptId).catch(() => ({}));
    if (history && Object.keys(history).length) {
      const promptHistory = getPromptHistory(history, promptId);
      const status = promptHistory?.status;
      if (status?.status_str === "error") {
        throw new Error(comfyHistoryErrorMessage(promptHistory) ?? "ComfyUI execution failed.");
      }
      if (status?.completed) {
        return history;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for ComfyUI history.");
}

function extractResultUrls(serverUrl: string, history: Record<string, unknown>, promptId: string) {
  const promptHistory = getPromptHistory(history, promptId);
  const outputs = promptHistory.outputs ?? {};
  const urls: string[] = [];

  for (const output of Object.values(outputs) as Array<Record<string, unknown>>) {
    for (const key of ["images", "videos", "gifs"]) {
      const items = output[key];
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item && typeof item === "object") urls.push(toViewUrl(serverUrl, item as Record<string, unknown>));
        }
      }
    }
  }

  const uniqueUrls = Array.from(new Set(urls));
  if (!uniqueUrls.length) {
    throw new Error("ComfyUI completed without returning any output media.");
  }
  return uniqueUrls;
}

async function persistResultMedia(resultUrls: string[], outputFolder: string, jobId: string) {
  const persistedUrls: string[] = [];

  for (let index = 0; index < resultUrls.length; index += 1) {
    const resultUrl = resultUrls[index];
    try {
      const url = new URL(resultUrl);
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) {
        persistedUrls.push(resultUrl);
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const extension = resultExtension(url, contentType);
      const filePath = path.join(outputFolder, `${jobId}_${String(index + 1).padStart(2, "0")}${extension}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, buffer);
      persistedUrls.push(`/api/media?path=${encodeURIComponent(filePath)}`);
    } catch {
      persistedUrls.push(resultUrl);
    }
  }

  return persistedUrls;
}

async function detectFirstPersistedResultResolution(resultUrls: string[], outputType: Job["outputType"]) {
  for (const resultUrl of resultUrls) {
    const filePath = mediaDiskPathFromUrl(resultUrl);
    if (!filePath) continue;
    const resolution = await detectMediaResolution(filePath, outputType).catch(() => undefined);
    if (resolution) return resolution;
  }
  return undefined;
}

function resultExtension(url: URL, contentType: string) {
  const filename = url.searchParams.get("filename") || path.basename(url.pathname);
  const extension = path.extname(filename);
  if (extension) return extension;
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/gif")) return ".gif";
  if (contentType.includes("video/mp4")) return ".mp4";
  if (contentType.includes("video/quicktime")) return ".mov";
  if (contentType.includes("video/webm")) return ".webm";
  return ".bin";
}

function getPromptHistory(history: Record<string, unknown>, promptId: string) {
  return (history[promptId] ?? history) as Record<string, any>;
}

function comfyHistoryErrorMessage(promptHistory: Record<string, any>) {
  const messages = Array.isArray(promptHistory.status?.messages) ? promptHistory.status.messages : [];
  const executionError = messages
    .map((message: unknown) => Array.isArray(message) ? message : undefined)
    .find((message: unknown[] | undefined) => message?.[0] === "execution_error")?.[1] as Record<string, unknown> | undefined;

  const nodeType = typeof executionError?.node_type === "string" ? executionError.node_type : "ComfyUI node";
  const exception = typeof executionError?.exception_message === "string" ? executionError.exception_message.trim() : "";
  return exception ? `${nodeType}: ${exception}` : undefined;
}

function preferredResultMedia(media: RunpodMediaResult[]) {
  const videos = media.filter((item) => item.isVideo);
  return videos.length ? videos : media;
}

async function materializeRunpodInputImages(job: Job, model: WorkflowModel) {
  const expectedNames = await detectWorkflowLoadImageNames(model);
  const images: RunpodComfyImageInput[] = [];

  for (let index = 0; index < job.inputImages.length; index += 1) {
    const value = job.inputImages[index];
    const name = expectedNames?.[index] ?? fallbackRunpodImageName(value, job.id, index);
    images.push(await runpodImageInput(value, name));
  }

  return {
    images,
    imageNames: images.map((image) => image.name),
  };
}

async function materializeRunpodInputVideo(job: Job, model: WorkflowModel) {
  if (!job.inputVideo) return undefined;
  const expectedNames = await detectWorkflowLoadVideoNames(model);
  const name = expectedNames?.[0] ?? fallbackRunpodVideoName(job.inputVideo, job.id);
  return {
    videos: [await runpodVideoInput(job.inputVideo, name)],
    videoName: name,
  };
}

async function runpodImageInput(value: string, name: string): Promise<RunpodComfyImageInput> {
  if (value.startsWith("data:image/")) {
    return runpodInlineDataUrlInput(value, name, "image");
  }
  const filePath = localMediaFilePathFromUrl(value);
  if (filePath) {
    return runpodFileInput(filePath, name, "image");
  }
  if (/^https?:\/\//i.test(value)) {
    return { name, url: value };
  }
  throw new Error("RunPod image inputs must be saved media, browser data URLs, or public http(s) URLs.");
}

async function runpodVideoInput(value: string, name: string): Promise<RunpodComfyImageInput> {
  if (value.startsWith("data:video/")) {
    return runpodInlineDataUrlInput(value, name, "video");
  }
  const filePath = localMediaFilePathFromUrl(value);
  if (filePath) {
    return runpodFileInput(filePath, name, "video");
  }
  if (/^https?:\/\//i.test(value)) {
    return { name, url: value };
  }
  throw new Error("RunPod video inputs must be saved media, browser data URLs, or public http(s) URLs.");
}

async function runpodFileInput(filePath: string, name: string, kind: RunpodInputKind): Promise<RunpodComfyImageInput> {
  const signedUrl = createRunpodInputUrl(filePath, kind);
  if (signedUrl) {
    return { name, url: signedUrl };
  }

  return {
    name,
    image: await readMediaFileAsDataUrl(filePath, kind),
  };
}

function runpodInlineDataUrlInput(value: string, name: string, kind: RunpodInputKind): RunpodComfyImageInput {
  const byteLength = dataUrlBase64ByteLength(value);
  if (byteLength != null) {
    assertRunpodInlineMediaSize(byteLength, kind, name);
  }
  return { name, image: value };
}

function fallbackRunpodImageName(value: string, jobId: string, index: number) {
  const extension = extensionFromImageInput(value) ?? ".png";
  return `${jobId}_${index + 1}${extension}`;
}

function fallbackRunpodVideoName(value: string, jobId: string) {
  const extension = extensionFromVideoInput(value) ?? ".mp4";
  return `${jobId}_video${extension}`;
}

function extensionFromImageInput(value: string) {
  const dataUrlMatch = value.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
  if (dataUrlMatch) {
    return `.${dataUrlMatch[1].toLowerCase().replace("jpeg", "jpg")}`;
  }

  try {
    const url = new URL(value);
    const filename = url.searchParams.get("filename") ?? path.basename(url.pathname);
    const extension = path.extname(filename);
    return extension || undefined;
  } catch {
    const extension = path.extname(value);
    return extension || undefined;
  }
}

function extensionFromVideoInput(value: string) {
  const dataUrlMatch = value.match(/^data:video\/([a-zA-Z0-9+.-]+);base64,/);
  if (dataUrlMatch) {
    return `.${videoExtension(dataUrlMatch[1])}`;
  }

  try {
    const url = new URL(value);
    const filename = url.searchParams.get("filename") ?? path.basename(url.pathname);
    const extension = path.extname(filename);
    return extension || undefined;
  } catch {
    const extension = path.extname(value);
    return extension || undefined;
  }
}

function inferInputType(request: CreateJobRequest): Job["inputType"] {
  if (request.inputVideo) return "video";
  if (request.startFrame || request.endFrame) return "start_end_frames";
  if ((request.inputImages?.length ?? 0) > 1) return "multi_image";
  if (request.inputImages?.length) return "single_image";
  return "text_only";
}

function normalizeEditableSaveNumber(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  if (!digits) {
    throw new Error("Shot/camera number is required.");
  }
  return digits.padStart(4, "0");
}

async function materializeComfyInputImages(job: Job, serverUrl: string) {
  const converted: string[] = [];
  for (let index = 0; index < job.inputImages.length; index += 1) {
    const value = job.inputImages[index];
    if (value.startsWith("data:image/")) {
      converted.push(await uploadDataImageToComfy(serverUrl, value, job.id, index));
    } else {
      const filePath = localMediaFilePathFromUrl(value);
      if (filePath) {
        converted.push(await uploadLocalMediaToComfy(serverUrl, filePath, `${job.id}_${index + 1}`, "image"));
      } else {
        converted.push(value);
      }
    }
  }
  return converted;
}

async function uploadLocalMediaToComfy(serverUrl: string, filePath: string, fileBase: string, kind: "image" | "video") {
  const extension = path.extname(filePath) || (kind === "image" ? ".png" : ".mp4");
  const filename = `${safeSegment(fileBase)}${extension}`;
  const file = new Blob([await fs.readFile(filePath)], { type: mimeTypeFromMediaPath(filePath, kind) });
  const uploaded = kind === "image"
    ? await uploadImage(serverUrl, file, filename)
    : await uploadInputFile(serverUrl, file, filename);
  const uploadedName = uploaded.name || filename;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploadedName}` : uploadedName;
}

async function uploadDataImageToComfy(serverUrl: string, dataUrl: string, jobId: string, index: number) {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported image data URL.");
  }
  const ext = match[1].toLowerCase().replace("jpeg", "jpg");
  const filename = `${jobId}_${index + 1}.${ext}`;
  const file = new Blob([Buffer.from(match[2], "base64")], { type: `image/${match[1].toLowerCase()}` });
  const uploaded = await uploadImage(serverUrl, file, filename);
  const uploadedName = uploaded.name || filename;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploadedName}` : uploadedName;
}

async function materializeComfyInputVideo(job: Job, serverUrl: string) {
  if (!job.inputVideo) {
    return job.inputVideo;
  }

  if (!job.inputVideo.startsWith("data:video/")) {
    const filePath = localMediaFilePathFromUrl(job.inputVideo);
    if (filePath) {
      return uploadLocalMediaToComfy(serverUrl, filePath, `${job.id}_video`, "video");
    }
    return job.inputVideo;
  }

  const match = job.inputVideo.match(/^data:video\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported video data URL.");
  }

  const ext = videoExtension(match[1]);
  const filename = `${job.id}_video.${ext}`;
  const file = new Blob([Buffer.from(match[2], "base64")], { type: `video/${match[1].toLowerCase()}` });
  const uploaded = await uploadInputFile(serverUrl, file, filename);
  const uploadedName = uploaded.name || filename;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploadedName}` : uploadedName;
}

function videoExtension(subtype: string) {
  const normalized = subtype.toLowerCase();
  if (normalized === "quicktime") return "mov";
  if (normalized === "x-msvideo") return "avi";
  if (normalized === "x-matroska") return "mkv";
  return normalized.replace(/[^a-z0-9]+/g, "") || "mp4";
}

function mediaExtension(kind: string, subtype: string) {
  const normalized = subtype.toLowerCase();
  if (kind === "image" && normalized === "jpeg") return "jpg";
  if (kind === "video") return videoExtension(normalized);
  return normalized.replace(/[^a-z0-9]+/g, "") || "bin";
}

function localMediaFilePathFromUrl(value: string) {
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.pathname !== "/api/media") return undefined;
    const filePath = url.searchParams.get("path");
    return filePath && isAllowedLocalMediaPath(filePath) ? path.resolve(filePath) : undefined;
  } catch {
    return undefined;
  }
}

function isAllowedLocalMediaPath(filePath: string) {
  const resolvedPath = path.resolve(filePath).toLowerCase();
  return [brickProjectsRoot, localProjectsRoot, path.join(comfyRoot, "output"), path.join(comfyRoot, "input")]
    .map((root) => path.resolve(root).toLowerCase())
    .some((root) => resolvedPath.startsWith(root));
}

async function readMediaFileAsDataUrl(filePath: string, kind: "image" | "video") {
  const buffer = await fs.readFile(filePath);
  assertRunpodInlineMediaSize(buffer.length, kind, filePath);
  return `data:${mimeTypeFromMediaPath(filePath, kind)};base64,${buffer.toString("base64")}`;
}

function dataUrlBase64ByteLength(value: string) {
  const match = value.match(/^data:[^;]+;base64,([\s\S]+)$/);
  if (!match) return undefined;
  const payload = match[1].replace(/\s/g, "");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function assertRunpodInlineMediaSize(byteLength: number, kind: RunpodInputKind, source: string) {
  if (byteLength <= runpodInlineMediaMaxBytes) return;

  const sourceName = path.basename(source) || `${kind} input`;
  const baseUrlHint = runpodInputBaseUrl
    ? "The input could not be sent as a signed file URL, so the backend refused to inline it."
    : "Set RUNPOD_INPUT_BASE_URL to a public URL for this backend, such as a production URL or tunnel, so RunPod can download the original file bytes.";

  throw new Error(
    `RunPod ${kind} input "${sourceName}" is ${formatBytes(byteLength)}, which is too large to place inside the JSON request without hitting RunPod's 20MiB body limit. ${baseUrlHint} This avoids any image quality loss.`,
  );
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`;
}

function mimeTypeFromMediaPath(filePath: string, kind: "image" | "video") {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4" || extension === ".m4v") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mkv") return "video/x-matroska";
  if (extension === ".avi") return "video/x-msvideo";
  return kind === "image" ? "image/png" : "video/mp4";
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

async function ensureWorkerProjectFolder(serverUrl: string, projectFolderName: string) {
  const port = new URL(serverUrl).port;
  if (!/^82\d\d$/.test(port)) return;

  const projectRoot = path.join("C:\\Comfy_pool\\instances", `comfy-${port}`, "output", "projects", projectFolderName);
  for (const folder of ["images", "sequences", "videos", "metadata", "logs", "jobs"]) {
    await fs.mkdir(path.join(projectRoot, folder), { recursive: true });
  }
}

async function persistJobs() {
  await writeJsonFile(jobsStorePath, jobs);
}

async function persistArchivedMediaJobs() {
  await writeJsonFile(archivedItemsStorePath, archivedMediaJobs);
}

async function reconcileActualCreditsForStoredJobs() {
  const promptIds = jobs
    .map((job) => job.comfyPromptId)
    .filter((value): value is string => Boolean(value));
  if (!promptIds.length) return;

  const actualCredits = await getActualCreditsByPromptIds(promptIds);
  let changed = false;
  for (const job of jobs) {
    if (!job.comfyPromptId) continue;
    const credits = actualCredits.get(job.comfyPromptId);
    if (credits == null || job.creditsUsed === credits) continue;
    job.creditsUsed = credits;
    changed = true;
  }

  if (changed) {
    await persistJobs();
  }
}

function mediaFilePathFromUrl(value: string) {
  const filePath = mediaDiskPathFromUrl(value);
  return filePath ? normalizePath(filePath) : undefined;
}

function mediaDiskPathFromUrl(value: string) {
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.pathname === "/api/media") {
      const filePath = url.searchParams.get("path");
      return filePath ? path.resolve(filePath) : undefined;
    }
    if (url.pathname.endsWith("/view")) {
      const filename = url.searchParams.get("filename");
      const subfolder = url.searchParams.get("subfolder") ?? "";
      const type = url.searchParams.get("type") || "output";
      if (!filename) {
        return undefined;
      }
      return path.resolve(comfyRoot, type, subfolder, filename);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizePath(value: string) {
  return path.resolve(value).toLowerCase();
}
