import { useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import type { Job } from "../types";

type DownloadImageChoiceModalProps = {
  job: Job;
  onChoose: (index: number) => void;
  onClose: () => void;
};

export function DownloadImageChoiceModal({ job, onChoose, onClose }: DownloadImageChoiceModalProps) {
  const choices = (job.resultUrls ?? []).slice(0, 2).map((url, index) => ({
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
              Choose image to download
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

        <div className="grid gap-3 p-4 sm:grid-cols-2">
          {choices.map((choice) => (
            <button
              key={`${choice.url}:${choice.index}`}
              type="button"
              onClick={() => onChoose(choice.index)}
              className="group overflow-hidden rounded-lg border border-line bg-white text-left shadow-card transition hover:border-accent hover:shadow-2xl focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              <div className="aspect-square bg-stone-100">
                <img
                  src={choice.url}
                  alt={choice.label}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-contain transition group-hover:scale-[1.02]"
                  draggable={false}
                />
              </div>
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-sm font-bold text-ink">Download {choice.label}</span>
                <Download className="h-4 w-4 shrink-0 text-accent" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
