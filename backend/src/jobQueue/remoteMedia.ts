import type { Job } from "../types.js";

export type RemoteMediaEntry = {
  kind: "result" | "thumbnail";
  index: number;
  url: string;
};

// Completed media is expected to be copied behind /api/media. A remote URL
// identifies an artifact that still needs recovery before its signed URL dies.
export function isRemoteResultMediaUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

export function jobRemoteMediaEntries(job: Pick<Job, "status" | "resultUrls" | "thumbnailUrls">): RemoteMediaEntry[] {
  if (job.status !== "completed") return [];
  const entries: RemoteMediaEntry[] = [];
  (job.resultUrls ?? []).forEach((url, index) => {
    if (isRemoteResultMediaUrl(url)) entries.push({ kind: "result", index, url });
  });
  (job.thumbnailUrls ?? []).forEach((url, index) => {
    if (isRemoteResultMediaUrl(url)) entries.push({ kind: "thumbnail", index, url });
  });
  return entries;
}
