import crypto from "node:crypto";
import path from "node:path";
import { acquireIdleServer, releaseServer } from "./comfyPool.js";
import {
  archivedItemsSqlitePath,
  archivedItemsStorePath,
  comfyRoot,
  dispatcherLeaseHeartbeatMs,
  dispatcherLeaseTtlMs,
  dispatcherPollIntervalMs,
  dispatcherWalCheckpointMs,
  generationBackend,
  jobRowLevelWrites,
  jobStoreDriver,
  jobsSqlitePath,
  jobsStorePath,
  runpodTimeoutMs,
} from "./config.js";
import { mergeJobChangesById, mergeJobSnapshotById } from "./jobReadCache.js";
import { getActualCreditsByPromptIds } from "./creditUsageService.js";
import { getProject } from "./projectService.js";
import {
  appendAudit,
  appendManifestEvent,
  loadProjectFolders,
  validateDisplayName,
  withProjectMutationLock,
} from "./projectMetadataService.js";
import { cancelComfyWorkflowOnRunpod } from "./runpodComfyService.js";
import { isDispatcher } from "./processRole.js";
import { IdempotencyConflictError, openSqliteJobStore, type SqliteJobStore } from "./sqliteJobStore.js";
import { readJsonFileWithBackup, saveJobMetadata, snapshotJsonStore, writeJsonFile } from "./storageService.js";
import { invalidateMediaCache, scanExistingMediaJobs } from "./mediaService.js";
import { logMemory } from "./memoryLogger.js";
import { moveResultFiles } from "./resultMoveService.js";
import { getWorkflowModel } from "./workflowService.js";
import type { CreateJobRequest, Job } from "./types.js";
import {
  DebouncedJobPersistence,
  externalizeJobInputMedia,
  DispatcherLeaseCoordinator,
  loadConsistentChanges,
  loadConsistentSnapshot,
  RemoteResultRecovery,
  type StoreCacheCursor,
} from "./jobQueue/index.js";
import { commitQueuedJob } from "./jobQueue/queuedJobCommit.js";
import { buildJobListing } from "./jobQueue/archiveMembership.js";
import { ActiveExecutionRegistry, type ExecutionClaim } from "./jobQueue/executionRegistry.js";
import {
  applyCancellationSettlement,
  assertJobCanBeArchived,
  isExpiredOrphan,
  isTerminalJobStatus,
  normalizeInterruptedRunpodJob,
} from "./jobQueue/lifecycleState.js";
import { buildQueuedJob } from "./jobQueue/jobFactory.js";
import { executeLocalComfyJob } from "./jobQueue/localComfyExecution.js";
import { executeRunpodJob } from "./jobQueue/runpodExecution.js";

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
const activeExecutions = new ActiveExecutionRegistry();
const activeIdempotentCreations = new Map<string, { requestHash: string; promise: Promise<JobCreationResult> }>();
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
  activeIdempotentCreations.clear();
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
  const normalizedAt = new Date().toISOString();
  for (const job of jobs) {
    if (
      normalizeInterruptedRunpodJob(job, {
        shouldNormalize: shouldNormalizeInterruptedJob(job),
        now: normalizedAt,
      })
    ) {
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
    jobs = mergeJobSnapshotById(jobs, stable.snapshot, activeExecutions.jobIds());
    jobsCacheCursor = stable.cursor;
    return;
  }

  jobs = mergeJobChangesById(jobs, changes, activeExecutions.jobIds());
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
  return buildJobListing({ jobs, mediaJobs, archivedMediaJobs, archived, mediaFilePathFromUrl });
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
    if (!job.runpodJobId || (job.status !== "sending" && job.status !== "running")) continue;
    const execution = activeExecutions.begin(job.id);
    if (!execution) continue;

    activeRunpodJobs += 1;
    void runRunpodJob(job, execution).finally(() => {
      activeExecutions.finish(execution);
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
  const job = await buildNewQueuedJob(request);

  await commitQueuedJob(job, {
    add: (created) => {
      jobs = [created, ...jobs];
    },
    remove: (jobId) => {
      jobs = jobs.filter((candidate) => candidate.id !== jobId);
    },
    persist: persistUpsert,
    notifyDispatcher: () => {
      void dispatchQueue();
    },
  });
  return job;
}

export type JobCreationResult = { job: Job; replayed: boolean };

export async function createJobIdempotent(request: CreateJobRequest): Promise<JobCreationResult> {
  if (!request.clientRequestId) return { job: await createJob(request), replayed: false };

  const requestHash = jobRequestHash(request);
  const lockKey = `${request.userId}\u0000${request.clientRequestId}`;
  const active = activeIdempotentCreations.get(lockKey);
  if (active) {
    if (active.requestHash !== requestHash) throw new IdempotencyConflictError();
    const result = await active.promise;
    return { job: result.job, replayed: true };
  }

  const promise = createIdempotentJobOnce(request, requestHash);
  activeIdempotentCreations.set(lockKey, { requestHash, promise });
  try {
    return await promise;
  } finally {
    if (activeIdempotentCreations.get(lockKey)?.promise === promise) activeIdempotentCreations.delete(lockKey);
  }
}

async function createIdempotentJobOnce(request: CreateJobRequest, requestHash: string): Promise<JobCreationResult> {
  const requestId = request.clientRequestId!;
  const existing = findIdempotentJob(request.userId, requestId, requestHash);
  if (existing) return { job: mergeIdempotentJobIntoMemory(existing), replayed: true };

  const job = await buildNewQueuedJob(request);
  job.clientRequestHash = requestHash;

  if (sqliteStore) {
    const persisted = sqliteStore.insertIdempotentJob(job, requestHash);
    if (!persisted.inserted) return { job: mergeIdempotentJobIntoMemory(persisted.job), replayed: true };
    jobs = [job, ...jobs];
    void dispatchQueue();
    return { job, replayed: false };
  }

  await commitQueuedJob(job, {
    add: (created) => {
      jobs = [created, ...jobs];
    },
    remove: (jobId) => {
      jobs = jobs.filter((candidate) => candidate.id !== jobId);
    },
    persist: persistUpsert,
    notifyDispatcher: () => {
      void dispatchQueue();
    },
  });
  return { job, replayed: false };
}

function findIdempotentJob(userId: string, requestId: string, requestHash: string) {
  const cached = jobs.find((job) => job.userId === userId && job.clientRequestId === requestId);
  if (cached) {
    if (cached.clientRequestHash !== requestHash) throw new IdempotencyConflictError();
    return cached;
  }
  const stored = sqliteStore?.loadByClientRequestId(userId, requestId);
  if (!stored) return undefined;
  if (stored.requestHash !== requestHash) throw new IdempotencyConflictError();
  return stored.job;
}

function mergeIdempotentJobIntoMemory(job: Job) {
  const cached = jobs.find((candidate) => candidate.id === job.id);
  if (cached) return cached;
  jobs = [job, ...jobs];
  return job;
}

function jobRequestHash(request: CreateJobRequest) {
  const { clientRequestId: _clientRequestId, ...payload } = request;
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildNewQueuedJob(request: CreateJobRequest) {
  return buildQueuedJob(request, {
    getWorkflowModel,
    getProject,
    externalizeInputMedia: externalizeJobInputMedia,
    loadProjectFolders,
  });
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
async function settleRequestedCancellation(job: Job, execution?: ExecutionClaim) {
  if (execution && !activeExecutions.isCurrent(execution)) return false;
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
      applyCancellationSettlement(current, new Date().toISOString(), canceledRunpodStatus);
      return current;
    });
    if (!updated) return false;
    Object.assign(job, updated);
    return updated.status === "canceled";
  }

  if (!applyCancellationSettlement(job, new Date().toISOString(), canceledRunpodStatus)) {
    return job.status === "canceled";
  }
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

      const execution = activeExecutions.begin(next.id);
      if (!execution) {
        releaseServer(serverUrl);
        continue;
      }
      void runLocalComfyJob(next, serverUrl, execution).finally(() => {
        activeExecutions.finish(execution);
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
  const expired = jobs.filter((job) => isExpiredOrphan(job, activeExecutions.has(job.id), cutoff));

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

    const execution = activeExecutions.begin(next.id);
    if (!execution) continue;
    activeRunpodJobs += 1;
    void runRunpodJob(next, execution).finally(() => {
      activeExecutions.finish(execution);
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

function runRunpodJob(job: Job, execution: ExecutionClaim) {
  return executeRunpodJob(job, execution, {
    isExecutionCurrent: (claim) => activeExecutions.isCurrent(claim),
    isCancellationRequested: cancellationRequested,
    ownsDispatcherWork,
    persistJob: persistUpsert,
    scheduleRemoteResultRecovery,
    settleRequestedCancellation,
  });
}

function runLocalComfyJob(job: Job, serverUrl: string, execution: ExecutionClaim) {
  return executeLocalComfyJob(job, serverUrl, execution, {
    isExecutionCurrent: (claim) => activeExecutions.isCurrent(claim),
    mediaDiskPathFromUrl,
    persistJob: persistUpsert,
    reconcileActualCredits: reconcileActualCreditsForStoredJobs,
    settleRequestedCancellation,
  });
}

export function scheduleRemoteResultRecovery(delayMs = 60_000) {
  remoteResultRecovery.schedule(delayMs);
}

export async function recoverRemoteResultMedia(fetchImpl: typeof fetch = fetch) {
  refreshMainJobsCache();
  return remoteResultRecovery.recover(fetchImpl);
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
  activeExecutions.clear();
  activeIdempotentCreations.clear();
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
