import path from "node:path";
import { projectFolderName } from "./projectFolderName.js";
import { getHistory, queuePrompt, toViewUrl } from "./comfyClient.js";
import { acquireIdleServer, releaseServer } from "./comfyPool.js";
import {
  archivedItemsSqlitePath,
  archivedItemsStorePath,
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
  runpodOutputMaxBytes,
  runpodTimeoutMs,
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
  type RunpodMediaResult,
} from "./runpodComfyService.js";
import { isDispatcher } from "./processRole.js";
import {
  beginRunpodBillableOperation,
  hasExclusiveRunpodActivityWindow,
  runpodActivityBaseline,
  type RunpodActivityBaseline,
} from "./runpodActivityTracker.js";
import { openSqliteJobStore, type SqliteJobStore } from "./sqliteJobStore.js";
import { persistServerlessArtifacts } from "./serverlessArtifactService.js";
import { ensureJobFolders, readJsonFileWithBackup, saveJobMetadata, snapshotJsonStore, writeJsonFile } from "./storageService.js";
import { invalidateMediaCache, scanExistingMediaJobs } from "./mediaService.js";
import { logMemory } from "./memoryLogger.js";
import { moveResultFiles } from "./resultMoveService.js";
import { responseBodyToNodeStream, writeStreamAtomically } from "./streamingMediaService.js";
import { getWorkflowModel, loadWorkflowForRunpod, loadWorkflowPrompt, saveWorkflowSnapshot } from "./workflowService.js";
import type { CreateJobRequest, CreditBalanceSnapshot, Job } from "./types.js";
import type { ComfyGraph } from "./comfyGraph.js";
import {
  DebouncedJobPersistence,
  ensureWorkerProjectFolder,
  externalizeJobInputMedia,
  DispatcherLeaseCoordinator,
  jobRemoteMediaEntries,
  inferInputType,
  loadConsistentChanges,
  loadConsistentSnapshot,
  materializeComfyInputImages,
  materializeComfyInputVideo,
  materializeRunpodInputImages,
  materializeRunpodInputVideo,
  normalizeDurationSeconds,
  RemoteResultRecovery,
  resultExtension,
  type StoreCacheCursor,
} from "./jobQueue/index.js";

export { chooseRunpodImageInputNames, isRemoteResultMediaUrl, jobRemoteMediaEntries } from "./jobQueue/index.js";
export type { RemoteMediaEntry } from "./jobQueue/index.js";

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
let dispatchPollTimer: NodeJS.Timeout | undefined;
let dispatcherHeartbeatTimer: NodeJS.Timeout | undefined;
let walCheckpointTimer: NodeJS.Timeout | undefined;
const dispatcherLeaseCoordinator = new DispatcherLeaseCoordinator({
  enabled: usesDispatcherCoordination,
  store: () => sqliteStore,
  ttlMs: dispatcherLeaseTtlMs,
});
const remoteResultRecovery = new RemoteResultRecovery({
  jobs: () => jobs,
  persistJob: persistUpsert,
});
const jobPersistence = new DebouncedJobPersistence({
  jobs: () => jobs,
  store: () => sqliteStore,
  jsonPath: jobsStorePath,
});

export async function loadJobs() {
  if (sqliteStore || archivedStore) closeJobStore();
  acceptingNewWork = true;
  const rawJobs = await loadRawJobs();
  initializeDispatcherCoordination();
  jobs = rawJobs.map((job) => ({
    ...job,
    userId: typeof job.userId === "string" && job.userId.trim() ? job.userId : "usr_momen",
    source: job.source ?? "backend_job",
    folderId: typeof job.folderId === "string" && job.folderId.trim() ? job.folderId : null,
    title: typeof job.title === "string" && job.title.trim() ? job.title.trim() : undefined,
  }));
  await persistNormalizedRunpodJobs(normalizeInterruptedRunpodJobs());
  archivedMediaJobs = await loadRawArchivedJobs();
  resumeAcknowledgedRunpodJobs();
  startDispatcherCoordination();
  if (isDispatcher() && !usesDispatcherCoordination()) void dispatchQueue();
  return jobs;
}

