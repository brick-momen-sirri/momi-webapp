import type { Job } from "../../types";

export type JobSection = "animation" | "still_images";

/**
 * Which workspace a job belongs to.
 *
 * MUST stay in step with jobSection in backend/src/jobFilters.ts, which backs the
 * ?section= query parameter. Derived from workflowOptions.stillImage rather than a
 * stored field for the same reasons as on the server: the two can never disagree,
 * every job already on disk reads back as "animation" (which is what it is), and a
 * retried job keeps its section because the retry path forwards workflowOptions
 * wholesale.
 *
 * Filtering happens client-side because the job list is already fully loaded into
 * state and narrowed by project and folder there too. The server-side filter still
 * exists for callers that want to page one section only.
 */
export function jobSection(job: Pick<Job, "workflowOptions">): JobSection {
  return job.workflowOptions?.stillImage ? "still_images" : "animation";
}

export function isStillImageJob(job: Pick<Job, "workflowOptions">) {
  return jobSection(job) === "still_images";
}
