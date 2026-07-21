import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { projectFolderName } from "./projectFolderName.js";
import { getHistory, queuePrompt, toViewUrl, uploadImage, uploadInputFile } from "./comfyClient.js";
import { acquireIdleServer, releaseServer } from "./comfyPool.js";
import {
  archivedItemsSqlitePath,
  archivedItemsStorePath,
  brickProjectsRoot,
  comfyRoot,
  creditBalanceDeltaAccountingEnabled,
  dispatcherLeaseHeartbeatMs,
  dispatcherLeaseTtlMs,
  dispatcherPollIntervalMs,
  dispatcherWalCheckpointMs,
  generationBackend,
  jobRowLevelWrites,
  jobStoreDriver,
  jobsSqlitePath,
  jobsStorePath,
  localProjectsRoot,
  runpodOutputMaxBytes,
  runpodTimeoutMs,
  runpodInlineMediaMaxBytes,
  runpodInputBaseUrl,
  uploadedMediaRoot,
} from "./config.js";
import { estimateFallbackCreditUsage, estimateWorkflowCredits } from "./creditEstimator.js";
import { BackendHttpError } from "./httpError.js";
import { mergeJobChangesById, mergeJobSnapshotById } from "./jobReadCache.js";
import { getCredits } from "./creditService.js";
import { syncServerlessCreditUsage } from "./creditTrackerSyncService.js";
import {
  balanceDeltaCredits,
  COMPANY_BALANCE_DELTA_SOURCE,
  creditsSpentForAccounting,
  isCountedCreditUsage,
} from "./creditUsageAccounting.js";
import { getActualCreditsByPromptIds } from "./creditUsageService.js";
import { detectMediaResolution } from "./mediaResolutionService.js";
import { getProject } from "./projectService.js";
import {
  appendAudit,
  appendManifestEvent,
  folderDisplayName,
  loadProjectFolders,
  validateDisplayName,
  withProjectMutationLock,
} from "./projectMetadataService.js";
import {
  RunpodComfyCanceledError,
  RunpodComfyError,
  cancelComfyWorkflowOnRunpod,
  resumeComfyWorkflowOnRunpod,
  runComfyWorkflowOnRunpod,
  type RunpodComfyImageInput,
  type RunpodMediaResult,
} from "./runpodComfyService.js";
import { isDispatcher } from "./processRole.js";
import {
  parseImageDataUrl,
  prepareRunpodInlineImageInput,
  runpodInlineImageByteBudget,
} from "./runpodImageInlineService.js";
import {
  beginRunpodBillableOperation,
  hasExclusiveRunpodActivityWindow,
  runpodActivityBaseline,
  type RunpodActivityBaseline,
} from "./runpodActivityTracker.js";
import { createRunpodInputUrl, type RunpodInputKind } from "./runpodInputUrlService.js";
import { prepareRunpodVideoFile } from "./runpodVideoPreprocessService.js";
import {
  openSqliteJobStore,
  type SqliteJobStore,
} from "./sqliteJobStore.js";
import { persistServerlessArtifacts } from "./serverlessArtifactService.js";
import { ensureJobFolders, readJsonFileWithBackup, safeSegment, saveJobMetadata, snapshotJsonStore, writeJsonFile } from "./storageService.js";
import { invalidateMediaCache, scanExistingMediaJobs } from "./mediaService.js";
import { logMemory } from "./memoryLogger.js";
import { moveResultFiles } from "./resultMoveService.js";
import { responseBodyToNodeStream, writeStreamAtomically } from "./streamingMediaService.js";
import {
  detectWorkflowLoadImageNames,
  detectWorkflowLoadVideoNames,
  getWorkflowModel,
  loadWorkflowForRunpod,
  loadWorkflowPrompt,
  saveWorkflowSnapshot,
} from "./workflowService.js";
import type { CreateJobRequest, CreditBalanceSnapshot, Job, Project, WorkflowModel } from "./types.js";

let jobs: Job[] = [];
let archivedMediaJobs: Job[] = [];
let dispatching = false;
let activeRunpodJobs = 0;
let resultMoveQueue = Promise.resolve();
let sqliteStore: SqliteJobStore | undefined;
let archivedStore: SqliteJobStore | undefined;
let jobsCacheCursor: StoreCacheCursor | undefined;
let archivedCacheCursor: StoreCacheCursor | undefined;
const inFlightJobIds = new Set<string>();
const runpodJobConcurrency = Math.max(1, Number(process.env.RUNPOD_MAX_CONCURRENT_JOBS ?? 1) || 1);
const dispatcherOwnerHost = os.hostname();
const dispatcherOwnerId = `${dispatcherOwnerHost}:${process.pid}:${crypto.randomUUID()}`;
let dispatcherLeaseHeld = false;
let dispatcherLeaseWasTakeover = false;
let dispatchPollTimer: NodeJS.Timeout | undefined;
let dispatcherHeartbeatTimer: NodeJS.Timeout | undefined;
let walCheckpointTimer: NodeJS.Timeout | undefined;

type StoreCacheCursor = {
  dataVersion: number;
  revision: number;
};

export async function loadJobs() {
  if (sqliteStore || archivedStore) closeJobStore();
  acceptingNewWork = true;
  const rawJobs = await loadRawJobs();
  initializeDispatcherCoordination();
  const normalizedJobs: Job[] = [];
  jobs = rawJobs.map((job) => {
    const normalized: Job = {
      ...job,
      userId: typeof job.userId === "string" && job.userId.trim() ? job.userId : "usr_momen",
      source: job.source ?? "backend_job",
      folderId: typeof job.folderId === "string" && job.folderId.trim() ? job.folderId : null,
      title: typeof job.title === "string" && job.title.trim() ? job.title.trim() : undefined,
    };

    if (
      ownsDispatcherWork()
      && generationBackend === "runpod"
      && (normalized.status === "sending" || normalized.status === "running")
    ) {
      if (normalized.runpodJobId) {
        // Acknowledged async submissions are resumed by ID after the new
        // dispatcher owns the lease. Never submit their workflow again.
      } else if (normalized.runpodSubmissionState === "preparing") {
        normalized.status = normalized.cancelRequested ? "canceled" : "queued";
        delete normalized.startedAt;
        delete normalized.completedAt;
        delete normalized.runpodSubmissionState;
        normalizedJobs.push(normalized);
      } else if (shouldNormalizeInterruptedJob(normalized)) {
        normalized.status = normalized.cancelRequested ? "canceled" : "failed";
        normalized.completedAt = normalized.completedAt ?? new Date().toISOString();
        if (!normalized.cancelRequested) {
          normalized.errorMessage = normalized.errorMessage ?? "Backend restarted before this RunPod job returned. Retry the job if needed.";
        }
        normalized.creditsUsed = normalized.creditsUsed ?? 0;
        normalizedJobs.push(normalized);
      }
    }

    return normalized;
  });
  if (normalizedJobs.length) {
    if (jobRowLevelWrites && sqliteStore) {
      for (const job of normalizedJobs) await persistUpsert(job);
    } else {
      // Persist the normalization now rather than via the debounced timer,
      // which is unref'd and may not fire before boot completes.
      persistJobs().catch(() => undefined);
      await flushPersistedJobs();
    }
  }
  archivedMediaJobs = await loadRawArchivedJobs();
  resumeAcknowledgedRunpodJobs();
  startDispatcherCoordination();
  if (isDispatcher() && !usesDispatcherCoordination()) void dispatchQueue();
  return jobs;
}

