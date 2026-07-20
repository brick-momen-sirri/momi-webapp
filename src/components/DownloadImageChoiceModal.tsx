import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Download, FileImage, X } from "lucide-react";
import type { Job } from "../types";

export type ImageDownloadFormat = "png" | "jpg";

type DownloadImageChoiceModalProps = {
  job: Job;
  onChoose: (index: number, format: ImageDownloadFormat) => void;
  onClose: () => void;
};

export function DownloadImageChoiceModal({ job, onChoose, onClose }: DownloadImageChoiceModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const resultUrls = job.resultUrls?.length
    ? job.resultUrls
    : [job.resultUrl ?? job.thumbnailUrls?.[0] ?? job.thumbnailUrl].filter((url): url is string => Boolean(url));
  const choices = resultUrls.map((url, index) => ({
    index,
    label: `Image ${index + 1}`,
    url,
  }));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-stone-950/45 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-image-choice-title"
      onMouseDown={handleOverlayMouseDown}
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="download-image-choice-title" className="text-sm font-bold text-ink">
              Download image
            </h2>
            <p className="mt-0.5 truncate text-xs font-semibold text-stone-500">{job.modelType}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100"
            title="Close"
            aria-label="Close download choices"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div>
            {choices.length > 1 ? (
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Choose an image</p>
            ) : null}
            <div className={`grid gap-3 ${choices.length > 1 ? "sm:grid-cols-2" : ""}`}>
              {choices.map((choice) => {
                const isSelected = selectedIndex === choice.index;
                return (
                  <button
                    key={`${choice.url}:${choice.index}`}
                    type="button"
                    onClick={() => setSelectedIndex(choice.index)}
                    aria-pressed={isSelected}
                    className={`group relative overflow-hidden rounded-lg border bg-white text-left shadow-card transition focus:outline-none focus:ring-2 focus:ring-accent/30 ${
                      isSelected ? "border-accent ring-1 ring-accent/20" : "border-line hover:border-stone-400"
                    }`}
                  >
                    <div className={`${choices.length > 1 ? "aspect-square" : "aspect-video"} bg-stone-100`}>
                      <img
                        src={choice.url}
                        alt={choice.label}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-contain transition group-hover:scale-[1.01]"
                        draggable={false}
                      />
                    </div>
                    {choices.length > 1 ? (
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="text-sm font-bold text-ink">{choice.label}</span>
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-full ${
                            isSelected ? "bg-accent text-white" : "border border-line text-transparent"
                          }`}
                          aria-hidden="true"
                        >
                          <Check className="h-3 w-3" />
                        </span>
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Choose file format</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <FormatButton
                format="PNG"
                description="Lossless quality and transparency"
                onClick={() => onChoose(selectedIndex, "png")}
              />
              <FormatButton
                format="JPG"
                description="100% quality · transparency becomes white"
                onClick={() => onChoose(selectedIndex, "jpg")}
              />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FormatButton({ format, description, onClick }: { format: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border border-line px-3 py-3 text-left transition hover:border-accent hover:bg-cyan-50/50 focus:outline-none focus:ring-2 focus:ring-accent/30"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-600">
        <FileImage className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink">{format}</span>
        <span className="block text-xs font-medium text-stone-500">{description}</span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-accent" />
    </button>
  );
}
