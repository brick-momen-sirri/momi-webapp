import { creditBalanceDeltaAccountingEnabled } from "../config.js";
import { estimateFallbackCreditUsage } from "../creditEstimator.js";
import { getCredits } from "../creditService.js";
import { syncServerlessCreditUsage } from "../creditTrackerSyncService.js";
import {
  balanceDeltaCredits,
  COMPANY_BALANCE_DELTA_SOURCE,
  creditsSpentForAccounting,
  isCountedCreditUsage,
} from "../creditUsageAccounting.js";
import { logMemory } from "../memoryLogger.js";
import { projectFolderName } from "../projectFolderName.js";
import { getProject } from "../projectService.js";
import {
  RunpodComfyCanceledError,
  RunpodComfyError,
  resumeComfyWorkflowOnRunpod,
  runComfyWorkflowOnRunpod,
  type RunpodMediaResult,
} from "../runpodComfyService.js";
import {
  beginRunpodBillableOperation,
  hasExclusiveRunpodActivityWindow,
  runpodActivityBaseline,
  type RunpodActivityBaseline,
} from "../runpodActivityTracker.js";
import { persistServerlessArtifacts } from "../serverlessArtifactService.js";
import { ensureJobFolders, saveJobMetadata } from "../storageService.js";
import type { CreditBalanceSnapshot, Job } from "../types.js";
import { getWorkflowModel, loadWorkflowForRunpod, saveWorkflowSnapshot } from "../workflowService.js";
import type { ExecutionClaim } from "./executionRegistry.js";
import { jobRemoteMediaEntries, materializeRunpodInputImages, materializeRunpodInputVideo } from "./index.js";
import { markJobCompleted } from "./lifecycleState.js";

export type RunpodExecutionDependencies = {
  isExecutionCurrent: (execution: ExecutionClaim) => boolean;
  isCancellationRequested: (job: Job) => boolean;
  ownsDispatcherWork: () => boolean;
  persistJob: (job: Job) => Promise<void>;
  scheduleRemoteResultRecovery: () => void;
  settleRequestedCancellation: (job: Job, execution: ExecutionClaim) => Promise<boolean>;
};

