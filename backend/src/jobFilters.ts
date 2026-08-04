// Job list filtering and the save-number search field.

import { getProject } from "./projectService.js";
import type { Job } from "./types.js";

export function normalizeJobSaveNumber(value?: number | string | null) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  return (digits || "0000").padStart(4, "0");
}

/**
 * Does this job's save number belong under "Shot" (video) rather than "Camera"?
 *
 * MUST stay in step with isVideoLikeJob in src/utils/saveNumber.ts. The backend
 * decides which number to index for search; the frontend decides which one to
 * display. When they disagree, searching "camera" fails to find a job the UI
 * labels Camera, and a job carrying both numbers is indexed under one and shown
 * as the other. Both files have a truth-table test over the same cases so a
 * change to one fails the other.
 *
 * Every signal below is positive evidence. This deliberately no longer tests
 * `outputType !== "image"`, which classified a job with no outputType as video --
 * an absent field is not evidence, and that was the one clause the two sides
 * disagreed on.
 */
export function isVideoSaveJob(job: Pick<Job, "category" | "inputType" | "modelName" | "outputType" | "durationSeconds">) {
  const modelName = job.modelName.toLowerCase();
  return (
    job.outputType === "video" ||
    job.outputType === "sequence" ||
    // durationSeconds is this side's name for what the frontend calls videoLength.
    Boolean(job.durationSeconds) ||
    job.inputType === "video" ||
    job.category.includes("video") ||
    modelName.includes("video")
  );
}

export function getJobSaveSearchValue(job: Job) {
  if (job.source === "existing_project_media") return "";

  const save = job.workflowOptions?.save;
  const value = isVideoSaveJob(job) ? (save?.shotNumber ?? save?.cameraNumber) : (save?.cameraNumber ?? save?.shotNumber);

  return normalizeJobSaveNumber(value);
}

export function filterJobs(
  jobs: Job[],
  filters: {
    projectId: string;
    folderId: string;
    source: string;
    status: string;
    outputType: string;
    q: string;
    dateDays?: number;
  },
) {
  const query = filters.q.toLowerCase();
  const cutoff = filters.dateDays ? Date.now() - filters.dateDays * 24 * 60 * 60 * 1000 : undefined;

  return jobs.filter((job) => {
    if (filters.projectId && job.projectId !== filters.projectId) return false;
    if (filters.folderId === "root" && job.folderId) return false;
    if (filters.folderId && filters.folderId !== "root" && job.folderId !== filters.folderId) return false;
    if (filters.source && job.source !== filters.source) return false;
    if (filters.status && job.status !== filters.status) return false;
    if (filters.outputType && job.outputType !== filters.outputType) return false;
    if (cutoff && new Date(job.createdAt).getTime() < cutoff) return false;

    if (query) {
      const project = getProject(job.projectId);
      const saveNumber = getJobSaveSearchValue(job);
      const saveLabel = saveNumber ? (isVideoSaveJob(job) ? "shot" : "camera") : "";
      const searchable = [
        job.id,
        job.title,
        job.prompt,
        job.modelName,
        job.fileName,
        job.folderName,
        job.userId,
        project?.name,
        project?.folderName,
        saveLabel,
        saveNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (!searchable.includes(query)) return false;
    }

    return true;
  });
}