// A job stuck in "sending"/"running" with no runpodJobId yet was interrupted
// before (or while) its RunPod submission was acknowledged. This can be
// observed both at boot and when a live standby dispatcher takes over the
// lease mid-session (the previous owner's lease expired while its /run POST
// was still in flight), so callers must run this any time this process
// starts or resumes owning dispatcher work, not just at boot.
function normalizeInterruptedRunpodJobs(): Job[] {
  if (!ownsDispatcherWork() || generationBackend !== "runpod") return [];
  const normalizedJobs: Job[] = [];
  for (const job of jobs) {
    if (job.status !== "sending" && job.status !== "running") continue;
    if (job.runpodJobId) continue; // Resumed by ID separately; never resubmit.

    if (job.runpodSubmissionState === "preparing") {
      job.status = job.cancelRequested ? "canceled" : "queued";
      delete job.startedAt;
      delete job.completedAt;
      delete job.runpodSubmissionState;
      normalizedJobs.push(job);
    } else if (shouldNormalizeInterruptedJob(job)) {
      job.status = job.cancelRequested ? "canceled" : "failed";
      job.completedAt = job.completedAt ?? new Date().toISOString();
      if (!job.cancelRequested) {
        job.errorMessage = job.errorMessage ?? "Backend restarted before this RunPod job returned. Retry the job if needed.";
      }
      job.creditsUsed = job.creditsUsed ?? 0;
      normalizedJobs.push(job);
    }
  }
  return normalizedJobs;
}

async function persistNormalizedRunpodJobs(normalizedJobs: Job[]) {
  if (!normalizedJobs.length) return;
  if (jobRowLevelWrites && sqliteStore) {
    for (const job of normalizedJobs) await persistUpsert(job);
  } else {
    // Persist the normalization now rather than via the debounced timer,
    // which is unref'd and may not fire before boot completes.
    persistJobs().catch(() => undefined);
    await flushPersistedJobs();
  }
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
    jobs
      .flatMap((job) => [...job.resultUrls, ...job.thumbnailUrls])
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
  const sqlActiveJobs = jobRowLevelWrites && sqliteStore ? sqliteStore.countActiveJobs() : activeRunpodJobs;

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
  return dispatcherLeaseCoordinator.isHeld();
}

function initializeDispatcherCoordination() {
  dispatcherLeaseCoordinator.reset();
  if (usesDispatcherCoordination()) dispatcherLeaseCoordinator.tryAcquire();
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
      if (!dispatcherLeaseCoordinator.isHeld()) return;
      try {
        sqliteStore?.checkpointWalPassive();
      } catch (error) {
        console.warn(`Passive job-store WAL checkpoint failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }, dispatcherWalCheckpointMs);
    walCheckpointTimer.unref?.();
  }

  if (dispatcherLeaseCoordinator.isHeld() && acceptingNewWork) void dispatchQueue();
}

function resumeAcknowledgedRunpodJobs() {
  if (generationBackend !== "runpod" || !ownsDispatcherWork()) return;
  for (const job of jobs) {
    if (!job.runpodJobId || (job.status !== "sending" && job.status !== "running") || inFlightJobIds.has(job.id)) continue;

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

  if (releaseLease) dispatcherLeaseCoordinator.release();
  else dispatcherLeaseCoordinator.reset();
}

function maintainDispatcherLease() {
  const acquired = dispatcherLeaseCoordinator.maintain();
  if (acquired) {
    void persistNormalizedRunpodJobs(normalizeInterruptedRunpodJobs());
    resumeAcknowledgedRunpodJobs();
  }
  return acquired;
}

function ensureDispatcherLease() {
  if (!isDispatcher()) return false;
  if (!usesDispatcherCoordination()) return true;
  if (dispatcherLeaseCoordinator.isHeld()) return true;
  const acquired = dispatcherLeaseCoordinator.tryAcquire();
  if (acquired) {
    void persistNormalizedRunpodJobs(normalizeInterruptedRunpodJobs());
    resumeAcknowledgedRunpodJobs();
  }
  return acquired;
}

function shouldNormalizeInterruptedJob(job: Job) {
  return dispatcherLeaseCoordinator.shouldNormalizeInterruptedJob(job.startedAt, runpodTimeoutMs);
}

function dispatcherLeaseSnapshot() {
  return dispatcherLeaseCoordinator.snapshot(isDispatcher());
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
  const targetFolderId =
    typeof request.targetFolderId === "string" && request.targetFolderId.trim() ? request.targetFolderId.trim() : null;
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
    inputImages:
      preparedRequest.inputImages ?? ([preparedRequest.startFrame, preparedRequest.endFrame].filter(Boolean) as string[]),
    inputVideo: preparedRequest.inputVideo,
    resultUrls: [],
    thumbnailUrls: [],
    outputType: model.outputType,
    projectFolderPath: project.folderPath,
    workflowPath: model.workflowPath,
    creditsEstimated: estimateWorkflowCredits(
      model,
      durationSeconds,
      preparedRequest.resolution,
      preparedRequest.workflowOptions,
    ),
    source: "backend_job",
    createdAt: new Date().toISOString(),
  };

  jobs = [job, ...jobs];
  await persistUpsert(job);
  void dispatchQueue();
  return job;
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
      // The remote job may still be running (and billing) on RunPod. Leave
      // the local status as-is and cancelRequested set so this is retried on
      // the next poll, instead of marking it canceled while it may not be.
      console.warn(
        `Could not cancel RunPod job ${job.runpodJobId}, will retry: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return false;
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

  const existingJob =
    backendJob ?? (await getJobsWithExistingMedia()).find((job) => job.id === jobId && job.projectId === projectId);
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

  const existingJob =
    backendJob ?? (await getJobsWithExistingMedia()).find((job) => job.id === jobId && job.projectId === projectId);
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

export async function moveJobResult(projectId: string, jobId: string, destinationFolderId: string | null, userId: string) {
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
            `Could not persist result move: ${error instanceof Error ? error.message : "metadata write failed"}. ` +
              `Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : "filesystem operation failed"}`,
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
          console.warn(
            `Could not record result move audit for ${jobId}: ${auditWrite.reason instanceof Error ? auditWrite.reason.message : "unknown error"}`,
          );
        }
      }

      return job;
    });
  });
}

