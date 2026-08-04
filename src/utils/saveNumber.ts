import type { Job } from "../types";

export function normalizeSaveNumber(value?: number | string | null) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  return (digits || "0000").padStart(4, "0");
}

export function getJobSaveNumber(job: Job) {
  const save = job.workflowOptions?.save;
  const value = isVideoLikeJob(job) ? (save?.shotNumber ?? save?.cameraNumber) : (save?.cameraNumber ?? save?.shotNumber);

  return normalizeSaveNumber(value);
}

export function getJobSaveNumberLabel(job: Job) {
  return isVideoLikeJob(job) ? "Shot" : "Camera";
}

/**
 * Does this job's save number belong under "Shot" (video) rather than "Camera"?
 *
 * MUST stay in step with isVideoSaveJob in backend/src/jobFilters.ts, which picks
 * the number indexed for search while this one picks the number displayed. Both
 * files have a truth-table test over the same cases so a change to one fails the
 * other. `backendCategory` is included for that reason: the backend has always
 * consulted its `category` field, and omitting it here was half of the drift.
 */
export function isVideoLikeJob(job: Pick<Job, "backendCategory" | "inputType" | "modelType" | "outputType" | "videoLength">) {
  const modelName = job.modelType.toLowerCase();
  return (
    job.outputType === "video" ||
    job.outputType === "sequence" ||
    Boolean(job.videoLength) ||
    job.inputType === "video" ||
    Boolean(job.backendCategory?.toLowerCase().includes("video")) ||
    modelName.includes("video")
  );
}