// Reads the archived-items list from the configured store, seeding the SQLite
// store once from archived-items.json if it is still empty.
async function loadRawArchivedJobs(): Promise<Job[]> {
  if (jobStoreDriver === "sqlite") {
    archivedStore = openSqliteJobStore(archivedItemsSqlitePath, "archived_jobs");
    let existing = loadConsistentSnapshot(archivedStore);
    archivedCacheCursor = existing.cursor;
    if (existing.snapshot.jobs.length > 0) return existing.snapshot.jobs;

    const legacy = await readJsonFileWithBackup<Job[]>(archivedItemsStorePath, []);
    if (legacy.length) {
      archivedStore.replaceAll(legacy);
      console.log(`Migrated ${legacy.length} archived items from archived-items.json into SQLite.`);
      existing = loadConsistentSnapshot(archivedStore);
      archivedCacheCursor = existing.cursor;
      return existing.snapshot.jobs;
    }
    return [];
  }
  archivedCacheCursor = undefined;
  return readJsonFileWithBackup<Job[]>(archivedItemsStorePath, []);
}

// Reads the raw job list from the configured store. For the SQLite driver, the
// store is opened here and seeded once from jobs.json if it is still empty.
async function loadRawJobs(): Promise<Job[]> {
  if (jobStoreDriver === "sqlite") {
    sqliteStore = openSqliteJobStore(jobsSqlitePath);
    let existing = loadConsistentSnapshot(sqliteStore);
    jobsCacheCursor = existing.cursor;
    if (existing.snapshot.jobs.length > 0) return existing.snapshot.jobs;

    const legacy = await readJsonFileWithBackup<Job[]>(jobsStorePath, []);
    if (legacy.length) {
      sqliteStore.replaceAll(legacy);
      console.log(`Migrated ${legacy.length} jobs from jobs.json into SQLite at ${jobsSqlitePath}.`);
      existing = loadConsistentSnapshot(sqliteStore);
      jobsCacheCursor = existing.cursor;
      return existing.snapshot.jobs;
    }
    return [];
  }

  jobsCacheCursor = undefined;
  // Take a point-in-time snapshot before mutating, and recover from .bak if the
  // main store is corrupt, so a bad file can't silently wipe job history.
  await snapshotJsonStore(jobsStorePath);
  return readJsonFileWithBackup<Job[]>(jobsStorePath, []);
}

function loadConsistentSnapshot(store: SqliteJobStore) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = store.dataVersion();
    const snapshot = store.loadSnapshot();
    const after = store.dataVersion();
    if (before === after) {
      return {
        snapshot,
        cursor: { dataVersion: after, revision: snapshot.revision } satisfies StoreCacheCursor,
      };
    }
  }
  throw new Error("Could not read a stable SQLite job snapshot after 20 attempts.");
}

function loadConsistentChanges(store: SqliteJobStore, afterRevision: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = store.dataVersion();
    const changes = store.loadChanges(afterRevision);
    const after = store.dataVersion();
    if (before === after) return { changes, dataVersion: after };
  }
  throw new Error("Could not read stable incremental SQLite job changes after 20 attempts.");
}

function refreshMainJobsCache() {
  if (!sqliteStore || !jobsCacheCursor) return;
  const observedVersion = sqliteStore.dataVersion();
  if (observedVersion === jobsCacheCursor.dataVersion) return;

  const { changes, dataVersion } = loadConsistentChanges(sqliteStore, jobsCacheCursor.revision);
  if (changes.fullSnapshotRequired) {
    const stable = loadConsistentSnapshot(sqliteStore);
    jobs = mergeJobSnapshotById(jobs, stable.snapshot, inFlightJobIds);
    jobsCacheCursor = stable.cursor;
    return;
  }

  jobs = mergeJobChangesById(jobs, changes, inFlightJobIds);
  jobsCacheCursor = { dataVersion, revision: changes.revision };
}

function refreshArchivedJobsCache() {
  if (!archivedStore || !archivedCacheCursor) return;
  const observedVersion = archivedStore.dataVersion();
  if (observedVersion === archivedCacheCursor.dataVersion) return;

  const { changes, dataVersion } = loadConsistentChanges(archivedStore, archivedCacheCursor.revision);
  if (changes.fullSnapshotRequired) {
    const stable = loadConsistentSnapshot(archivedStore);
    archivedMediaJobs = mergeJobSnapshotById(archivedMediaJobs, stable.snapshot, new Set());
    archivedCacheCursor = stable.cursor;
    return;
  }

  archivedMediaJobs = mergeJobChangesById(archivedMediaJobs, changes, new Set());
  archivedCacheCursor = { dataVersion, revision: changes.revision };
}

export function getJobs() {
  refreshMainJobsCache();
  return jobs;
}

export async function getJobsWithExistingMedia(options: { archived?: boolean } = {}) {
  refreshMainJobsCache();
  refreshArchivedJobsCache();
  await reconcileActualCreditsForStoredJobs();
  const archived = Boolean(options.archived);
  logMemory("before-media-scan");
  const mediaJobs = archived ? [] : await scanExistingMediaJobs();
  logMemory("after-media-scan");
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
  return getJobs().find((job) => job.id === id);
}

export async function getJobFromAnySource(id: string, options: { archived?: boolean } = {}) {
  const backendJob = getJob(id);
  if (backendJob && Boolean(backendJob.archivedAt) === Boolean(options.archived)) {
    return backendJob;
  }
  return (await getJobsWithExistingMedia({ archived: options.archived })).find((job) => job.id === id);
}

let acceptingNewWork = true;

// Stop pulling queued jobs into the dispatchers so in-flight work can drain
// during a graceful shutdown. Already-running jobs are unaffected.
export function pauseJobDispatch() {
  acceptingNewWork = false;
  if (dispatchPollTimer) {
    clearInterval(dispatchPollTimer);
    dispatchPollTimer = undefined;
  }
}

export function activeRunpodJobCount() {
  return activeRunpodJobs;
}

export function getQueueSnapshot() {
  refreshMainJobsCache();
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const sendingJobs = jobs.filter((job) => job.status === "sending");
  const runningJobs = jobs.filter((job) => job.status === "running");
  const activeJobs = [...sendingJobs, ...runningJobs];
  const sqlActiveJobs = jobRowLevelWrites && sqliteStore
    ? sqliteStore.countActiveJobs()
    : activeRunpodJobs;

  return {
    queued: queuedJobs.length,
    sending: sendingJobs.length,
    running: runningJobs.length,
    active: activeJobs.length,
    runpodActive: sqlActiveJobs,
    capacity: runpodJobConcurrency,
    dispatcher: dispatcherLeaseSnapshot(),
    activeJobs: activeJobs.map(jobStatusSummary),
    waitingJobs: queuedJobs.slice(0, 5).map(jobStatusSummary),
  };
}

function usesDispatcherCoordination() {
  return isDispatcher() && jobRowLevelWrites && Boolean(sqliteStore);
}

function ownsDispatcherWork() {
  if (!isDispatcher()) return false;
  if (!usesDispatcherCoordination()) return true;
  return hasCurrentDispatcherLease();
}

function initializeDispatcherCoordination() {
  dispatcherLeaseHeld = false;
  dispatcherLeaseWasTakeover = false;
  if (usesDispatcherCoordination()) tryAcquireDispatcherLease();
}

