import { BackendHttpError } from "../httpError.js";
import type { Job } from "../types.js";

export function isTerminalJobStatus(status: Job["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function normalizeInterruptedRunpodJob(job: Job, options: { shouldNormalize: boolean; now: string }) {
  if ((job.status !== "sending" && job.status !== "running") || job.runpodJobId) return false;

  if (job.runpodSubmissionState === "preparing") {
    job.status = job.cancelRequested ? "canceled" : "queued";
    delete job.startedAt;
    delete job.completedAt;
    delete job.runpodSubmissionState;
    return true;
  }
  if (!options.shouldNormalize) return false;

  job.status = job.cancelRequested ? "canceled" : "failed";
  job.completedAt = job.completedAt ?? options.now;
  if (!job.cancelRequested) {
    job.errorMessage = job.errorMessage ?? "Backend restarted before this RunPod job returned. Retry the job if needed.";
  }
  job.creditsUsed = job.creditsUsed ?? 0;
  return true;
}

export function applyCancellationSettlement(job: Job, completedAt: string, runpodStatus?: string) {
  if (!job.cancelRequested || isTerminalJobStatus(job.status)) return false;
  job.status = "canceled";
  if (runpodStatus) job.runpodStatus = runpodStatus;
  job.completedAt = job.completedAt ?? completedAt;
  return true;
}

export function markJobCompleted(job: Job, completedAt: string) {
  if (job.cancelRequested || isTerminalJobStatus(job.status)) return false;
  job.status = "completed";
  job.completedAt = job.completedAt ?? completedAt;
  return true;
}

export function isExpiredOrphan(job: Job, activeExecution: boolean, cutoff: number) {
  if (activeExecution || (job.status !== "sending" && job.status !== "running")) return false;
  const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Number.NaN;
  return !Number.isFinite(startedAt) || startedAt <= cutoff;
}

export function assertJobCanBeArchived(job: Job) {
  if (isTerminalJobStatus(job.status)) return;
  throw new BackendHttpError("Cancel the job and wait for it to stop before archiving it.", {
    statusCode: 409,
    code: "job_not_terminal",
  });
}
