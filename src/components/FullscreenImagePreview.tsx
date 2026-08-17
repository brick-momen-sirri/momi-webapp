import { ChevronsLeftRight, Download, Loader2, ScanSearch, X } from "lucide-react";
import { useEffect, useState } from "react";

import { ImageCompareSlider } from "./ImageCompareSlider";

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
  /**
   * The full-resolution original, for pixel-level checks that the rendition
   * cannot answer. Loaded only when the viewer explicitly asks -- see the
   * button below.
   */
  originalUrl?: string;
  /**
   * The input this result was made from, as a rendition. Enables the compare
   * mode below; callers with nothing meaningful to compare against (or more than
   * one candidate) leave it out and the control does not appear.
   */
  beforeUrl?: string;
};

export function FullscreenImagePreview({ image, onClose }: { image: FullscreenImage; onClose: () => void }) {
  // Opt-in, and one-way for the life of the overlay: this is the one path that
  // pulls the full original, so it must never happen because a component
  // re-rendered or a viewer moved the mouse.
  const [wantsOriginal, setWantsOriginal] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  // Two separate modes rather than one combined view. Comparing is a question
  // about renditions -- did this pass do what I wanted -- and full resolution is
  // a question about pixels. Stacking the original inside a clipped comparison
  // would also lose the thing the stack exists for: keeping something on screen
  // while a 100 MB file arrives.
  const [comparing, setComparing] = useState(false);

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
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {image.beforeUrl ? (
          <button
            type="button"
            onClick={() => setComparing((value) => !value)}
            aria-pressed={comparing}
            className="flex h-10 items-center gap-2 rounded-md bg-white/90 px-3 text-sm font-bold text-ink shadow-card transition hover:bg-white"
            title="Compare this result against the image it was made from"
          >
            <ChevronsLeftRight className="h-4 w-4" />
            {comparing ? "Exit compare" : "Compare"}
          </button>
        ) : null}
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

      <div className="relative flex max-h-full max-w-full items-center justify-center" onClick={(event) => event.stopPropagation()}>
        {comparing && image.beforeUrl ? (
          <div className="w-[min(96vw,1600px)]">
            <ImageCompareSlider
              beforeImage={image.beforeUrl}
              afterImage={image.previewUrl}
              beforeLabel="Input"
              afterLabel="Result"
              maxHeight="80vh"
              defaultMode="compare"
            />
          </div>
        ) : (
          <img src={image.previewUrl} alt={image.name} decoding="async" className="max-h-full max-w-full object-contain" draggable={false} />
        )}
        {/* Stacked over the preview rather than replacing it, so the rendition
            stays on screen for however long a 100 MB original takes to arrive
            instead of the viewer staring at an empty frame. */}
        {!comparing && wantsOriginal && image.originalUrl ? (
          <img
            src={image.originalUrl}
            alt={image.name}
            decoding="async"
            className={`absolute inset-0 h-full w-full object-contain transition-opacity ${originalLoaded ? "opacity-100" : "opacity-0"}`}
            draggable={false}
            onLoad={() => setOriginalLoaded(true)}
            onError={() => setOriginalFailed(true)}
          />
        ) : null}
      </div>

      {/* Hidden while comparing: the control belongs to the other mode, and the
          slider's own hint row sits where it would. Any original already loaded
          is still there on the way back. */}
      {image.originalUrl && !comparing ? (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2" onClick={(event) => event.stopPropagation()}>
          {!wantsOriginal ? (
            <button
              type="button"
              onClick={() => setWantsOriginal(true)}
              className="flex h-10 items-center gap-2 rounded-md bg-white/90 px-3 text-sm font-bold text-ink shadow-card transition hover:bg-white"
              title="Load the original at full resolution. This downloads the whole file."
            >
              <ScanSearch className="h-4 w-4" />
              View full resolution
            </button>
          ) : (
            <span className="flex h-10 items-center gap-2 rounded-md bg-white/90 px-3 text-sm font-bold text-ink shadow-card">
              {originalFailed ? (
                "Could not load the original -- showing the preview"
              ) : originalLoaded ? (
                "Full resolution"
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading full resolution...
                </>
              )}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
