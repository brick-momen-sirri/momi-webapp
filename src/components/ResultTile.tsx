// One result as a contact-sheet tile, for the grid layout in either section.
//
// The rendition, never the original: scrolling a grid of fifty must cost fifty
// small requests. Still image results routinely pass 100 MB, and an Animation
// result can be a 4K video -- neither belongs in a 300px box.
//
// Video results show their poster frame rather than a player. Fifty <video>
// elements decoding at once is what the list layout already avoids by loading only
// what is near the viewport, and a contact sheet is meant to be scanned, not
// watched.

import { Film, Hash, ImageIcon, Loader2, TriangleAlert } from "lucide-react";
import { THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../services/backendApi";
import type { Job } from "../types";
import { resultCardElementId } from "../utils/resultCard";
import { JobStatusBadge } from "./ResultViewControls";

type ResultTileProps = {
  job: Job;
  /** Shown under the thumbnail. The preset or model that produced the result. */
  label: string;
  /** Small chip after the label, normally the shot or camera number. */
  chip?: string;
  onOpen: (job: Job) => void;
};

export function ResultTile({ job, label, chip, onOpen }: ResultTileProps) {
  // A video's poster is its thumbnail; an image's is the result itself, downscaled.
  const isVideo = job.outputType === "video" || job.outputType === "sequence";
  const previewSource = isVideo ? job.thumbnailUrl : (job.resultUrl ?? job.thumbnailUrl);
  const preview = job.status === "completed" ? thumbnailMediaUrl(previewSource, THUMBNAIL_WIDTH.grid) : undefined;

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-white shadow-card">
      <button
        type="button"
        onClick={() => onOpen(job)}
        // Labelled explicitly: the tile's only content is the result image, whose
        // alt text is a filename, so without this the control announces itself as
        // "20260814_pro-upscaler_1234_cam-12_v001.png".
        aria-label="Show this result in the full card"
        title="Show this result in the full card"
        aria-controls={resultCardElementId(job.id)}
        className="block aspect-[4/3] w-full overflow-hidden bg-stone-100"
      >
        {preview ? (
          <span className="relative block h-full w-full">
            <img
              src={preview}
              alt={job.fileName ?? `${label} result`}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
            {isVideo ? (
              <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                <Film className="h-2.5 w-2.5" />
                Video
              </span>
            ) : null}
          </span>
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-stone-400">
            {isJobWorking(job.status) ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : job.status === "failed" || job.status === "canceled" ? (
              <TriangleAlert className="h-5 w-5" />
            ) : (
              <ImageIcon className="h-5 w-5" />
            )}
            <span className="px-2 text-center text-xs font-semibold">{tilePlaceholder(job.status)}</span>
          </span>
        )}
      </button>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line p-2">
        <JobStatusBadge status={job.status} />
        <span className="truncate text-xs font-bold">{label}</span>
        {chip ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700">
            <Hash className="h-2.5 w-2.5" />
            {chip}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function isJobWorking(status: Job["status"]) {
  return status === "queued" || status === "sending" || status === "running";
}

function tilePlaceholder(status: Job["status"]) {
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  if (status === "running" || status === "sending") return "Rendering";
  if (status === "queued") return "Queued";
  return "No preview";
}
