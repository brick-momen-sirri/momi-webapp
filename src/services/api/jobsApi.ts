import type { WorkflowOptions } from "../../types";
import { apiRequest } from "./client";
import { mapJob } from "./mappers";
import type { BackendJob, BackendJobsPage, FetchBackendJobsParams } from "./types";

type BackendJobsResponse = {
  jobs: BackendJob[];
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
};

export async function fetchBackendJobs(params: FetchBackendJobsParams = {}): Promise<BackendJobsPage> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const suffix = search.size ? `?${search.toString()}` : "";
  const data = await apiRequest<BackendJobsResponse>(`/api/jobs${suffix}`);
  const jobs = data.jobs.map(mapJob);
  return {
    jobs,
    total: data.total ?? jobs.length,
    limit: data.limit ?? jobs.length,
    offset: data.offset ?? 0,
    hasMore: data.hasMore ?? false,
  };
}

export async function createBackendJob(
  payload: {
    clientRequestId?: string;
    projectId: string;
    targetFolderId?: string | null;
    modelId: string;
    prompt?: string;
    // Optional because Still Images presets take their output size from the input
    // image. The backend already treats resolution as optional and those presets
    // advertise no supportedResolutions, so sending one would be silently ignored.
    resolution?: { width: number; height: number; label?: string };
    durationSeconds?: number;
    inputImages?: string[];
    startFrame?: string;
    endFrame?: string;
    inputVideo?: string;
    workflowOptions?: WorkflowOptions;
  },
  options: { signal?: AbortSignal } = {},
) {
  const data = await apiRequest<{ job: BackendJob; replayed?: boolean }>("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return { job: mapJob(data.job), replayed: data.replayed === true };
}

export async function renameBackendJob(projectId: string, jobId: string, title: string) {
  return mutateProjectJob(projectId, jobId, "", "PATCH", { title });
}

export async function updateBackendJobSaveNumber(projectId: string, jobId: string, saveNumber: string) {
  return mutateProjectJob(projectId, jobId, "/save-number", "PATCH", { saveNumber });
}

export async function moveBackendJobResult(projectId: string, jobId: string, destinationFolderId: string | null) {
  return mutateProjectJob(projectId, jobId, "/folder", "PATCH", { destinationFolderId });
}

async function mutateProjectJob(projectId: string, jobId: string, suffix: string, method: string, body: unknown) {
  const data = await apiRequest<{ job: BackendJob }>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}${suffix}`,
    { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  return mapJob(data.job);
}

export async function retryBackendJob(jobId: string) {
  return mutateJob(jobId, "retry", "POST");
}

/**
 * Ask the dispatcher to stop a job that has not finished yet.
 *
 * The returned job is normally still `running` with `cancelRequested` set: the
 * request is a flag the dispatcher observes on its next poll, which is also where
 * the remote RunPod job is cancelled. Callers should show "Canceling" from the
 * flag rather than treat the response as a finished cancellation.
 */
export async function cancelBackendJob(jobId: string) {
  return mutateJob(jobId, "cancel", "POST");
}

export async function archiveBackendJob(jobId: string) {
  return mutateJob(jobId, "archive", "POST");
}

export async function restoreBackendJob(jobId: string) {
  return mutateJob(jobId, "restore", "POST");
}

export async function permanentlyDeleteBackendJob(jobId: string) {
  return mutateJob(jobId, "permanent", "DELETE");
}

async function mutateJob(jobId: string, action: string, method: string) {
  const data = await apiRequest<{ job: BackendJob }>(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, { method });
  return mapJob(data.job);
}
