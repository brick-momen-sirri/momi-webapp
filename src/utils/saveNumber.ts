import type { Job } from "../types";

export function normalizeSaveNumber(value?: number | string | null) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return (digits || "0000").padStart(4, "0");
}

export function getJobSaveNumber(job: Job) {
  const save = job.workflowOptions?.save;
  const value = isVideoLikeJob(job)
    ? save?.shotNumber ?? save?.cameraNumber
    : save?.cameraNumber ?? save?.shotNumber;

  return normalizeSaveNumber(value);
}

export function getJobSaveNumberLabel(job: Job) {
  return isVideoLikeJob(job) ? "Shot" : "Camera";
}

function isVideoLikeJob(job: Pick<Job, "inputType" | "modelType" | "outputType" | "videoLength">) {
  const modelName = job.modelType.toLowerCase();
  return (
    job.outputType === "video" ||
    job.outputType === "sequence" ||
    Boolean(job.videoLength) ||
    job.inputType === "video" ||
    modelName.includes("video")
  );
}
