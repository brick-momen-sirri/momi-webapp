import path from "node:path";

import { getHistory, queuePrompt, toViewUrl } from "../comfyClient.js";
import type { ComfyGraph } from "../comfyGraph.js";
import { runpodOutputMaxBytes } from "../config.js";
import { detectMediaResolution } from "../mediaResolutionService.js";
import { projectFolderName } from "../projectFolderName.js";
import { getProject } from "../projectService.js";
import { ensureJobFolders, saveJobMetadata } from "../storageService.js";
import { responseBodyToNodeStream, writeStreamAtomically } from "../streamingMediaService.js";
import type { Job } from "../types.js";
import { getWorkflowModel, loadWorkflowPrompt, saveWorkflowSnapshot } from "../workflowService.js";
import type { ExecutionClaim } from "./executionRegistry.js";
import { ensureWorkerProjectFolder, materializeComfyInputImages, materializeComfyInputVideo, resultExtension } from "./index.js";
import { markJobCompleted } from "./lifecycleState.js";

export type LocalComfyExecutionDependencies = {
  isExecutionCurrent: (execution: ExecutionClaim) => boolean;
  mediaDiskPathFromUrl: (value: string) => string | undefined;
  persistJob: (job: Job) => Promise<void>;
  reconcileActualCredits: () => Promise<void>;
  settleRequestedCancellation: (job: Job, execution: ExecutionClaim) => Promise<boolean>;
};

export async function executeLocalComfyJob(
  job: Job,
  serverUrl: string,
  execution: ExecutionClaim,
  deps: LocalComfyExecutionDependencies,
) {
  if (!deps.isExecutionCurrent(execution) || (await deps.settleRequestedCancellation(job, execution))) return;
  const project = getProject(job.projectId);
  const model = getWorkflowModel(job.modelId);
  if (!project || !model) {
    job.status = "failed";
    job.errorMessage = "Missing project or workflow model.";
    await deps.persistJob(job);
    return;
  }

  try {
    if (await deps.settleRequestedCancellation(job, execution)) return;
    job.status = "sending";
    job.comfyServerUrl = serverUrl;
    job.startedAt = new Date().toISOString();
    await deps.persistJob(job);

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
    if (await deps.settleRequestedCancellation(job, execution)) return;

    const queued = await queuePrompt(serverUrl, workflow, `momi-${job.id}`);
    job.comfyPromptId = queued.prompt_id;
    job.status = "running";
    await deps.persistJob(job);

    const history = await waitForHistory(serverUrl, queued.prompt_id, job, execution, deps);
    const resultUrls = extractComfyResultUrls(serverUrl, history, queued.prompt_id);
    const persistedResultUrls = await persistResultMedia(resultUrls, folders.output, job.id);
    job.resultUrls = persistedResultUrls;
    job.thumbnailUrls = persistedResultUrls.slice(0, 1);
    job.outputResolution = await detectFirstPersistedResultResolution(
      persistedResultUrls,
      job.outputType,
      deps.mediaDiskPathFromUrl,
    );
    if (await deps.settleRequestedCancellation(job, execution)) return;
    if (!markJobCompleted(job, new Date().toISOString())) return;
    await deps.reconcileActualCredits();
  } catch (error) {
    if (!deps.isExecutionCurrent(execution)) return;
    const canceled = await deps.settleRequestedCancellation(job, execution);
    if (!canceled && job.status !== "canceled") {
      job.status = "failed";
      job.errorMessage = error instanceof Error ? error.message : "Unknown ComfyUI job error";
      job.completedAt = new Date().toISOString();
    }
  } finally {
    if (deps.isExecutionCurrent(execution)) {
      await deps.persistJob(job);
      await saveJobMetadata(job, project);
    }
  }
}

async function waitForHistory(
  serverUrl: string,
  promptId: string,
  job: Job,
  execution: ExecutionClaim,
  deps: LocalComfyExecutionDependencies,
) {
  const maxChecks = Number(process.env.COMFY_HISTORY_CHECKS ?? 180);
  const intervalMs = Number(process.env.COMFY_HISTORY_INTERVAL_MS ?? 2500);

  for (let index = 0; index < maxChecks; index += 1) {
    if (!deps.isExecutionCurrent(execution) || (await deps.settleRequestedCancellation(job, execution))) {
      throw new Error("Job canceled or execution ownership changed.");
    }
    const history = await getHistory(serverUrl, promptId).catch(() => ({}));
    if (history && Object.keys(history).length) {
      const promptHistory = getPromptHistory(history, promptId);
      const status = promptHistory?.status;
      if (status?.status_str === "error") {
        throw new Error(comfyHistoryErrorMessage(promptHistory) ?? "ComfyUI execution failed.");
      }
      if (status?.completed) return history;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for ComfyUI history.");
}

export function extractComfyResultUrls(serverUrl: string, history: Record<string, unknown>, promptId: string) {
  const promptHistory = getPromptHistory(history, promptId);
  const outputs = promptHistory.outputs ?? {};
  const urls: string[] = [];

  for (const output of Object.values(outputs) as Array<Record<string, unknown>>) {
    for (const key of ["images", "videos", "gifs"]) {
      const items = output[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && typeof item === "object") urls.push(toViewUrl(serverUrl, item as Record<string, unknown>));
      }
    }
  }

  const uniqueUrls = Array.from(new Set(urls));
  if (!uniqueUrls.length) throw new Error("ComfyUI completed without returning any output media.");
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

async function detectFirstPersistedResultResolution(
  resultUrls: string[],
  outputType: Job["outputType"],
  mediaDiskPathFromUrl: (value: string) => string | undefined,
) {
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

export function comfyHistoryErrorMessage(promptHistory: ComfyGraph) {
  const messages = Array.isArray(promptHistory.status?.messages) ? promptHistory.status.messages : [];
  const executionError = messages
    .map((message: unknown) => (Array.isArray(message) ? message : undefined))
    .find((message: unknown[] | undefined) => message?.[0] === "execution_error")?.[1] as Record<string, unknown> | undefined;
  const nodeType = typeof executionError?.node_type === "string" ? executionError.node_type : "ComfyUI node";
  const exception = typeof executionError?.exception_message === "string" ? executionError.exception_message.trim() : "";
  return exception ? `${nodeType}: ${exception}` : undefined;
}
