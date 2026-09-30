import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  enhancedDimensions,
  VIDEO_ENHANCER_LONG_SIDES,
  VIDEO_ENHANCER_MAX_FRAMES,
  videoEnhancerTimeLabel,
  type VideoEnhancerLongSide,
} from "../features/generation/videoEnhancer";
import type { UploadedVideo } from "../types";
import { cn } from "../utils/classNames";

type VideoEnhancerControlsProps = {
  value: VideoEnhancerLongSide;
  onChange: (longSide: VideoEnhancerLongSide) => void;
  video?: UploadedVideo;
};

const LONG_SIDE_HINTS: Record<VideoEnhancerLongSide, string> = {
  1280: "720p class",
  1920: "1080p class",
  2560: "1440p",
};

/**
 * The Video Enhancer's one setting, and what it will do to the chosen clip.
 *
 * The size shown is a preview from the browser's own read of the file; the
 * backend probes the source again at dispatch and its plan is the one that runs.
 */
export function VideoEnhancerControls({ value, onChange, video }: VideoEnhancerControlsProps) {
  const source = useVideoDimensions(video?.url);
  const output = source ? enhancedDimensions(source.width, source.height, value) : undefined;

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Enhanced size</h2>
        </div>
        <span className="text-sm font-bold text-ink">{output ? `${output.width} × ${output.height}` : `${value} px`}</span>
      </div>

      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Enhanced long side">
        {VIDEO_ENHANCER_LONG_SIDES.map((longSide) => {
          const selected = longSide === value;
          return (
            <label
              key={longSide}
              className={cn(
                "flex cursor-pointer flex-col rounded-md border px-2 py-2 text-center transition",
                selected
                  ? "border-accent bg-accent text-white shadow-card"
                  : "border-line bg-white text-stone-700 hover:border-accent hover:bg-mist",
              )}
            >
              <input
                className="sr-only"
                type="radio"
                name="video-enhancer-long-side"
                value={longSide}
                checked={selected}
                onChange={() => onChange(longSide)}
              />
              <span className="text-xs font-bold">{longSide}</span>
              <span className={cn("mt-0.5 truncate text-[11px]", selected ? "text-white/75" : "text-stone-500")}>
                {LONG_SIDE_HINTS[longSide]}
              </span>
            </label>
          );
        })}
      </div>

      <p className="mt-3 text-xs leading-5 text-stone-600">
        Long side in pixels{source ? ` (source ${source.width} × ${source.height})` : ""}. Enhances the first{" "}
        {VIDEO_ENHANCER_MAX_FRAMES} frames, about 5 s of a 24 fps clip, and keeps the source frame rate and audio. Render time{" "}
        {videoEnhancerTimeLabel(value, source?.width, source?.height)}.
      </p>
      <p className="mt-1 text-[11px] leading-4 text-stone-500">
        Generative enhancement: fine texture and colour can shift from the source.
      </p>
    </section>
  );
}

/** The chosen video's display size, read from its metadata alone. */
function useVideoDimensions(url: string | undefined) {
  const [dimensions, setDimensions] = useState<{ url: string; width: number; height: number }>();

  useEffect(() => {
    if (!url) return undefined;
    const element = document.createElement("video");
    element.preload = "metadata";
    element.muted = true;
    const handleMetadata = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) {
        setDimensions({ url, width: element.videoWidth, height: element.videoHeight });
      }
    };
    element.addEventListener("loadedmetadata", handleMetadata);
    element.src = url;
    return () => {
      element.removeEventListener("loadedmetadata", handleMetadata);
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);

  return dimensions && dimensions.url === url ? dimensions : undefined;
}
