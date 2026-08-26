import { creditBalanceDeltaAccountingEnabled } from "../config.js";
import { estimateFallbackCreditUsage } from "../creditEstimator.js";
import { getCredits } from "../creditService.js";
import { syncServerlessCreditUsage } from "../creditTrackerSyncService.js";
import {
  balanceDeltaCredits,
  COMPANY_BALANCE_DELTA_SOURCE,
  creditsSpentForAccounting,
  isCountedCreditUsage,
  isCreditExemptJob,
} from "../creditUsageAccounting.js";
import { logMemory } from "../memoryLogger.js";
import { mergeRunpodTiming, POD_RUNTIME_SOURCE, podRuntimeCost, podRuntimePricingConfigured } from "../podRuntimeCost.js";
import { resolveRunpodWorkerGpu } from "../runpodWorkerGpu.js";
import { projectFolderName } from "../projectFolderName.js";
import { getProject } from "../projectService.js";
import {
  RunpodComfyCanceledError,
  RunpodComfyError,
  resumeComfyWorkflowOnRunpod,
  runComfyWorkflowOnRunpod,
  type RunpodComfyImageInput,
  type RunpodMediaResult,
} from "../runpodComfyService.js";
import { resolveRunpodEndpoint } from "../runpodEndpoints.js";
import { stillImageRequestSlotCount, type StillImageOptions } from "../stillImageCategories.js";
import { buildStillImageWorkflow, stillImageNodeStatusLabel } from "../stillImageWorkflow.js";
import { materializeStillImageInputs } from "./stillImageInputMaterializer.js";
import {
  beginRunpodBillableOperation,
  hasExclusiveRunpodActivityWindow,
  runpodActivityBaseline,
  type RunpodActivityBaseline,
} from "../runpodActivityTracker.js";
import { persistServerlessArtifacts } from "../serverlessArtifactService.js";
import { validateRunpodImageRequirements } from "../runpodImagePreflight.js";
import { ensureJobFolders, saveJobMetadata } from "../storageService.js";
import type { CreditBalanceSnapshot, Job, WorkflowModel } from "../types.js";
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
    setJobPhase(job, "preparing");
    job.creditBalanceBefore = job.creditBalanceBefore ?? (await captureCreditBalanceSnapshot());
    if (job.creditBalanceBefore) await deps.persistJob(job);

    // Resolved before any file or upload work so a preset with no configured pod
    // fails immediately, rather than after materializing inputs. Recorded on the
    // job so a resume or cancel after a dispatcher restart addresses the endpoint
    // that actually holds the work. Left unset when only a base URL override is
    // configured (the topology load test), where there is no id to remember.
    const endpoint = resolveRunpodEndpoint(job);
    if (endpoint.id) job.runpodEndpointId = endpoint.id;

    const folders = await ensureJobFolders(project, job.id);
    const projectFolder = projectFolderName(project.folderPath);

    // Still image presets take a different route to the same place: their own
    // materializer and graph builder, because the generic ones are unsafe for
    // these exports (duplicate LoadImage filenames, a dead LoadImage node, and
    // base64 nodes that must never receive a URL). Everything after this point --
    // preflight, snapshot, submission-state persistence, the resume path -- is the
    // shared lifecycle, unchanged.
    const stillImage = job.workflowOptions?.stillImage;
    const prepared = await prepareRunpodSubmission(job, model, projectFolder, folders.input);
    const workflow = prepared.workflow;
    const runpodImages = prepared.runpodImages;
    const runpodVideo = prepared.runpodVideo;

    // A resumed async job has already crossed the provider boundary. Preflight
    // only new submissions so a deploy cannot strand an acknowledged RunPod job.
    // Skipped for still images: that check counts LoadImage nodes by class name,
    // which miscounts these graphs, and the binding pass in the builder is the
    // stronger equivalent -- every slot is written or the build fails.
    if (!job.runpodJobId && !stillImage) await validateRunpodImageRequirements(workflow, job.inputImages);
    await saveWorkflowSnapshot(folders.workflowSnapshotPath, workflow);
    job.workflowSnapshotPath = folders.workflowSnapshotPath;
    if (await deps.settleRequestedCancellation(job, execution)) return;
    job.status = "running";
    if (!job.runpodJobId) job.runpodSubmissionState = "submitting";
    setJobPhase(job, "submitting");
    await deps.persistJob(job);

    logMemory("before-runpod-request", job.id);
    const shouldStopRunpodWork = () =>
      deps.isCancellationRequested(job) || !deps.isExecutionCurrent(execution) || !deps.ownsDispatcherWork();

    /**
     * Translates a poll into a phase, and writes only when something actually
     * changed. Polling runs every few seconds for the life of the job, so
     * persisting each observation would mean a database write per job per tick
     * for a number the client can derive from phaseStartedAt on its own.
     */
    const onPoll = async (observation: Parameters<NonNullable<Parameters<typeof runComfyWorkflowOnRunpod>[0]["onPoll"]>>[0]) => {
      // Before the phase check, so the terminal poll counts. That poll is the only
      // one carrying a final executionTime -- while a job is IN_PROGRESS the figure
      // is whatever had elapsed so far -- and it is the one this returns early on.
      // Kept on the job rather than in a local: it has to survive the deletion of
      // runpodProgress on completion, and a failed run's timing is worth reading too.
      recordRunpodTiming(job, observation);
      await recordRunpodWorkerGpu(job, observation.workerId);

      const phase = observation.status === "IN_QUEUE" ? "queued" : observation.status === "IN_PROGRESS" ? "running" : undefined;
      if (!phase) return;
      const previous = job.runpodProgress;

      // The newest chunk that names a node we have a label for. Chunks arrive
      // oldest-first and most name nothing useful, so this walks backwards for
      // the latest recognisable step rather than reporting the first.
      let detail = previous?.detail;
      let step: { done: number; total: number } | undefined;
      let item: number | undefined;
      for (const chunk of [...(observation.streamChunks ?? [])].reverse()) {
        const label = stillImage ? stillImageNodeStatusLabel(stillImage.categoryId, chunk.nodeId) : undefined;
        if (label) {
          detail = label;
          step = chunk.step;
          item = chunk.item;
          break;
        }
      }

      // The trail of what is finished. A step joins it when a different one
      // starts, so the current step is never listed as done.
      const completedSteps = [...(previous?.completedSteps ?? [])];
      if (previous?.detail && detail && previous.detail !== detail && !completedSteps.includes(previous.detail)) {
        completedSteps.push(previous.detail);
        // Bounded: this rides on every job payload the API returns.
        while (completedSteps.length > 12) completedSteps.shift();
      }

      const unchanged =
        previous?.phase === phase &&
        previous.workerId === observation.workerId &&
        previous.delayMs === observation.delayMs &&
        previous.runpodStatus === observation.status &&
        previous.detail === detail &&
        previous.stepDone === step?.done &&
        previous.item === item;
      if (unchanged) return;

      setJobPhase(job, phase, {
        runpodStatus: observation.status,
        workerId: observation.workerId,
        delayMs: observation.delayMs,
        detail,
        stepDone: step?.done,
        stepTotal: step?.total,
        item,
        completedSteps,
        // A phase that is only gaining detail (a worker id arriving, or the next
        // node starting) keeps its original start time, or the elapsed counter
        // would jump back to zero on every step.
        keepStartedAt: previous?.phase === phase,
      });
      await deps.persistJob(job);
    };

    const result = job.runpodJobId
      ? await resumeComfyWorkflowOnRunpod({ jobId: job.runpodJobId, shouldCancel: shouldStopRunpodWork, endpoint, onPoll })
      : await runComfyWorkflowOnRunpod({
          onPoll,
          workflow,
          images: runpodImages.images,
          videos: runpodVideo?.videos ?? [],
          shouldCancel: shouldStopRunpodWork,
          endpoint,
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
    applyPodRuntimeCostToJob(job);
    applyAccountingCreditsToJob(job);
    job.outputType = selectedMedia.some((item) => item.isVideo) ? "video" : job.outputType;

    // The provider is done; everything after this is ours -- pulling the result
    // out of S3, building previews, filing it into the project folder.
    setJobPhase(job, "saving");
    await deps.persistJob(job);

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
    job.resultRemoteRefs = artifacts.resultRemoteRefs;
    job.thumbnailUrls = artifacts.thumbnailUrls;
    job.fileName = artifacts.selectedArtifacts[0]?.fileName ?? selectedMedia[0]?.filename;
    job.outputResolution = artifacts.outputResolution;
    job.outputBytes = artifacts.outputBytes;

    // Credit-exempt presets are not pushed to the Credit Tracker either. That
    // sync is what actually books the spend outside this app, so counting them
    // nowhere in here while still filing a row there would put the two systems
    // permanently out of step.
    if (isCountedCreditUsage(creditUsage) && !isCreditExemptJob(job)) {
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
    // A finished card must stop claiming a worker is busy on it.
    delete job.runpodProgress;
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
      delete job.runpodProgress;
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
      // A run that failed after four minutes on the pod cost the same as one that
      // succeeded in four minutes. Priced from whatever execution time RunPod had
      // reported, which is nothing at all for a job that never reached a worker.
      applyPodRuntimeCostToJob(job);
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

/**
 * Records what the job is doing now.
 *
 * Clearing it on a terminal state matters: a finished or failed card must not
 * keep claiming a worker is busy on it.
 */
function setJobPhase(
  job: Job,
  phase: NonNullable<Job["runpodProgress"]>["phase"],
  options: {
    runpodStatus?: string;
    workerId?: string;
    delayMs?: number;
    detail?: string;
    stepDone?: number;
    stepTotal?: number;
    item?: number;
    completedSteps?: string[];
    keepStartedAt?: boolean;
  } = {},
) {
  const previous = job.runpodProgress;
  // The trail survives a phase change unless the caller replaces it. Losing it
  // on the move to "saving" wiped the record at the moment it was most worth
  // reading: the card went from ticked steps back to none, right at the end.
  const carried = options.completedSteps ?? previous?.completedSteps ?? [];
  // A phase change also retires whatever step was running -- it finished, so it
  // belongs above the line rather than disappearing.
  const completedSteps =
    !options.completedSteps && previous?.detail && previous.phase !== phase && !carried.includes(previous.detail)
      ? [...carried, previous.detail].slice(-12)
      : carried;

  job.runpodProgress = {
    phase,
    runpodStatus: options.runpodStatus,
    workerId: options.workerId,
    delayMs: options.delayMs,
    detail: options.detail,
    stepDone: options.stepDone,
    stepTotal: options.stepTotal,
    item: options.item,
    completedSteps: completedSteps.length ? completedSteps : undefined,
    phaseStartedAt: (options.keepStartedAt && previous?.phaseStartedAt) || new Date().toISOString(),
  };
}

function recordRunpodTiming(job: Job, observation: { delayMs?: number; executionMs?: number; workerId?: string }) {
  const timing = mergeRunpodTiming(job.runpodTiming, observation);
  if (timing) job.runpodTiming = timing;
}

/**
 * Note which GPU the worker on this job turned out to have.
 *
 * Asked here, mid-run, and not at settle: RunPod answers for a worker only while it
 * exists, and a serverless worker is torn down after its idle timeout. The first
 * poll that names one is the safest moment there is.
 *
 * One await, once per job, and only for a preset that could be priced. The lookup
 * caches by worker id -- a warm worker takes job after job -- carries its own
 * timeout and never throws, so the worst it can do to a render is delay one poll.
 */
async function recordRunpodWorkerGpu(job: Job, workerId: string | undefined) {
  if (!workerId || job.runpodTiming?.gpuTypeId) return;
  if (!job.workflowOptions?.stillImage || !podRuntimePricingConfigured()) return;

  const gpu = await resolveRunpodWorkerGpu(workerId);
  if (!gpu) return;
  const timing = mergeRunpodTiming(job.runpodTiming, { gpuTypeId: gpu.gpuTypeId, gpuCostPerHr: gpu.costPerHr });
  if (timing) job.runpodTiming = timing;
}

/**
 * Price the pod time a Still Images job used, when it can be measured.
 *
 * Left alone when something already measured this job's spend -- the company
 * balance delta, where that is enabled, watches real money leave the account over a
 * window the job had to itself, which is the stronger claim of the two.
 */
function applyPodRuntimeCostToJob(job: Job) {
  if (job.creditsActual !== undefined) return;
  const cost = podRuntimeCost(job);
  if (!cost) return;
  job.creditsActual = cost.credits;
  job.creditsActualSource = POD_RUNTIME_SOURCE;
  job.creditsUsed = cost.credits;
  // The seconds and the GPU are already on the job; this is the third term, so a
  // figure can be checked -- or re-derived after a repricing -- without guessing
  // which rate was in force when it ran.
  job.runpodTiming = { ...job.runpodTiming, usdPerSecond: cost.usdPerSecond };
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

export type PreparedSubmission = {
  workflow: unknown;
  runpodImages: { images: RunpodComfyImageInput[]; imageNames: string[] };
  runpodVideo: { videos: RunpodComfyImageInput[]; videoName: string } | undefined;
};

/**
 * Build everything the provider call needs, choosing the route by job kind.
 *
 * Exported so the two routes can be tested against each other directly: the point
 * of the split is that Animation behaviour is untouched, and that is only worth
 * asserting side by side.
 */
export async function prepareRunpodSubmission(
  job: Job,
  model: WorkflowModel,
  projectFolder: string,
  inputFolder: string,
): Promise<PreparedSubmission> {
  const stillImage = job.workflowOptions?.stillImage;
  return stillImage
    ? prepareStillImageSubmission(job, stillImage)
    : prepareAnimationSubmission(job, model, projectFolder, inputFolder);
}

/** The existing path, moved verbatim so the still image branch sits beside it. */
async function prepareAnimationSubmission(
  job: Job,
  model: WorkflowModel,
  projectFolder: string,
  inputFolder: string,
): Promise<PreparedSubmission> {
  const runpodImages = await materializeRunpodInputImages(job, model);
  const runpodVideo = await materializeRunpodInputVideo(job, model, inputFolder);
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
  return { workflow, runpodImages, runpodVideo };
}

/**
 * Materialize explicit slots, then wire the preset's graph.
 *
 * Ordered materialize-then-build because the graph value for a load-image slot is
 * the payload filename, and compression can change its extension. Building first
 * would bake in a name the worker never writes.
 *
 * Any failure here throws before the caller reaches submission, so an oversized
 * inline image costs nothing and cannot produce a paid RunPod call.
 */
async function prepareStillImageSubmission(job: Job, stillImage: StillImageOptions): Promise<PreparedSubmission> {
  const imageCount = stillImageRequestSlotCount(stillImage);
  const materialized = await materializeStillImageInputs({
    categoryId: stillImage.categoryId,
    imageCount,
    inputImages: job.inputImages,
  });

  const workflow = await buildStillImageWorkflow({
    options: stillImage,
    prompt: job.prompt,
    images: materialized.graphValues,
  });

  return {
    workflow,
    runpodImages: { images: materialized.payloadImages, imageNames: materialized.payloadImages.map((image) => image.name) },
    runpodVideo: undefined,
  };
}
