import { Download, X } from "lucide-react";
import { useEffect } from "react";

export type FullscreenImage = {
  /**
   * What to display. Callers pass a downscaled preview rendition, never the
   * original: a 4K-10K PNG result is 50-100+ MB on the wire and several hundred
   * MB once the browser has decoded it to a bitmap, and neither buys a single
   * visible pixel at screen size.
   */
  previewUrl: string;
  name: string;
  /** Streams the untouched original as an attachment, when one is available. */
  downloadUrl?: string;
};

export function FullscreenImagePreview({ image, onClose }: { image: FullscreenImage; onClose: () => void }) {
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
      <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {image.downloadUrl ? (
          <a
            href={image.downloadUrl}
            download
            className="flex h-10 items-center gap-2 rounded-md bg-white/90 px-3 text-sm font-bold text-ink shadow-card transition hover:bg-white"
            title="Download the full-resolution original"
          >
            <Download className="h-4 w-4" />
            Original
          </a>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-md bg-white/90 text-ink shadow-card transition hover:bg-white"
          title="Close fullscreen preview"
          aria-label="Close fullscreen preview"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <img
        src={image.previewUrl}
        alt={image.name}
        decoding="async"
        className="max-h-full max-w-full object-contain"
        draggable={false}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
