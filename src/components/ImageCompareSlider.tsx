import { ChevronsLeftRight } from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type ImageCompareSliderProps = {
  beforeImage?: string;
  afterImage: string;
  beforeLabel?: string;
  afterLabel?: string;
  onResultDragStart?: (event: DragEvent<HTMLImageElement>) => void;
};

type ViewerMode = "result" | "compare";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable ||
    target.closest("[contenteditable='true']")
  );
}

export function ImageCompareSlider({
  beforeImage,
  afterImage,
  beforeLabel = "Before",
  afterLabel = "Result",
  onResultDragStart,
}: ImageCompareSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isViewerHoveredRef = useRef(false);
  const isZPressedRef = useRef(false);
  const noticeTimeoutRef = useRef<number | null>(null);
  const [mode, setMode] = useState<ViewerMode>("result");
  const [position, setPosition] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [aspectRatio, setAspectRatio] = useState("16 / 9");
  const [notice, setNotice] = useState<string | null>(null);
  const [isViewerHovered, setIsViewerHovered] = useState(false);
  const [isZPressed, setIsZPressed] = useState(false);

  const canCompare = Boolean(beforeImage);
  const isZoomMode = isViewerHovered && isZPressed;

  useEffect(() => {
    return () => {
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const isViewerActive = () => {
      const container = containerRef.current;
      return Boolean(
        container &&
          (isViewerHoveredRef.current ||
            (document.activeElement instanceof HTMLElement && container.contains(document.activeElement))),
      );
    };

    const showNotice = (message: string) => {
      setNotice(message);

      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }

      noticeTimeoutRef.current = window.setTimeout(() => {
        setNotice(null);
      }, 2200);
    };

    const setZPressed = (nextValue: boolean) => {
      isZPressedRef.current = nextValue;
      setIsZPressed(nextValue);
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (key === "z") {
        if (!event.repeat && !isTypingTarget(event.target)) {
          setZPressed(true);
        }
        return;
      }

      if (event.repeat || isTypingTarget(event.target) || !isViewerActive()) {
        return;
      }

      if (key === "c") {
        event.preventDefault();

        if (!canCompare) {
          showNotice("Comparison is unavailable for this result.");
          return;
        }

        setMode((value) => (value === "compare" ? "result" : "compare"));
        return;
      }

      if (key === "r") {
        event.preventDefault();
        setZoom(1);
        return;
      }

    };

    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === "z") {
        setZPressed(false);
      }
    };

    const handleBlur = () => {
      setZPressed(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      isZPressedRef.current = false;
    };
  }, [canCompare]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (!isViewerHoveredRef.current || !isZPressedRef.current || isTypingTarget(document.activeElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const direction = event.deltaY < 0 ? 1 : -1;
      const zoomStep = direction > 0 ? 1.12 : 1 / 1.12;
      setZoom((value) => clamp(Number((value * zoomStep).toFixed(3)), 1, 5));
    };

    node.addEventListener("wheel", handleNativeWheel, { passive: false });

    return () => {
      node.removeEventListener("wheel", handleNativeWheel);
    };
  }, []);

  const updatePosition = (clientX: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const nextPosition = ((clientX - bounds.left) / bounds.width) * 100;
    setPosition(clamp(nextPosition, 0, 100));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus({ preventScroll: true });

    if (mode !== "compare" || !canCompare) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    updatePosition(event.clientX);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (mode !== "compare" || !canCompare || event.buttons !== 1) {
      return;
    }

    updatePosition(event.clientX);
  };

  const handlePointerEnter = () => {
    isViewerHoveredRef.current = true;
    setIsViewerHovered(true);
  };

  const handlePointerLeave = () => {
    isViewerHoveredRef.current = false;
    setIsViewerHovered(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "compare") {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPosition((value) => clamp(value - 4, 0, 100));
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setPosition((value) => clamp(value + 4, 0, 100));
    }
  };

  const imageTransform = {
    transform: `scale(${zoom})`,
    transformOrigin: "center center",
  };
  const roundedZoom = Math.round(zoom * 10) / 10;

  return (
    <div>
      <div
        ref={containerRef}
        className={`relative w-full select-none overflow-hidden rounded-lg border border-line bg-stone-100 shadow-sm outline-none ring-accent/30 transition focus-visible:ring-2 ${
          isZoomMode ? "cursor-zoom-in" : mode === "compare" && canCompare ? "cursor-ew-resize" : "cursor-default"
        }`}
        style={{
          aspectRatio,
          overscrollBehavior: "contain",
          touchAction: mode === "compare" && canCompare ? "none" : "pan-y",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        role={mode === "compare" ? "slider" : "group"}
        aria-label={mode === "compare" ? "Before and result image comparison" : "Result image preview"}
        aria-valuemin={mode === "compare" ? 0 : undefined}
        aria-valuemax={mode === "compare" ? 100 : undefined}
        aria-valuenow={mode === "compare" ? Math.round(position) : undefined}
        tabIndex={0}
      >
        {mode === "compare" && beforeImage ? (
          <img
            src={beforeImage}
            alt={beforeLabel}
            className="absolute inset-0 h-full w-full object-contain transition-transform duration-75"
            draggable={false}
            style={imageTransform}
          />
        ) : null}

        <div
          className={mode === "compare" && beforeImage ? "absolute inset-0 overflow-hidden" : "absolute inset-0"}
          style={mode === "compare" && beforeImage ? { clipPath: `inset(0 0 0 ${position}%)` } : undefined}
        >
          <img
            src={afterImage}
            alt={afterLabel}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain transition-transform duration-75"
            draggable={Boolean(onResultDragStart)}
            onDragStart={onResultDragStart}
            style={imageTransform}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) {
                setAspectRatio(`${naturalWidth} / ${naturalHeight}`);
              }
            }}
          />
        </div>

        {mode === "compare" && beforeImage ? (
          <>
            <div className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[11px] font-semibold text-stone-600 shadow-sm">
              {beforeLabel}
            </div>
            <div className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[11px] font-semibold text-stone-600 shadow-sm">
              {afterLabel}
            </div>

            <div
              className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(28,25,23,0.16)]"
              style={{ left: `${position}%` }}
            />
            <div
              className="absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-white text-accent shadow-panel"
              style={{ left: `${position}%` }}
            >
              <ChevronsLeftRight className="h-4 w-4" />
            </div>
          </>
        ) : null}

        {zoom > 1 ? (
          <div className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[11px] font-semibold text-stone-600 shadow-sm">
            {roundedZoom}x
          </div>
        ) : null}

        {isZoomMode ? (
          <div className="absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-1 text-[11px] font-semibold text-stone-600 shadow-sm">
            Zoom mode
          </div>
        ) : null}

        {notice ? (
          <div className="absolute inset-x-3 bottom-3 flex justify-center">
            <span className="rounded-full bg-white/95 px-3 py-1.5 text-xs font-semibold text-stone-600 shadow-card">
              {notice}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] font-medium text-stone-400">
        {canCompare ? <span>Press C to compare</span> : null}
        <span>Hold Z + scroll to zoom</span>
        <span>Press R to reset zoom</span>
      </div>
    </div>
  );
}
