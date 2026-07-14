import { AlertTriangle, ExternalLink, Loader2, Maximize2, PlayCircle, X } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import type { Job } from "../types";
import { setResultImageDragData } from "../utils/resultDrag";
import { ImageCompareSlider } from "./ImageCompareSlider";

type JobPreviewProps = {
  job: Job;
};

export function JobPreview({ job }: JobPreviewProps) {
  const [shouldLoadMedia, setShouldLoadMedia] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState<{ url: string; name: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = previewRef.current;

    if (!node) {
      return;
    }

    if (!("IntersectionObserver" in window)) {
      setShouldLoadMedia(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoadMedia(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (job.status === "failed") {
    return (
      <div ref={previewRef} className="flex min-h-[260px] w-full items-center justify-center rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 sm:min-h-[360px]">
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
      <div ref={previewRef} className="flex min-h-[260px] w-full items-center justify-center rounded-lg border border-line bg-stone-100 sm:min-h-[360px]">
        <div className="w-full max-w-sm px-6 text-center">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-accent" />
          <p className="mt-3 text-sm font-semibold capitalize">{job.status}</p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
            <div className={`h-full rounded-full bg-accent ${job.status === "queued" ? "w-1/4" : job.status === "sending" ? "w-1/2" : "w-2/3"}`} />
          </div>
        </div>
      </div>
    );
  }

  const result = job.resultUrls?.[0] ?? job.resultUrl ?? job.thumbnailUrls?.[0] ?? job.thumbnailUrl;
  const videoPoster = getVideoPoster(job);
  const isVideoOutput =
    job.outputType === "video" ||
    (result ? isVideoUrl(result) : false) ||
    (job.videoLength ? !job.outputType : false);
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
          <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-stone-500 shadow-card">
            Media preview
          </span>
        </div>
      </div>
    );
  }

  if (job.status === "completed" && isImageOutput && imageResults.length <= 1 && result) {
    return (
      <div ref={previewRef} className="relative">
        <ImageCompareSlider beforeImage={job.inputImages[0]} afterImage={result} onResultDragStart={(event) => handleResultDragStart(event, result, 0)} />
        <FullscreenImageButton onClick={() => setFullscreenImage({ url: result, name: resultName })} />
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
              <div key={`${url}:${index}`} className="relative aspect-square overflow-hidden rounded-lg border border-line bg-stone-100">
                <img
                  src={url}
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
                <FullscreenImageButton onClick={() => setFullscreenImage({ url, name })} />
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
          src={result}
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
          src={withFirstFrameHint(result)}
          poster={videoPoster ?? undefined}
          className="h-full w-full object-contain"
          controls
          preload="auto"
        />
      ) : null}
      {result && isSequenceOutput ? (
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
          href={result}
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-xs font-bold text-ink shadow-card transition hover:bg-white"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open media
        </a>
      ) : null}
      {result && canFullscreenResultImage ? (
        <FullscreenImageButton onClick={() => setFullscreenImage({ url: result, name: resultName })} />
      ) : null}
      {fullscreenImage ? <FullscreenImagePreview image={fullscreenImage} onClose={() => setFullscreenImage(null)} /> : null}
    </div>
  );
}

function FullscreenImageButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-white/90 text-ink shadow-card transition hover:bg-white"
      title="Preview image fullscreen"
      aria-label="Preview image fullscreen"
    >
      <Maximize2 className="h-4 w-4" />
    </button>
  );
}

function FullscreenImagePreview({
  image,
  onClose,
}: {
  image: { url: string; name: string };
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-stone-950/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen image preview"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-md bg-white/90 text-ink shadow-card transition hover:bg-white"
        title="Close fullscreen preview"
        aria-label="Close fullscreen preview"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={image.url}
        alt={image.name}
        className="max-h-full max-w-full object-contain"
        draggable={false}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
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