function startDispatcherCoordination() {
  if (!usesDispatcherCoordination()) return;

  dispatchPollTimer = setInterval(() => {
    if (!acceptingNewWork || !ensureDispatcherLease()) return;
    void dispatchQueue();
  }, dispatcherPollIntervalMs);
  dispatchPollTimer.unref?.();

  dispatcherHeartbeatTimer = setInterval(() => {
    const acquired = maintainDispatcherLease();
    if (acquired && acceptingNewWork) void dispatchQueue();
  }, dispatcherLeaseHeartbeatMs);
  dispatcherHeartbeatTimer.unref?.();

  if (dispatcherWalCheckpointMs > 0) {
    walCheckpointTimer = setInterval(() => {
      if (!hasCurrentDispatcherLease()) return;
      try {
        sqliteStore?.checkpointWalPassive();
      } catch (error) {
        console.warn(`Passive job-store WAL checkpoint failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }, dispatcherWalCheckpointMs);
    walCheckpointTimer.unref?.();
  }

  if (dispatcherLeaseHeld && acceptingNewWork) void dispatchQueue();
}

function resumeAcknowledgedRunpodJobs() {
  if (generationBackend !== "runpod" || !ownsDispatcherWork()) return;
  for (const job of jobs) {
    if (
      !job.runpodJobId
      || (job.status !== "sending" && job.status !== "running")
      || inFlightJobIds.has(job.id)
    ) continue;

    activeRunpodJobs += 1;
    inFlightJobIds.add(job.id);
    void runRunpodJob(job).finally(() => {
      inFlightJobIds.delete(job.id);
      activeRunpodJobs = Math.max(0, activeRunpodJobs - 1);
      void dispatchQueue();
    });
  }
}

function stopDispatcherCoordination(releaseLease: boolean) {
  if (dispatchPollTimer) clearInterval(dispatchPollTimer);
  if (dispatcherHeartbeatTimer) clearInterval(dispatcherHeartbeatTimer);
  if (walCheckpointTimer) clearInterval(walCheckpointTimer);
  dispatchPollTimer = undefined;
  dispatcherHeartbeatTimer = undefined;
  walCheckpointTimer = undefined;

  if (releaseLease && dispatcherLeaseHeld) {
    try {
      sqliteStore?.releaseDispatcherLease(dispatcherOwnerId);
    } catch (error) {
      console.warn(`Could not release dispatcher lease: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  dispatcherLeaseHeld = false;
  dispatcherLeaseWasTakeover = false;
}

function maintainDispatcherLease() {
  if (!usesDispatcherCoordination() || !sqliteStore) return false;
  const wasHeld = hasCurrentDispatcherLease();
  const now = Date.now();
  if (wasHeld) {
    const renewed = sqliteStore.renewDispatcherLease(dispatcherLease(now));
    dispatcherLeaseHeld = renewed;
    return false;
  }
  const acquired = tryAcquireDispatcherLease();
  if (acquired) resumeAcknowledgedRunpodJobs();
  return acquired;
}

function ensureDispatcherLease() {
  if (!isDispatcher()) return false;
  if (!usesDispatcherCoordination()) return true;
  if (hasCurrentDispatcherLease()) return true;
  const acquired = tryAcquireDispatcherLease();
  if (acquired) resumeAcknowledgedRunpodJobs();
  return acquired;
}

function hasCurrentDispatcherLease() {
  if (!usesDispatcherCoordination() || !sqliteStore) return isDispatcher();
  const now = Date.now();
  const stored = sqliteStore.readDispatcherLease();
  const held = stored?.ownerId === dispatcherOwnerId && stored.expiresAt > now;
  dispatcherLeaseHeld = held;
  return held;
}

function tryAcquireDispatcherLease() {
  if (!usesDispatcherCoordination() || !sqliteStore) return false;
  const now = Date.now();
  const existing = sqliteStore.readDispatcherLease();
  const replaceOwnerId = existing
    && existing.ownerHost.toLowerCase() === dispatcherOwnerHost.toLowerCase()
    && !processAppearsAlive(existing.ownerPid)
    ? existing.ownerId
    : undefined;
  const acquired = sqliteStore.tryAcquireDispatcherLease({
    ...dispatcherLease(now),
    now,
    replaceOwnerId,
  });
  const changedOwner = acquired && !dispatcherLeaseHeld;
  if (changedOwner && existing && existing.ownerId !== dispatcherOwnerId) {
    dispatcherLeaseWasTakeover = true;
  }
  dispatcherLeaseHeld = acquired;
  if (changedOwner) console.log(`Dispatcher lease acquired by ${dispatcherOwnerId}.`);
  return acquired;
}

function shouldNormalizeInterruptedJob(job: Job) {
  if (!usesDispatcherCoordination() || !dispatcherLeaseWasTakeover) return true;
  const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Number.NaN;
  return !Number.isFinite(startedAt) || startedAt <= Date.now() - runpodTimeoutMs;
}

function dispatcherLease(now: number) {
  return {
    ownerId: dispatcherOwnerId,
    ownerPid: process.pid,
    ownerHost: dispatcherOwnerHost,
    heartbeatAt: now,
    expiresAt: now + dispatcherLeaseTtlMs,
  };
}

function processAppearsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function dispatcherLeaseSnapshot() {
  if (!jobRowLevelWrites || !sqliteStore) {
    return { enabled: false, active: isDispatcher(), heldByThisProcess: isDispatcher() };
  }
  const lease = sqliteStore.readDispatcherLease();
  const active = Boolean(lease && lease.expiresAt > Date.now());
  return {
    enabled: true,
    active,
    heldByThisProcess: active && lease?.ownerId === dispatcherOwnerId,
    ownerId: lease?.ownerId,
    heartbeatAt: lease?.heartbeatAt,
    expiresAt: lease?.expiresAt,
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
  await persistUpsert(job);
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
  let job: Job | undefined;

  if (jobRowLevelWrites && sqliteStore) {
    const updated = sqliteStore.applyToJob(jobId, (current) => {
      if (isTerminalJobStatus(current.status)) return current;
      current.cancelRequested = true;
      return current;
    });
    job = updated ? mergeCancellationRequestIntoMemory(updated) : undefined;
  } else {
    job = getJob(jobId);
    if (!job || isTerminalJobStatus(job.status)) return job;
    job.cancelRequested = true;
    await persistUpsert(job);
  }

  if (job && isDispatcher()) {
    await dispatchQueue();
  }
  return job;
}

function isTerminalJobStatus(status: Job["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function mergeCancellationRequestIntoMemory(updated: Job) {
  const cached = getJob(updated.id);
  if (!cached) {
    jobs = [updated, ...jobs];
    return updated;
  }
  cached.cancelRequested = updated.cancelRequested;
  return cached;
}

// Dispatcher-side read of the request flag. Under the row-level SQLite path
// this deliberately re-reads just the job row on every RunPod/Comfy poll tick,
// so a request written by another process is observed without replacing the
// in-flight object that the dispatcher is mutating across awaits.
function cancellationRequested(job: Job) {
  if (jobRowLevelWrites && sqliteStore) {
    const stored = sqliteStore.loadById(job.id);
    if (stored?.cancelRequested) job.cancelRequested = true;
    return stored?.cancelRequested === true || stored?.status === "canceled";
  }
  return job.cancelRequested === true || job.status === "canceled";
}

// Only dispatcher-capable roles call this lifecycle transition. The SQLite
// branch applies it to the latest row atomically so a concurrent API metadata
// edit is preserved; the in-flight object is then updated in place.
async function settleRequestedCancellation(job: Job) {
  if (!isDispatcher() || !cancellationRequested(job)) return false;

  let canceledRunpodStatus: string | undefined;
  if (generationBackend === "runpod" && job.runpodJobId && ownsDispatcherWork()) {
    try {
      const canceled = await cancelComfyWorkflowOnRunpod(job.runpodJobId);
      canceledRunpodStatus = canceled.status;
    } catch (error) {
      console.warn(`Could not cancel RunPod job ${job.runpodJobId}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  if (jobRowLevelWrites && sqliteStore) {
    const updated = sqliteStore.applyToJob(job.id, (current) => {
      if (!current.cancelRequested || isTerminalJobStatus(current.status)) return current;
      current.status = "canceled";
      if (canceledRunpodStatus) current.runpodStatus = canceledRunpodStatus;
      current.completedAt = current.completedAt ?? new Date().toISOString();
      return current;
    });
    if (!updated) return false;
    Object.assign(job, updated);
    return updated.status === "canceled";
  }

  if (isTerminalJobStatus(job.status)) return job.status === "canceled";
  job.status = "canceled";
  if (canceledRunpodStatus) job.runpodStatus = canceledRunpodStatus;
  job.completedAt = job.completedAt ?? new Date().toISOString();
  await persistUpsert(job);
  return true;
}

export async function archiveJob(jobId: string, userId: string) {
  const archivedAt = new Date().toISOString();
  const backendJob = getJob(jobId);
  if (backendJob) {
    if (jobRowLevelWrites && sqliteStore) {
      const updated = sqliteStore.applyToJob(jobId, (current) => {
        assertJobCanBeArchived(current);
        current.archivedAt = archivedAt;
        current.archivedBy = userId;
        return current;
      });
      if (!updated) return undefined;
      Object.assign(backendJob, updated);
      return backendJob;
    }
    assertJobCanBeArchived(backendJob);
    backendJob.archivedAt = archivedAt;
    backendJob.archivedBy = userId;
    await persistUpsert(backendJob);
    return backendJob;
  }

  const existingJob = (await getJobsWithExistingMedia()).find((job) => job.id === jobId);
  if (!existingJob) return undefined;

  const archivedJob = { ...existingJob, source: "existing_project_media" as const, archivedAt, archivedBy: userId };
  archivedMediaJobs = [archivedJob, ...archivedMediaJobs.filter((job) => job.id !== jobId)];
  await persistArchivedUpsert(archivedJob);
  return archivedJob;
}

function assertJobCanBeArchived(job: Job) {
  if (isTerminalJobStatus(job.status)) return;
  throw new BackendHttpError("Cancel the job and wait for it to stop before archiving it.", {
    statusCode: 409,
    code: "job_not_terminal",
  });
}

export async function restoreArchivedJob(jobId: string) {
  const backendJob = getJob(jobId);
  if (backendJob?.archivedAt) {
    delete backendJob.archivedAt;
    delete backendJob.archivedBy;
    await persistUpsert(backendJob);
    return backendJob;
  }

  const archivedJob = archivedMediaJobs.find((job) => job.id === jobId);
  if (!archivedJob) return undefined;
  archivedMediaJobs = archivedMediaJobs.filter((job) => job.id !== jobId);
  await persistArchivedRemove(jobId);
  const restored = { ...archivedJob };
  delete restored.archivedAt;
  delete restored.archivedBy;
  return restored;
}

export async function permanentlyDeleteArchivedJob(jobId: string) {
  const backendJob = getJob(jobId);
  if (backendJob?.archivedAt) {
    jobs = jobs.filter((job) => job.id !== jobId);
    await persistRemove(jobId);
    return backendJob;
  }

  const archivedJob = archivedMediaJobs.find((job) => job.id === jobId);
  if (!archivedJob) return undefined;
  archivedMediaJobs = archivedMediaJobs.filter((job) => job.id !== jobId);
  await persistArchivedRemove(jobId);
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
    await persistUpsert(backendJob);
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
    await persistUpsert(backendJob);
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

export async function moveJobResult(
  projectId: string,
  jobId: string,
  destinationFolderId: string | null,
  userId: string,
) {
  return serializeResultMove(async () => {
    const project = getProject(projectId);
    if (!project) return undefined;

    return withProjectMutationLock(project, async () => {
      const job = getJob(jobId);
      if (!job || job.projectId !== projectId) return undefined;
      if (job.source === "existing_project_media") {
        throw new Error("Only generated results with saved job metadata can be moved.");
      }

      const folders = await loadProjectFolders(project);
      const originalJob: Job = {
        ...job,
        resultUrls: [...job.resultUrls],
        thumbnailUrls: [...job.thumbnailUrls],
      };
      const move = await moveResultFiles({ project, job, destinationFolderId, folders });
      Object.assign(job, move.job);

      try {
        await saveJobMetadata(job, project);
        await persistUpsert(job);
      } catch (error) {
        let rollbackError: unknown;
        try {
          await move.rollback();
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
        }
        Object.assign(job, originalJob);
        await saveJobMetadata(job, project).catch(() => undefined);
        await persistUpsert(job).catch(() => undefined);
        if (rollbackError) {
          throw new Error(
            `Could not persist result move: ${error instanceof Error ? error.message : "metadata write failed"}. `
            + `Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : "filesystem operation failed"}`,
          );
        }
        throw error;
      }

      invalidateMediaCache();
      const moveRecord = {
        event: "job.moved",
        projectId,
        jobId,
        oldFolderId: originalJob.folderId ?? null,
        oldFolderName: originalJob.folderName ?? "Root",
        destinationFolderId,
        destinationFolderName: job.folderName ?? "Root",
        files: move.fileMoves.map((file) => ({
          from: file.from,
          to: file.to,
          fromRelativePath: file.fromRelativePath,
          toRelativePath: file.toRelativePath,
        })),
        changedBy: userId,
      };
      const auditWrites = await Promise.allSettled([
        appendManifestEvent(project, moveRecord),
        appendAudit(project.folderPath, moveRecord),
      ]);
      for (const auditWrite of auditWrites) {
        if (auditWrite.status === "rejected") {
          console.warn(`Could not record result move audit for ${jobId}: ${auditWrite.reason instanceof Error ? auditWrite.reason.message : "unknown error"}`);
        }
      }

      return job;
    });
  });
}

function serializeResultMove<T>(operation: () => Promise<T>) {
  const result = resultMoveQueue.then(operation, operation);
  resultMoveQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function dispatchQueue() {
  if (!isDispatcher() || dispatching || !acceptingNewWork || !ensureDispatcherLease()) return;
  refreshMainJobsCache();
  dispatching = true;

  try {
    await failExpiredOrphanedRunpodJobs();
    if (generationBackend === "runpod") {
      await dispatchRunpodJobs();
      return;
    }

    while (true) {
      const serverUrl = await acquireIdleServer();
      if (!serverUrl) return;
      const next = claimNextJobForDispatch(Number.MAX_SAFE_INTEGER)
        ?? (!jobRowLevelWrites || !sqliteStore ? jobs.find((job) => job.status === "queued") : undefined);
      if (!next) {
        releaseServer(serverUrl);
        return;
      }
      if (await settleRequestedCancellation(next)) {
        releaseServer(serverUrl);
        continue;
      }

      inFlightJobIds.add(next.id);
      void runLocalComfyJob(next, serverUrl).finally(() => {
        inFlightJobIds.delete(next.id);
        releaseServer(serverUrl);
        void dispatchQueue();
      });
    }
  } finally {
    dispatching = false;
  }
}

async function failExpiredOrphanedRunpodJobs() {
  if (generationBackend !== "runpod") return;
  const cutoff = Date.now() - runpodTimeoutMs;
  const expired = jobs.filter((job) => {
    if (inFlightJobIds.has(job.id) || (job.status !== "sending" && job.status !== "running")) return false;
    const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Number.NaN;
    return !Number.isFinite(startedAt) || startedAt <= cutoff;
  });

  for (const job of expired) {
    job.status = "failed";
    job.completedAt = job.completedAt ?? new Date().toISOString();
    job.errorMessage = job.errorMessage
      ?? "The prior dispatcher stopped and the RunPod timeout elapsed before the job returned. Retry the job if needed.";
    job.creditsUsed = job.creditsUsed ?? 0;
    await persistUpsert(job);
  }
}

async function dispatchRunpodJobs() {
  const usesSqlClaims = jobRowLevelWrites && Boolean(sqliteStore);
  while (acceptingNewWork && (usesSqlClaims || activeRunpodJobs < runpodJobConcurrency)) {
    if (!ensureDispatcherLease()) return;
    const next = usesSqlClaims
      ? claimNextJobForDispatch(runpodJobConcurrency)
      : jobs.find((job) => job.status === "queued");
    if (!next) return;
    if (await settleRequestedCancellation(next)) continue;

    activeRunpodJobs += 1;
    inFlightJobIds.add(next.id);
    void runRunpodJob(next).finally(() => {
      inFlightJobIds.delete(next.id);
      activeRunpodJobs = Math.max(0, activeRunpodJobs - 1);
      void dispatchQueue();
    });
  }
}

function claimNextJobForDispatch(concurrencyLimit: number) {
  if (!jobRowLevelWrites || !sqliteStore) return undefined;
  const claimed = sqliteStore.claimNextQueuedJob(
    new Date().toISOString(),
    concurrencyLimit,
    usesDispatcherCoordination() ? dispatcherOwnerId : undefined,
  );
  if (!claimed) return undefined;

  const cached = jobs.find((job) => job.id === claimed.id);
  if (cached) {
    Object.assign(cached, claimed);
    return cached;
  }
  jobs = [claimed, ...jobs];
  return claimed;
}

async function runRunpodJob(job: Job) {
  logMemory("job-start", job.id);
  if (await settleRequestedCancellation(job)) return;
  const project = getProject(job.projectId);
  let outputProject = project;
  const model = getWorkflowModel(job.modelId);
  if (!project || !model) {
    job.status = "failed";
    job.errorMessage = "Missing project or workflow model.";
    await persistUpsert(job);
    return;
  }

  const endBillableOperation = beginRunpodBillableOperation();
  const activityBaseline = runpodActivityBaseline();
  let dispatcherLeaseLost = false;
  try {
    if (await settleRequestedCancellation(job)) return;
    if (job.status !== "sending") {
      job.status = "sending";
      job.startedAt = new Date().toISOString();
      await persistUpsert(job);
    }

    if (!job.runpodJobId) job.runpodSubmissionState = "preparing";
    job.creditBalanceBefore = job.creditBalanceBefore ?? await captureCreditBalanceSnapshot();
    if (job.creditBalanceBefore) {
      await persistUpsert(job);
    }

    const folders = await ensureJobFolders(project, job.id);
    const projectFolder = projectFolderName(project.folderPath);
    const runpodImages = await materializeRunpodInputImages(job, model);
    const runpodVideo = await materializeRunpodInputVideo(job, model, folders.input);
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
      projectFolder,
      runpodImages.imageNames,
    );
    await saveWorkflowSnapshot(folders.workflowSnapshotPath, workflow);
    job.workflowSnapshotPath = folders.workflowSnapshotPath;
    if (await settleRequestedCancellation(job)) return;
    job.status = "running";
    if (!job.runpodJobId) job.runpodSubmissionState = "submitting";
    await persistUpsert(job);

    logMemory("before-runpod-request", job.id);
    const shouldStopRunpodWork = () => cancellationRequested(job) || !ownsDispatcherWork();
    const result = job.runpodJobId
      ? await resumeComfyWorkflowOnRunpod({
          jobId: job.runpodJobId,
          shouldCancel: shouldStopRunpodWork,
        })
      : await runComfyWorkflowOnRunpod({
          workflow,
          images: runpodImages.images,
          videos: runpodVideo?.videos ?? [],
          shouldCancel: shouldStopRunpodWork,
          onSubmitted: async ({ jobId, status }) => {
            if (!ownsDispatcherWork()) throw new DispatcherLeaseLostError();
            job.runpodJobId = jobId;
            job.runpodStatus = status;
            job.runpodSubmissionState = "submitted";
            await persistUpsert(job);
          },
        });
    logMemory("after-runpod-request", job.id);
    if (!ownsDispatcherWork()) throw new DispatcherLeaseLostError();
    if (await settleRequestedCancellation(job)) return;
    job.runpodJobId = result.jobId;
    job.runpodStatus = result.status;
    job.generatedPrompt = result.generatedText;
    job.textArtifacts = result.textArtifacts;
    await captureRunpodPostBalance(job, activityBaseline);

    const media = result.media;
    const selectedMedia = preferredResultMedia(media);
    if (!selectedMedia.length) {
      throw new Error("RunPod completed without returning any output media.");
    }

    const creditUsage = result.creditUsage ?? estimateFallbackCreditUsage(model, workflow, job.durationSeconds, job.resolution);
    job.creditUsage = creditUsage;
    applyAccountingCreditsToJob(job);
    job.outputType = selectedMedia.some((item) => item.isVideo) ? "video" : job.outputType;

    logMemory("before-runpod-download", job.id);
    // A project may be renamed while RunPod is processing. Resolve its shared
    // row again before writing outputs so a resumed dispatcher never recreates
    // the old project path.
    outputProject = getProject(job.projectId) ?? project;
    const artifacts = await persistServerlessArtifacts({ project: outputProject, job, model, media, selectedMedia });
    logMemory("after-runpod-download", job.id);
    job.resultUrls = artifacts.resultUrls;
    job.thumbnailUrls = artifacts.thumbnailUrls;
    job.fileName = artifacts.selectedArtifacts[0]?.fileName ?? selectedMedia[0]?.filename;
    job.outputResolution = artifacts.outputResolution;

    if (isCountedCreditUsage(creditUsage)) {
      const syncResult = await syncServerlessCreditUsage({
        project: outputProject,
        job,
        model,
        creditUsage,
        outputFiles: artifacts.artifacts.map((artifact) => artifact.filePath).filter((item): item is string => Boolean(item)),
      });
      if (!syncResult.ok) {
        console.warn(`Credit Tracker sync failed for ${job.id}: ${syncResult.error ?? "unknown error"}`);
      }
    }

    if (await settleRequestedCancellation(job)) return;
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    if (jobRemoteMediaEntries(job).length) {
      // Some outputs could not be saved locally; retry soon while the remote
      // signed URLs are still valid.
      scheduleRemoteResultRecovery();
    }
    logMemory("job-finished", job.id);
  } catch (error) {
    if (error instanceof DispatcherLeaseLostError || (error instanceof RunpodComfyCanceledError && !ownsDispatcherWork())) {
      dispatcherLeaseLost = true;
      console.warn(`Dispatcher lease lost while handling ${job.id}; the current lease owner will resume it.`);
      return;
    }
    const canceled = await settleRequestedCancellation(job);
    if (!canceled && job.status !== "canceled") {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      await captureRunpodPostBalance(job, activityBaseline);
      if (error instanceof RunpodComfyError) {
        job.runpodJobId = error.jobId ?? job.runpodJobId;
        job.runpodStatus = error.status;
        job.errorMessage = error.message;
        if (error.creditUsage) {
          job.creditUsage = error.creditUsage;
          applyAccountingCreditsToJob(job);
        } else {
          applyAccountingCreditsToJob(job);
        }
      } else {
        job.errorMessage = error instanceof Error ? error.message : "Unknown RunPod job error";
        applyAccountingCreditsToJob(job);
      }
    }
    logMemory(canceled || error instanceof RunpodComfyCanceledError ? "job-canceled" : "job-failed", job.id);
  } finally {
    endBillableOperation();
    if (!dispatcherLeaseLost) {
      await persistUpsert(job);
      await saveJobMetadata(job, getProject(job.projectId) ?? outputProject);
    }
  }
}

class DispatcherLeaseLostError extends Error {
  constructor() {
    super("Dispatcher lease lost.");
    this.name = "DispatcherLeaseLostError";
  }
}

async function captureCreditBalanceSnapshot(): Promise<CreditBalanceSnapshot | undefined> {
  try {
    const credits = await getCredits();
    if (typeof credits.creditsLeft !== "number" || !Number.isFinite(credits.creditsLeft)) return undefined;
    return {
      creditsLeft: credits.creditsLeft,
      source: credits.source,
      capturedAt: credits.updatedAt && Number.isFinite(new Date(credits.updatedAt).getTime())
        ? credits.updatedAt
        : new Date().toISOString(),
    };
  } catch (error) {
    console.warn(`Could not capture credit balance snapshot: ${error instanceof Error ? error.message : "unknown error"}`);
    return undefined;
  }
}

async function captureRunpodPostBalance(job: Job, activityBaseline: RunpodActivityBaseline) {
  if (job.creditBalanceAfter) return;
  const snapshot = await captureCreditBalanceSnapshot();
  if (!snapshot) return;

  job.creditBalanceAfter = snapshot;
  if (!creditBalanceDeltaAccountingEnabled) return;
  // Only attribute the balance delta when this job was provably the only
  // billable RunPod activity between its before/after snapshots. Concurrent
  // queue jobs and prompt helper calls spend from the same account balance,
  // so any overlap would misattribute their credits to this job.
  if (!hasExclusiveRunpodActivityWindow(activityBaseline)) return;

  const actualCredits = balanceDeltaCredits(job.creditBalanceBefore, job.creditBalanceAfter);
  if (actualCredits == null) return;

  job.creditsActual = actualCredits;
  job.creditsActualSource = COMPANY_BALANCE_DELTA_SOURCE;
  job.creditsUsed = actualCredits;
}

function applyAccountingCreditsToJob(job: Job) {
  const credits = creditsSpentForAccounting(job);
  if (credits > 0) {
    job.creditsUsed = credits;
    return;
  }

  delete job.creditsUsed;
}

async function runLocalComfyJob(job: Job, serverUrl: string) {
  if (await settleRequestedCancellation(job)) return;
  const project = getProject(job.projectId);
  const model = getWorkflowModel(job.modelId);
  if (!project || !model) {
    job.status = "failed";
    job.errorMessage = "Missing project or workflow model.";
    await persistUpsert(job);
    return;
  }

  try {
    if (await settleRequestedCancellation(job)) return;
    job.status = "sending";
    job.comfyServerUrl = serverUrl;
    job.startedAt = new Date().toISOString();
    await persistUpsert(job);

    const folders = await ensureJobFolders(project, job.id);
    await ensureWorkerProjectFolder(serverUrl, project.folderName ?? projectFolderName(project.folderPath));
    const projectFolder = projectFolderName(project.folderPath);
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
      projectFolder,
      serverUrl,
    );
    await saveWorkflowSnapshot(folders.workflowSnapshotPath, workflow);
    job.workflowSnapshotPath = folders.workflowSnapshotPath;
    if (await settleRequestedCancellation(job)) return;

    const queued = await queuePrompt(serverUrl, workflow, `momi-${job.id}`);
    job.comfyPromptId = queued.prompt_id;
    job.status = "running";
    await persistUpsert(job);

    const history = await waitForHistory(serverUrl, queued.prompt_id, job);
    const resultUrls = extractResultUrls(serverUrl, history, queued.prompt_id);
    const persistedResultUrls = await persistResultMedia(resultUrls, folders.output, job.id);
    job.resultUrls = persistedResultUrls;
    job.thumbnailUrls = persistedResultUrls.slice(0, 1);
    job.outputResolution = await detectFirstPersistedResultResolution(persistedResultUrls, job.outputType);
    if (await settleRequestedCancellation(job)) return;
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await reconcileActualCreditsForStoredJobs();
  } catch (error) {
    const canceled = await settleRequestedCancellation(job);
    if (!canceled && job.status !== "canceled") {
      job.status = "failed";
      job.errorMessage = error instanceof Error ? error.message : "Unknown ComfyUI job error";
      job.completedAt = new Date().toISOString();
    }
  } finally {
    await persistUpsert(job);
    await saveJobMetadata(job, project);
  }
}

async function waitForHistory(serverUrl: string, promptId: string, job: Job) {
  const maxChecks = Number(process.env.COMFY_HISTORY_CHECKS ?? 180);
  const intervalMs = Number(process.env.COMFY_HISTORY_INTERVAL_MS ?? 2500);

  for (let index = 0; index < maxChecks; index += 1) {
    if (await settleRequestedCancellation(job)) throw new Error("Job canceled.");
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
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > runpodOutputMaxBytes) {
        response.body?.cancel().catch(() => undefined);
        persistedUrls.push(resultUrl);
        continue;
      }
      await writeStreamAtomically(responseBodyToNodeStream(response), filePath, runpodOutputMaxBytes);
      persistedUrls.push(`/api/media?path=${encodeURIComponent(filePath)}`);
    } catch {
      persistedUrls.push(resultUrl);
    }
  }

  return persistedUrls;
}

export type RemoteMediaEntry = {
  kind: "result" | "thumbnail";
  index: number;
  url: string;
};

// A completed job's media should always be a local /api/media URL. Remote
// http(s) URLs mean the original persist failed (or was skipped for size) and
// the file only exists on the generation service until its signed URL expires.
export function isRemoteResultMediaUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

export function jobRemoteMediaEntries(job: Pick<Job, "status" | "resultUrls" | "thumbnailUrls">): RemoteMediaEntry[] {
  if (job.status !== "completed") return [];
  const entries: RemoteMediaEntry[] = [];
  (job.resultUrls ?? []).forEach((url, index) => {
    if (isRemoteResultMediaUrl(url)) entries.push({ kind: "result", index, url });
  });
  (job.thumbnailUrls ?? []).forEach((url, index) => {
    if (isRemoteResultMediaUrl(url)) entries.push({ kind: "thumbnail", index, url });
  });
  return entries;
}

// Signed URLs stop working long before this cap is reached at the default
// 10-minute recovery interval; the cap just keeps dead links from being
// re-fetched forever within one process lifetime.
const remoteRecoveryMaxAttempts = 24;
const remoteRecoveryFailureCounts = new Map<string, number>();
let remoteRecoveryRunning = false;
let remoteRecoveryTimer: NodeJS.Timeout | undefined;

export function scheduleRemoteResultRecovery(delayMs = 60_000) {
  if (!isDispatcher()) return;
  if (remoteRecoveryTimer) return;
  remoteRecoveryTimer = setTimeout(() => {
    remoteRecoveryTimer = undefined;
    void recoverRemoteResultMedia().catch(() => undefined);
  }, delayMs);
  remoteRecoveryTimer.unref?.();
}

export async function recoverRemoteResultMedia(fetchImpl: typeof fetch = fetch) {
  if (!isDispatcher()) return { recovered: 0, failed: 0 };
  refreshMainJobsCache();
  if (remoteRecoveryRunning) return { recovered: 0, failed: 0 };
  remoteRecoveryRunning = true;
  try {
    let recovered = 0;
    let failed = 0;
    const changedJobs = new Set<Job>();

    for (const job of jobs) {
      const entries = jobRemoteMediaEntries(job);
      if (!entries.length) continue;
      const project = getProject(job.projectId);
      if (!project) continue;

      const folders = await ensureJobFolders(project, job.id).catch(() => undefined);
      if (!folders) continue;

      const recoveredByUrl = new Map<string, string>();
      for (const entry of entries) {
        let localUrl = recoveredByUrl.get(entry.url);
        if (!localUrl) {
          const attempts = remoteRecoveryFailureCounts.get(entry.url) ?? 0;
          if (attempts >= remoteRecoveryMaxAttempts) continue;
          localUrl = await downloadRemoteResultMedia(entry, folders.output, job.id, fetchImpl);
          if (!localUrl) {
            remoteRecoveryFailureCounts.set(entry.url, attempts + 1);
            failed += 1;
            continue;
          }
          remoteRecoveryFailureCounts.delete(entry.url);
          recoveredByUrl.set(entry.url, localUrl);
        }

        if (entry.kind === "result") {
          job.resultUrls[entry.index] = localUrl;
        } else {
          job.thumbnailUrls[entry.index] = localUrl;
        }
        recovered += 1;
        changedJobs.add(job);
      }
    }

    for (const job of changedJobs) await persistUpsert(job);
    if (recovered || failed) {
      console.info(`[recovery] Remote result media pass: recovered ${recovered}, failed ${failed}.`);
    }
    return { recovered, failed };
  } finally {
    remoteRecoveryRunning = false;
  }
}

async function downloadRemoteResultMedia(
  entry: RemoteMediaEntry,
  outputFolder: string,
  jobId: string,
  fetchImpl: typeof fetch,
) {
  try {
    const url = new URL(entry.url);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) return undefined;

    const contentType = response.headers.get("content-type") ?? "";
    const extension = resultExtension(url, contentType);
    const fileName = `${jobId}_${entry.kind}_${String(entry.index + 1).padStart(2, "0")}_recovered${extension}`;
    const filePath = path.join(outputFolder, fileName);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > runpodOutputMaxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }

    await writeStreamAtomically(responseBodyToNodeStream(response), filePath, runpodOutputMaxBytes);
    return `/api/media?path=${encodeURIComponent(filePath)}`;
  } catch {
    return undefined;
  }
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
  const imageNames = chooseRunpodImageInputNames(job.inputImages, job.id, expectedNames);
  const inlineImageMaxBytes = runpodInlineImageByteBudget(job.inputImages.length);

  for (let index = 0; index < job.inputImages.length; index += 1) {
    const value = job.inputImages[index];
    const name = imageNames[index];
    images.push(await runpodImageInput(value, name, inlineImageMaxBytes));
  }

  return {
    images,
    imageNames: images.map((image) => image.name),
  };
}

export function chooseRunpodImageInputNames(inputImages: string[], jobId: string, expectedNames?: string[]) {
  const usedNames = new Set<string>();

  return inputImages.map((value, index) => {
    const expectedName = expectedNames?.[index]?.trim();
    const fallbackName = fallbackRunpodImageName(value, jobId, index);
    const preferredName = expectedName && !usedNames.has(runpodInputNameKey(expectedName))
      ? expectedName
      : fallbackName;

    return uniqueRunpodInputName(preferredName, usedNames);
  });
}

function uniqueRunpodInputName(preferredName: string, usedNames: Set<string>) {
  const extension = path.extname(preferredName);
  const base = extension ? preferredName.slice(0, -extension.length) : preferredName;
  let candidate = preferredName;
  let suffix = 2;

  while (usedNames.has(runpodInputNameKey(candidate))) {
    candidate = `${base}_${suffix}${extension}`;
    suffix += 1;
  }

  usedNames.add(runpodInputNameKey(candidate));
  return candidate;
}

function runpodInputNameKey(value: string) {
  return value.replaceAll("\\", "/").toLowerCase();
}

async function materializeRunpodInputVideo(job: Job, model: WorkflowModel, inputFolder: string) {
  if (!job.inputVideo) return undefined;
  const expectedNames = await detectWorkflowLoadVideoNames(model);
  const name = expectedNames?.[0] ?? fallbackRunpodVideoName(job.inputVideo, job.id);
  const filePath = localMediaFilePathFromUrl(job.inputVideo);
  const preparedFilePath = filePath
    ? await prepareRunpodVideoFile(filePath, inputFolder, model)
    : undefined;
  return {
    videos: [preparedFilePath
      ? await runpodFileInput(preparedFilePath, name, "video")
      : await runpodVideoInput(job.inputVideo, name)],
    videoName: name,
  };
}

async function runpodImageInput(value: string, name: string, inlineImageMaxBytes: number): Promise<RunpodComfyImageInput> {
  if (value.startsWith("data:image/")) {
    return runpodInlineImageDataUrlInput(value, name, inlineImageMaxBytes);
  }
  const filePath = localMediaFilePathFromUrl(value);
  if (filePath) {
    return runpodFileInput(filePath, name, "image", inlineImageMaxBytes);
  }
  if (/^https?:\/\//i.test(value)) {
    return { name, url: value };
  }
  throw new Error("RunPod image inputs must be saved media, browser data URLs, or public http(s) URLs.");
}

async function runpodVideoInput(value: string, name: string): Promise<RunpodComfyImageInput> {
  if (value.startsWith("data:video/")) {
    return runpodInlineVideoDataUrlInput(value, name);
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

async function runpodFileInput(filePath: string, name: string, kind: RunpodInputKind, inlineImageMaxBytes?: number): Promise<RunpodComfyImageInput> {
  const signedUrl = createRunpodInputUrl(filePath, kind);
  if (signedUrl) {
    return { name, url: signedUrl };
  }

  if (kind === "image") {
    return runpodInlineImageFileInput(filePath, name, inlineImageMaxBytes ?? runpodInlineImageByteBudget(1));
  }

  return {
    name,
    image: await readMediaFileAsDataUrl(filePath, kind),
  };
}

async function runpodInlineImageDataUrlInput(value: string, name: string, maxBytes: number): Promise<RunpodComfyImageInput> {
  const parsed = parseImageDataUrl(value);
  if (!parsed) {
    throw new Error("Unsupported image data URL.");
  }

  const prepared = await prepareRunpodInlineImageInput({
    buffer: parsed.buffer,
    mimeType: parsed.mimeType,
    name,
    source: name,
    maxBytes,
  });
  return { name: prepared.name, image: prepared.image };
}

async function runpodInlineImageFileInput(filePath: string, name: string, maxBytes: number): Promise<RunpodComfyImageInput> {
  const buffer = await fs.readFile(filePath);
  const prepared = await prepareRunpodInlineImageInput({
    buffer,
    mimeType: mimeTypeFromMediaPath(filePath, "image"),
    name,
    source: filePath,
    maxBytes,
  });
  return { name: prepared.name, image: prepared.image };
}

function runpodInlineVideoDataUrlInput(value: string, name: string): RunpodComfyImageInput {
  const byteLength = dataUrlBase64ByteLength(value);
  if (byteLength != null) {
    assertRunpodInlineMediaSize(byteLength, "video", name);
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
  return [brickProjectsRoot, localProjectsRoot, uploadedMediaRoot, path.join(comfyRoot, "output"), path.join(comfyRoot, "input")]
    .map((root) => path.resolve(root).toLowerCase())
    .some((root) => resolvedPath.startsWith(root));
}

async function readMediaFileAsDataUrl(filePath: string, kind: "image" | "video") {
  const stat = await fs.stat(filePath);
  assertRunpodInlineMediaSize(stat.size, kind, filePath);
  const buffer = await fs.readFile(filePath);
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

// Web/worker split Stage A: when JOBS_ROW_LEVEL_WRITES is on (SQLite driver),
// each job change is written as a single row instead of the debounced
// whole-array replaceAll. The in-memory array is still mutated by the caller
// (unchanged); only the persistence call differs. With the flag off (default),
// these delegate to persistJobs()/persistArchivedMediaJobs(), so behavior is
// byte-identical to today. Existing rows use an atomic read-modify-write so
// dispatcher persistence cannot erase an API-owned cancellation request.
async function persistUpsert(job: Job): Promise<void> {
  if (jobRowLevelWrites && sqliteStore) {
    // Respect array membership so a stale holder can't resurrect a row that was
    // concurrently removed. A runner's finally block keeps its job reference
    // across the long RunPod await; if the job is archived + permanently
    // deleted during that window, this upsert must NOT re-insert it. This
    // mirrors the flag-off invariant that replaceAll's prune provides
    // ("removed from the array ⇒ removed from the store").
    if (jobs.some((existing) => existing.id === job.id)) {
      const updated = sqliteStore.applyToJob(job.id, (current) => {
        const next = { ...job };
        // cancelRequested is API-owned. Preserve a concurrent request across
        // dispatcher writes, and never let a stale runner's finally block
        // resurrect a row after cancellation has been settled.
        if (current.cancelRequested) next.cancelRequested = true;
        if (current.cancelRequested && isDispatcher() && !isTerminalJobStatus(current.status)) {
          next.status = "canceled";
          next.completedAt = current.completedAt ?? new Date().toISOString();
        } else if (current.cancelRequested && current.status === "canceled") {
          next.status = "canceled";
          next.completedAt = current.completedAt ?? next.completedAt;
        }
        return next;
      });
      if (updated) {
        job.cancelRequested = updated.cancelRequested;
        job.status = updated.status;
        job.completedAt = updated.completedAt;
      } else {
        sqliteStore.insertJob(job);
      }
    } else {
      sqliteStore.deleteJob(job.id);
    }
    return;
  }
  await persistJobs();
}

async function persistRemove(id: string): Promise<void> {
  if (jobRowLevelWrites && sqliteStore) {
    sqliteStore.deleteJob(id);
    return;
  }
  await persistJobs();
}

async function persistArchivedUpsert(job: Job): Promise<void> {
  if (jobRowLevelWrites && archivedStore) {
    // Same membership guard as persistUpsert, against the archived set.
    if (archivedMediaJobs.some((existing) => existing.id === job.id)) {
      archivedStore.insertJob(job);
    } else {
      archivedStore.deleteJob(job.id);
    }
    return;
  }
  await persistArchivedMediaJobs();
}

async function persistArchivedRemove(id: string): Promise<void> {
  if (jobRowLevelWrites && archivedStore) {
    archivedStore.deleteJob(id);
    return;
  }
  await persistArchivedMediaJobs();
}

// Job status transitions and concurrent jobs would otherwise rewrite the whole
// jobs file many times per second. Coalesce rapid writes into one: callers keep
// awaiting persistJobs() (the in-memory array is the source of truth for reads),
// but the disk write is debounced and de-duplicated.
const persistDebounceMs = 500;
let persistTimer: NodeJS.Timeout | undefined;
let pendingPersist: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | undefined;

function persistJobs(): Promise<void> {
  if (!pendingPersist) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pendingPersist = { promise, resolve, reject };
  }
  if (!persistTimer) {
    persistTimer = setTimeout(() => void runPersistFlush(), persistDebounceMs);
    persistTimer.unref?.();
  }
  return pendingPersist.promise;
}

async function runPersistFlush() {
  persistTimer = undefined;
  const flush = pendingPersist;
  if (!flush) return;
  pendingPersist = undefined;
  try {
    if (sqliteStore) {
      sqliteStore.replaceAll(jobs);
    } else {
      await writeJsonFile(jobsStorePath, jobs);
    }
    flush.resolve();
  } catch (error) {
    flush.reject(error);
  }
}

// Flush any pending job write immediately (used on graceful shutdown).
export async function flushPersistedJobs() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  await runPersistFlush();
}

// Close the SQLite store connection (if open) so file handles are released.
// Called on graceful shutdown and by tests for deterministic cleanup.
export function closeJobStore() {
  // A clean, fully-drained shutdown can release immediately. If SQL still has
  // active jobs, leave the lease row to expire so the replacement recognizes
  // a takeover and keeps those jobs inside the global cap for their timeout.
  let releaseLease = true;
  if (dispatcherLeaseHeld && sqliteStore) {
    try {
      releaseLease = sqliteStore.countActiveJobs() === 0;
    } catch {
      releaseLease = false;
    }
  }
  stopDispatcherCoordination(releaseLease);
  sqliteStore?.close();
  sqliteStore = undefined;
  jobsCacheCursor = undefined;
  archivedStore?.close();
  archivedStore = undefined;
  archivedCacheCursor = undefined;
  inFlightJobIds.clear();
}

async function persistArchivedMediaJobs() {
  if (archivedStore) {
    archivedStore.replaceAll(archivedMediaJobs);
    return;
  }
  await writeJsonFile(archivedItemsStorePath, archivedMediaJobs);
}

// Every /api/jobs poll used to trigger this Credit Tracker round-trip. With
// ~100 clients polling, that was dozens of reconciles per second; throttle so
// it runs at most once per window regardless of poll volume.
const reconcileThrottleMs = 30_000;
let lastReconcileAt = 0;
let reconcileInFlight: Promise<void> | undefined;

function reconcileActualCreditsForStoredJobs() {
  if (!isDispatcher()) return Promise.resolve();
  refreshMainJobsCache();
  if (reconcileInFlight) return reconcileInFlight;
  if (Date.now() - lastReconcileAt < reconcileThrottleMs) return Promise.resolve();

  reconcileInFlight = runCreditReconcile().finally(() => {
    lastReconcileAt = Date.now();
    reconcileInFlight = undefined;
  });
  return reconcileInFlight;
}

async function runCreditReconcile() {
  const promptIds = jobs
    .map((job) => job.comfyPromptId)
    .filter((value): value is string => Boolean(value));
  if (!promptIds.length) return;

  const actualCredits = await getActualCreditsByPromptIds(promptIds);
  const changedJobs: Job[] = [];
  for (const job of jobs) {
    if (!job.comfyPromptId) continue;
    const credits = actualCredits.get(job.comfyPromptId);
    if (credits == null || job.creditsUsed === credits) continue;
    job.creditsUsed = credits;
    changedJobs.push(job);
  }

  for (const job of changedJobs) {
    await persistUpsert(job);
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