function serializeResultMove<T>(operation: () => Promise<T>) {
  const result = resultMoveQueue.then(operation, operation);
  resultMoveQueue = result.then(
    () => undefined,
    () => undefined,
  );
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
      const next =
        claimNextJobForDispatch(Number.MAX_SAFE_INTEGER) ??
        (!jobRowLevelWrites || !sqliteStore ? jobs.find((job) => job.status === "queued") : undefined);
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
    job.errorMessage =
      job.errorMessage ??
      "The prior dispatcher stopped and the RunPod timeout elapsed before the job returned. Retry the job if needed.";
    job.creditsUsed = job.creditsUsed ?? 0;
    await persistUpsert(job);
  }
}

async function dispatchRunpodJobs() {
  const usesSqlClaims = jobRowLevelWrites && Boolean(sqliteStore);
  while (acceptingNewWork && (usesSqlClaims || activeRunpodJobs < runpodJobConcurrency)) {
    if (!ensureDispatcherLease()) return;
    const next = usesSqlClaims ? claimNextJobForDispatch(runpodJobConcurrency) : jobs.find((job) => job.status === "queued");
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
    usesDispatcherCoordination() ? dispatcherLeaseCoordinator.ownerId : undefined,
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
    job.creditBalanceBefore = job.creditBalanceBefore ?? (await captureCreditBalanceSnapshot());
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
      capturedAt:
        credits.updatedAt && Number.isFinite(new Date(credits.updatedAt).getTime())
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

export function scheduleRemoteResultRecovery(delayMs = 60_000) {
  remoteResultRecovery.schedule(delayMs);
}

export async function recoverRemoteResultMedia(fetchImpl: typeof fetch = fetch) {
  refreshMainJobsCache();
  return remoteResultRecovery.recover(fetchImpl);
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

function getPromptHistory(history: Record<string, unknown>, promptId: string) {
  return (history[promptId] ?? history) as ComfyGraph;
}

function comfyHistoryErrorMessage(promptHistory: ComfyGraph) {
  const messages = Array.isArray(promptHistory.status?.messages) ? promptHistory.status.messages : [];
  const executionError = messages
    .map((message: unknown) => (Array.isArray(message) ? message : undefined))
    .find((message: unknown[] | undefined) => message?.[0] === "execution_error")?.[1] as Record<string, unknown> | undefined;

  const nodeType = typeof executionError?.node_type === "string" ? executionError.node_type : "ComfyUI node";
  const exception = typeof executionError?.exception_message === "string" ? executionError.exception_message.trim() : "";
  return exception ? `${nodeType}: ${exception}` : undefined;
}

function preferredResultMedia(media: RunpodMediaResult[]) {
  const videos = media.filter((item) => item.isVideo);
  return videos.length ? videos : media;
}

function normalizeEditableSaveNumber(value: unknown) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!digits) {
    throw new Error("Shot/camera number is required.");
  }
  return digits.padStart(4, "0");
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
function persistJobs(): Promise<void> {
  return jobPersistence.request();
}

// Flush any pending job write immediately (used on graceful shutdown).
export async function flushPersistedJobs() {
  await jobPersistence.flush();
}

// Close the SQLite store connection (if open) so file handles are released.
// Called on graceful shutdown and by tests for deterministic cleanup.
export function closeJobStore() {
  // A clean, fully-drained shutdown can release immediately. If SQL still has
  // active jobs, leave the lease row to expire so the replacement recognizes
  // a takeover and keeps those jobs inside the global cap for their timeout.
  let releaseLease = true;
  if (dispatcherLeaseCoordinator.isHeld() && sqliteStore) {
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
  const promptIds = jobs.map((job) => job.comfyPromptId).filter((value): value is string => Boolean(value));
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
