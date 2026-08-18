// Narrowing and ordering the still image results list.
//
// The panel used to render every result the project had, newest first, as a
// full-width card carrying a compare slider up to 85vh tall. That is the right way
// to judge one render and a poor way to find one among thirty: a project's worth of
// results is thirty screens of scrolling with no way to ask "the Pro Upscaler runs
// on camera 12" or "the one that failed".
//
// Kept out of the component and pure so the rules are testable on their own, and so
// the counts the header reports come from the same function that builds the list.

import type { Job } from "../../types";
import { measuredPodUsd } from "./podRuntimeCost";
import { STILL_IMAGE_CATEGORIES, type StillImageCategoryId } from "./stillImageCategories";

export type StillImageResultStatus = "all" | "completed" | "working" | "failed";
export type StillImageResultSort = "newest" | "oldest" | "cost";

/** "root" is a real destination -- the project folder itself -- not the absence of one. */
export const ROOT_FOLDER_FILTER = "root";

export type StillImageResultFilters = {
  query: string;
  presetId: StillImageCategoryId | "all";
  status: StillImageResultStatus;
  folderId: string;
  sort: StillImageResultSort;
};

export const DEFAULT_STILL_IMAGE_RESULT_FILTERS: StillImageResultFilters = {
  query: "",
  presetId: "all",
  status: "all",
  folderId: "all",
  sort: "newest",
};

export function hasActiveStillImageFilters(filters: StillImageResultFilters) {
  return (
    filters.query.trim() !== "" || filters.presetId !== "all" || filters.status !== "all" || filters.folderId !== "all"
  );
}

/** The presets to offer, labelled. Built from the catalogue so it cannot fall behind it. */
export const STILL_IMAGE_PRESET_FILTER_OPTIONS = STILL_IMAGE_CATEGORIES.map((category) => ({
  value: category.id,
  label: category.label,
}));

export function filterStillImageJobs(jobs: Job[], filters: StillImageResultFilters) {
  const query = filters.query.trim().toLowerCase();
  const matched = jobs.filter((job) => {
    if (filters.presetId !== "all" && job.workflowOptions?.stillImage?.categoryId !== filters.presetId) return false;
    if (!matchesStatus(job, filters.status)) return false;
    if (!matchesFolder(job, filters.folderId)) return false;
    return !query || searchableText(job).includes(query);
  });

  return sortStillImageJobs(matched, filters.sort);
}

function matchesStatus(job: Job, status: StillImageResultStatus) {
  if (status === "all") return true;
  if (status === "completed") return job.status === "completed";
  // Canceled sits with failed: both mean "no result came of it", which is what
  // someone filtering for trouble is looking for.
  if (status === "failed") return job.status === "failed" || job.status === "canceled";
  return job.status === "queued" || job.status === "sending" || job.status === "running";
}

function matchesFolder(job: Job, folderId: string) {
  if (folderId === "all") return true;
  if (folderId === ROOT_FOLDER_FILTER) return !job.folderId;
  return job.folderId === folderId;
}

/**
 * What a search box should look through.
 *
 * The camera number and the seed are in here deliberately: they are how an artist
 * actually refers to one of these ("the 0012 take", "reproduce 184992"), and the
 * seed appears nowhere else searchable. The job id is included for support, who get
 * given one in a bug report.
 */
function searchableText(job: Job) {
  const stillImage = job.workflowOptions?.stillImage;
  return [
    job.fileName,
    job.prompt,
    job.modelType,
    job.folderName,
    job.workflowOptions?.save?.cameraNumber,
    stillImage?.seed === undefined ? undefined : String(stillImage.seed),
    stillImage?.settings?.mode === undefined ? undefined : String(stillImage.settings.mode),
    job.id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sortStillImageJobs(jobs: Job[], sort: StillImageResultSort) {
  const sorted = [...jobs];
  if (sort === "cost") {
    // Uncosted runs sink rather than being dropped or read as free: most runs are
    // uncosted until a pod has a per-second price configured, and the point of this
    // ordering is to surface the expensive ones.
    // Dollars rather than credits: credits are rounded to whole numbers, so a third
    // of these runs tie at 6 and the order among them would be arbitrary.
    sorted.sort((a, b) => (measuredPodUsd(b) ?? -1) - (measuredPodUsd(a) ?? -1) || newestFirst(a, b));
    return sorted;
  }
  sorted.sort((a, b) => (sort === "oldest" ? -newestFirst(a, b) : newestFirst(a, b)));
  return sorted;
}

function newestFirst(a: Job, b: Job) {
  return createdTime(b) - createdTime(a);
}

function createdTime(job: Job) {
  const time = new Date(job.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}
