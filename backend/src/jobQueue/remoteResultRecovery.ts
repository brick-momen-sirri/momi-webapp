import path from "node:path";

import { runpodOutputMaxBytes } from "../config.js";
import { isDispatcher } from "../processRole.js";
import { getProject } from "../projectService.js";
import { ensureJobFolders } from "../storageService.js";
import { responseBodyToNodeStream, writeStreamAtomically } from "../streamingMediaService.js";
import type { Job } from "../types.js";
import { jobRemoteMediaEntries, type RemoteMediaEntry } from "./remoteMedia.js";

type RemoteResultRecoveryOptions = {
  jobs: () => Job[];
  persistJob: (job: Job) => Promise<void>;
};

export class RemoteResultRecovery {
  private readonly failureCounts = new Map<string, number>();
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RemoteResultRecoveryOptions) {}

  schedule(delayMs = 60_000) {
    if (!isDispatcher() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recover().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  async recover(fetchImpl: typeof fetch = fetch) {
    if (!isDispatcher() || this.running) return { recovered: 0, failed: 0 };
    this.running = true;
    try {
      let recovered = 0;
      let failed = 0;
      const changedJobs = new Set<Job>();

      for (const job of this.options.jobs()) {
        const entries = jobRemoteMediaEntries(job);
        if (!entries.length) continue;
        const project = getProject(job.projectId);
        if (!project) continue;
        const folders = await ensureJobFolders(project, job.id).catch(() => undefined);
        if (!folders) continue;

        const recoveredByUrl = new Map<string, string>();
        for (const entry of entries) {
          let localUrl = recoveredByUrl.get(entry.url);
          if (!localUrl) {
            const attempts = this.failureCounts.get(entry.url) ?? 0;
            if (attempts >= 24) continue;
            localUrl = await downloadRemoteResultMedia(entry, folders.output, job.id, fetchImpl);
            if (!localUrl) {
              this.failureCounts.set(entry.url, attempts + 1);
              failed += 1;
              continue;
            }
            this.failureCounts.delete(entry.url);
            recoveredByUrl.set(entry.url, localUrl);
          }

          if (entry.kind === "result") job.resultUrls[entry.index] = localUrl;
          else job.thumbnailUrls[entry.index] = localUrl;
          recovered += 1;
          changedJobs.add(job);
        }
      }

      for (const job of changedJobs) await this.options.persistJob(job);
      if (recovered || failed) console.info(`[recovery] Remote result media pass: recovered ${recovered}, failed ${failed}.`);
      return { recovered, failed };
    } finally {
      this.running = false;
    }
  }
}

export function resultExtension(url: URL, contentType: string) {
  const filename = url.searchParams.get("filename") || path.basename(url.pathname);
  const extension = path.extname(filename);
  if (extension) return extension;
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/gif")) return ".gif";
  if (contentType.includes("video/mp4")) return ".mp4";
  if (contentType.includes("video/quicktime")) return ".mov";
  if (contentType.includes("video/webm")) return ".webm";
  return ".bin";
}

async function downloadRemoteResultMedia(entry: RemoteMediaEntry, outputFolder: string, jobId: string, fetchImpl: typeof fetch) {
  try {
    const url = new URL(entry.url);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    const extension = resultExtension(url, contentType);
    const fileName = `${jobId}_${entry.kind}_${String(entry.index + 1).padStart(2, "0")}_recovered${extension}`;
    const filePath = path.join(outputFolder, fileName);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > runpodOutputMaxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    await writeStreamAtomically(responseBodyToNodeStream(response), filePath, runpodOutputMaxBytes);
    return `/api/media?path=${encodeURIComponent(filePath)}`;
  } catch {
    return undefined;
  }
}
