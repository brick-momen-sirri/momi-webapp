import type { Job } from "../types.js";

export type JobListingInput = {
  jobs: Job[];
  mediaJobs: Job[];
  archivedMediaJobs: Job[];
  archived: boolean;
  mediaFilePathFromUrl: (value: string) => string | undefined;
};

export function buildJobListing({ jobs, mediaJobs, archivedMediaJobs, archived, mediaFilePathFromUrl }: JobListingInput) {
  const backendResultPaths = new Set(
    jobs
      .flatMap((job) => [...job.resultUrls, ...job.thumbnailUrls])
      .map(mediaFilePathFromUrl)
      .filter((item): item is string => Boolean(item)),
  );
  const archivedMediaIds = new Set(archivedMediaJobs.map((job) => job.id));
  const map = new Map<string, Job>();

  for (const job of mediaJobs) {
    if (archivedMediaIds.has(job.id)) continue;
    const mediaPaths = [...job.resultUrls, ...job.thumbnailUrls]
      .map(mediaFilePathFromUrl)
      .filter((item): item is string => Boolean(item));
    if (mediaPaths.some((filePath) => backendResultPaths.has(filePath))) continue;
    map.set(job.id, job);
  }
  for (const job of jobs) {
    if (Boolean(job.archivedAt) !== archived) continue;
    map.set(job.id, { ...job, source: job.source ?? "backend_job" });
  }
  if (archived) {
    for (const job of archivedMediaJobs) {
      map.set(job.id, { ...job, source: "existing_project_media" });
    }
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
