import { AlertTriangle, ExternalLink, Maximize2, PlayCircle } from "lucide-react";
import { type DragEvent, useState } from "react";
import type { Job } from "../types";
import { backendResultFileUrl, playableVideoUrl, THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../services/backendApi";
import { useNearViewport } from "../features/jobs/useNearViewport";
import { setResultImageDragData } from "../utils/resultDrag";
import { FullscreenImagePreview, type FullscreenImage } from "./FullscreenImagePreview";
import { ImageCompareSlider } from "./ImageCompareSlider";
import { JobProgress } from "./JobProgress";
import { ResultOverlayActions, ResultOverlayButton } from "./ResultOverlayActions";

type JobPreviewProps = {
  job: Job;
};

export function JobPreview({ job }: JobPreviewProps) {
  const [previewRef, shouldLoadMedia] = useNearViewport<HTMLDivElement>();
  const [fullscreenImage, setFullscreenImage] = useState<FullscreenImage | null>(null);

  /**
   * The overlay shows a preview rendition; only the Download action reaches for
   * the original. `resultIndex` maps to the backend's ?index=, so a two-image job
   * downloads the image the user actually opened.
   */
  function openFullscreen(url: string, name: string, resultIndex: number) {
    setFullscreenImage({
      previewUrl: thumbnailMediaUrl(url, THUMBNAIL_WIDTH.fullscreen),
      name,
      downloadUrl: backendResultFileUrl(job.id, resultIndex),
      // Un-downscaled, for the "View full resolution" button only. Nothing loads
      // this unless the viewer asks for it.
      originalUrl: url,
    });
  }

  if (job.status === "failed") {
    return (
      <div
        ref={previewRef}
        className="flex min-h-[260px] w-full items-center justify-center rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 sm:min-h-[360px]"
      >
        <div className="w-full max-w-3xl text-center">
          <AlertTriangle className="mx-auto h-6 w-6" />
          <p className="mt-2 text-sm font-semibold">Generation failed</p>
          {job.errorMessage ? (
            <p className="mx-auto mt-3 max-h-28 overflow-auto rounded-md border border-red-200 bg-white/80 px-3 py-2 text-left text-xs font-medium leading-5 text-red-800">
              {job.errorMessage}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (job.status === "queued" || job.status === "sending" || job.status === "running") {
    return (
      <div
        ref={previewRef}
        className="flex min-h-[260px] w-full items-center justify-center rounded-lg border border-line bg-stone-100 sm:min-h-[360px]"
      >
        {/* This used to be a bar pinned at 25/50/66% by status -- a number that
            looked measured and never was. It now reports the phase the job is
            actually in, and how long it has been there. */}
        <div className="w-full max-w-sm px-6">
          <JobProgress job={job} />
        </div>
      </div>
    );
  }

  const result = job.resultUrls?.[0] ?? job.resultUrl ?? job.thumbnailUrls?.[0] ?? job.thumbnailUrl;
  const videoPoster = getVideoPoster(job);
  const isVideoOutput =
    job.outputType === "video" || (result ? isVideoUrl(result) : false) || (job.videoLength ? !job.outputType : false);
  const isSequenceOutput = job.outputType === "sequence";
  const isImageOutput = !isVideoOutput && !isSequenceOutput;
  const imageResults = isImageOutput ? (job.resultUrls?.length ? job.resultUrls : result ? [result] : []) : [];
  const resultName = result ? resultFileName(job, result, 0) : "result-image";
  const canDragResultImage = Boolean(result && (isImageOutput || isSequenceOutput || isGifMedia(result, job.fileName)));
  const canFullscreenResultImage = canDragResultImage;

  function handleResultDragStart(event: DragEvent<HTMLElement>, url = result, index = 0) {
    if (!url || !canDragResultImage) {
      return;
    }

    setResultImageDragData(event.dataTransfer, {
      url,
      name: resultFileName(job, url, index),
      jobId: job.id,
      modelType: job.modelType,
    });
  }

  if (!shouldLoadMedia) {
    return (
      <div ref={previewRef} className="relative aspect-video w-full overflow-hidden rounded-lg border border-line bg-stone-100">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-stone-500 shadow-card">Media preview</span>
        </div>
      </div>
    );
  }

  if (job.status === "completed" && isImageOutput && imageResults.length <= 1 && result) {
    return (
      <div ref={previewRef} className="relative">
        {/* Preview renditions, not originals: the fullscreen button and the drag
            payload below both still carry the full-resolution result. */}
        <ImageCompareSlider
          beforeImage={thumbnailMediaUrl(job.inputImages[0], THUMBNAIL_WIDTH.preview)}
          afterImage={thumbnailMediaUrl(result, THUMBNAIL_WIDTH.preview)}
          onResultDragStart={(event) => handleResultDragStart(event, result, 0)}
        />
        <FullscreenImageButton onClick={() => openFullscreen(result, resultName, 0)} />
        {fullscreenImage ? <FullscreenImagePreview image={fullscreenImage} onClose={() => setFullscreenImage(null)} /> : null}
      </div>
    );
  }

  if (job.status === "completed" && isImageOutput && imageResults.length > 1) {
    return (
      <div ref={previewRef} className="relative">
        <div className="grid gap-2 md:grid-cols-2">
          {imageResults.map((url, index) => {
            const name = resultFileName(job, url, index);
            return (
              <div
                key={`${url}:${index}`}
                className="relative aspect-square overflow-hidden rounded-lg border border-line bg-stone-100"
              >
                <img
                  src={thumbnailMediaUrl(url, THUMBNAIL_WIDTH.grid)}
                  alt={name}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-contain"
                  draggable={canDragResultImage}
                  onDragStart={(event) => handleResultDragStart(event, url, index)}
                />
                <span className="absolute bottom-2 left-2 rounded-md bg-white/90 px-2 py-1 text-xs font-bold text-ink shadow-card">
                  {index + 1}
                </span>
                <FullscreenImageButton onClick={() => openFullscreen(url, name, index)} />
              </div>
            );
          })}
        </div>
        {fullscreenImage ? <FullscreenImagePreview image={fullscreenImage} onClose={() => setFullscreenImage(null)} /> : null}
      </div>
    );
  }

  return (
    <div ref={previewRef} className="relative aspect-video w-full overflow-hidden rounded-lg bg-stone-100">
      {result && isImageOutput ? (
        <img
          src={thumbnailMediaUrl(result, THUMBNAIL_WIDTH.preview)}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
          draggable={canDragResultImage}
          onDragStart={(event) => handleResultDragStart(event, result, 0)}
        />
      ) : null}
      {result && isVideoOutput && isGifMedia(result, job.fileName) ? (
        <img
          src={result}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
          draggable={canDragResultImage}
          onDragStart={(event) => handleResultDragStart(event, result, 0)}
        />
      ) : null}
      {result && isVideoOutput && !isGifMedia(result, job.fileName) ? (
        <video
          // Not the raw result: some providers return codecs this element cannot
          // decode (4K comes back as HEVC 10-bit), which showed up as a dead
          // player for most viewers. The backend serves an H.264 copy for those
          // and the original bytes for everything else. Downloads still get the
          // master — see backendResultFileUrl.
          // The frame hint goes on last: it is a fragment, and the rewrite above
          // rebuilds the URL from its path and query alone.
          src={withFirstFrameHint(playableVideoUrl(result))}
          // No image poster exists for video-only jobs, so fall back to the
          // video itself — the backend extracts a frame for it.
          poster={thumbnailMediaUrl(videoPoster ?? result, THUMBNAIL_WIDTH.preview) ?? undefined}
          className="h-full w-full object-contain"
          controls
          preload="auto"
        />
      ) : null}
      {result && isSequenceOutput ? (
        <img
          src={thumbnailMediaUrl(result, THUMBNAIL_WIDTH.preview)}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
          draggable={canDragResultImage}
          onDragStart={(event) => handleResultDragStart(event, result, 0)}
        />
      ) : null}
      {job.videoLength && !isVideoOutput ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
          <span className="pointer-events-none flex items-center gap-2 rounded-full bg-white/90 px-3 py-2 text-sm font-semibold text-ink shadow-card backdrop-blur">
            <PlayCircle className="h-5 w-5 text-ember" />
            {job.videoLength}
          </span>
        </div>
      ) : null}
      {result && isVideoOutput ? (
        <a
          // Opening the raw file here lands on the browser's own player, which is
          // the codec problem again with no UI of ours in the way. Same rendition
          // the inline player uses; Download still hands over the master.
          href={playableVideoUrl(result)}
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-xs font-bold text-ink shadow-card transition hover:bg-white"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open media
        </a>
      ) : null}
      {result && canFullscreenResultImage ? (
        <FullscreenImageButton onClick={() => openFullscreen(result, resultName, 0)} />
      ) : null}
      {fullscreenImage ? <FullscreenImagePreview image={fullscreenImage} onClose={() => setFullscreenImage(null)} /> : null}
    </div>
  );
}

function FullscreenImageButton({ onClick }: { onClick: () => void }) {
  return (
    <ResultOverlayActions>
      <ResultOverlayButton icon={<Maximize2 className="h-4 w-4" />} label="Preview image fullscreen" onClick={onClick} />
    </ResultOverlayActions>
  );
}

function getVideoPoster(job: Job) {
  const thumbnail = [...(job.thumbnailUrls ?? []), job.thumbnailUrl]
    .filter((url): url is string => Boolean(url))
    .find((url) => isImageUrl(url));
  if (thumbnail) return thumbnail;

  return job.inputImages.find((url) => isImageUrl(url));
}

function isImageUrl(url: string) {
  const lower = url.split("?")[0].toLowerCase();
  return /\.(avif|gif|jpe?g|png|webp|tiff?)$/.test(lower) || url.startsWith("data:image/");
}

function isVideoUrl(url: string) {
  const lower = url.split("?")[0].toLowerCase();
  return /\.(avi|gif|m4v|mkv|mov|mp4|webm)$/.test(lower) || url.startsWith("data:video/");
}

function isGifMedia(url: string, filename?: string) {
  return url.split("?")[0].toLowerCase().endsWith(".gif") || filename?.toLowerCase().endsWith(".gif");
}

function withFirstFrameHint(url: string) {
  if (url.includes("#t=")) return url;
  return `${url}#t=0.001`;
}

function resultFileName(job: Job, url: string, index = 0) {
  if (job.fileName && index === 0) return job.fileName;
  try {
    const pathName = new URL(url, window.location.href).pathname;
    const fileName = decodeURIComponent(pathName.split("/").filter(Boolean).pop() ?? "");
    if (fileName) return fileName;
  } catch {
    // Fall back to a readable generated name below.
  }
  return `${job.modelType || "result"}-${job.id}`.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "result-image";
}
