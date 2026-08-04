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

export async function createBackendJob(payload: {
  projectId: string;
  targetFolderId?: string | null;
  modelId: string;
  prompt?: string;
  resolution: { width: number; height: number; label?: string };
  durationSeconds?: number;
  inputImages?: string[];
  startFrame?: string;
  endFrame?: string;
  inputVideo?: string;
  workflowOptions?: WorkflowOptions;
}) {
  const data = await apiRequest<{ job: BackendJob }>("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return mapJob(data.job);
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