export async function executeRunpodJob(job: Job, execution: ExecutionClaim, deps: RunpodExecutionDependencies) {
  logMemory("job-start", job.id);
  if (!deps.isExecutionCurrent(execution) || (await deps.settleRequestedCancellation(job, execution))) return;
  const project = getProject(job.projectId);
  let outputProject = project;
  const model = getWorkflowModel(job.modelId);
  if (!project || !model) {
    job.status = "failed";
    job.errorMessage = "Missing project or workflow model.";
    await deps.persistJob(job);
    return;
  }

  const endBillableOperation = beginRunpodBillableOperation();
  const activityBaseline = runpodActivityBaseline();
  let dispatcherLeaseLost = false;
  try {
    if (await deps.settleRequestedCancellation(job, execution)) return;
    if (job.status !== "sending") {
      job.status = "sending";
      job.startedAt = new Date().toISOString();
      await deps.persistJob(job);
    }

    if (!job.runpodJobId) job.runpodSubmissionState = "preparing";
    job.creditBalanceBefore = job.creditBalanceBefore ?? (await captureCreditBalanceSnapshot());
    if (job.creditBalanceBefore) await deps.persistJob(job);

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
    if (await deps.settleRequestedCancellation(job, execution)) return;
    job.status = "running";
    if (!job.runpodJobId) job.runpodSubmissionState = "submitting";
    await deps.persistJob(job);

    logMemory("before-runpod-request", job.id);
    const shouldStopRunpodWork = () =>
      deps.isCancellationRequested(job) || !deps.isExecutionCurrent(execution) || !deps.ownsDispatcherWork();
    const result = job.runpodJobId
      ? await resumeComfyWorkflowOnRunpod({ jobId: job.runpodJobId, shouldCancel: shouldStopRunpodWork })
      : await runComfyWorkflowOnRunpod({
          workflow,
          images: runpodImages.images,
          videos: runpodVideo?.videos ?? [],
          shouldCancel: shouldStopRunpodWork,
          onSubmitted: async ({ jobId, status }) => {
            if (!deps.isExecutionCurrent(execution) || !deps.ownsDispatcherWork()) {
              throw new DispatcherLeaseLostError();
            }
            job.runpodJobId = jobId;
            job.runpodStatus = status;
            job.runpodSubmissionState = "submitted";
            await deps.persistJob(job);
          },
        });
    logMemory("after-runpod-request", job.id);
    if (!deps.isExecutionCurrent(execution) || !deps.ownsDispatcherWork()) throw new DispatcherLeaseLostError();
    if (await deps.settleRequestedCancellation(job, execution)) return;
    job.runpodJobId = result.jobId;
    job.runpodStatus = result.status;
    job.generatedPrompt = result.generatedText;
    job.textArtifacts = result.textArtifacts;
    await captureRunpodPostBalance(job, activityBaseline);

    const selectedMedia = preferredResultMedia(result.media);
    if (!selectedMedia.length) throw new Error("RunPod completed without returning any output media.");

    const creditUsage = result.creditUsage ?? estimateFallbackCreditUsage(model, workflow, job.durationSeconds, job.resolution);
    job.creditUsage = creditUsage;
    applyAccountingCreditsToJob(job);
    job.outputType = selectedMedia.some((item) => item.isVideo) ? "video" : job.outputType;

    logMemory("before-runpod-download", job.id);
    outputProject = getProject(job.projectId) ?? project;
    const artifacts = await persistServerlessArtifacts({
      project: outputProject,
      job,
      model,
      media: result.media,
      selectedMedia,
    });
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

    if (await deps.settleRequestedCancellation(job, execution)) return;
    if (!markJobCompleted(job, new Date().toISOString())) return;
    if (jobRemoteMediaEntries(job).length) deps.scheduleRemoteResultRecovery();
    logMemory("job-finished", job.id);
  } catch (error) {
    if (!deps.isExecutionCurrent(execution)) return;
    if (error instanceof DispatcherLeaseLostError || (error instanceof RunpodComfyCanceledError && !deps.ownsDispatcherWork())) {
      dispatcherLeaseLost = true;
      console.warn(`Dispatcher lease lost while handling ${job.id}; the current lease owner will resume it.`);
      return;
    }
    const canceled = await deps.settleRequestedCancellation(job, execution);
    if (!canceled && job.status !== "canceled") {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      await captureRunpodPostBalance(job, activityBaseline);
      if (error instanceof RunpodComfyError) {
        job.runpodJobId = error.jobId ?? job.runpodJobId;
        job.runpodStatus = error.status;
        job.errorMessage = error.message;
        if (error.creditUsage) job.creditUsage = error.creditUsage;
      } else {
        job.errorMessage = error instanceof Error ? error.message : "Unknown RunPod job error";
      }
      applyAccountingCreditsToJob(job);
    }
    logMemory(canceled || error instanceof RunpodComfyCanceledError ? "job-canceled" : "job-failed", job.id);
  } finally {
    endBillableOperation();
    if (!dispatcherLeaseLost && deps.isExecutionCurrent(execution)) {
      await deps.persistJob(job);
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
  if (!creditBalanceDeltaAccountingEnabled || !hasExclusiveRunpodActivityWindow(activityBaseline)) return;

  const actualCredits = balanceDeltaCredits(job.creditBalanceBefore, job.creditBalanceAfter);
  if (actualCredits == null) return;
  job.creditsActual = actualCredits;
  job.creditsActualSource = COMPANY_BALANCE_DELTA_SOURCE;
  job.creditsUsed = actualCredits;
}

function applyAccountingCreditsToJob(job: Job) {
  const credits = creditsSpentForAccounting(job);
  if (credits > 0) job.creditsUsed = credits;
  else delete job.creditsUsed;
}

export function preferredResultMedia(media: RunpodMediaResult[]) {
  const videos = media.filter((item) => item.isVideo);
  return videos.length ? videos : media;
}
