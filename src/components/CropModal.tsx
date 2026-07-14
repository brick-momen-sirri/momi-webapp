import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crop, Maximize2, Minimize2, MoveHorizontal, MoveVertical, RotateCcw, Save, Scan, X } from "lucide-react";
import type { UploadedImage } from "../types";
import { cropImageToDataUrl, isNearAspectRatio, outputSizeForResolution, type CropSettings } from "../utils/imageCrop";

const ASPECT_RATIO = 16 / 9;
const MIN_SCALE = 1;
const MAX_SCALE = 4;

type CropModalProps = {
  image: UploadedImage;
  selectedResolution: string;
  onCancel: () => void;
  onSave: (result: CropSaveResult) => void;
};

export type CropSaveResult = {
  croppedUrl?: string;
  settings?: CropSettings;
  width: number;
  height: number;
  usedOriginal: boolean;
};

type Point = {
  x: number;
  y: number;
};

export function CropModal({ image, selectedResolution, onCancel, onSave }: CropModalProps) {
  const outputSize = useMemo(() => outputSizeForResolution(selectedResolution, ASPECT_RATIO), [selectedResolution]);
  const defaultSettings = useMemo<CropSettings>(() => ({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    aspectRatio: ASPECT_RATIO,
    outputWidth: outputSize.width,
    outputHeight: outputSize.height,
  }), [outputSize.height, outputSize.width]);
  const [settings, setSettings] = useState<CropSettings>(() => normalizeSettings(image.cropSettings ?? defaultSettings));
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const previewRef = useRef<HTMLDivElement | null>(null);
  const activePointers = useRef(new Map<number, Point>());
  const lastDragPoint = useRef<Point | null>(null);
  const lastPinchDistance = useRef<number | null>(null);

  const source = image.url;
  const sourceWidth = image.width ?? outputSize.width;
  const sourceHeight = image.height ?? outputSize.height;
  const originalIsReady = isNearAspectRatio(image.width, image.height, ASPECT_RATIO);
  const willUpscale = Boolean(image.width && image.height && (image.width < outputSize.width || image.height < outputSize.height));
  const geometry = useMemo(
    () => getPreviewGeometry(frameSize, sourceWidth, sourceHeight, settings),
    [frameSize, settings, sourceHeight, sourceWidth],
  );

  useEffect(() => {
    setSettings(normalizeSettings({
      ...(image.cropSettings ?? defaultSettings),
      aspectRatio: ASPECT_RATIO,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
    }));
  }, [defaultSettings, image.cropSettings, image.id, outputSize.height, outputSize.width]);

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;

    function measure() {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setFrameSize({ width: rect.width, height: rect.height });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      const zoomFactor = event.deltaY < 0 ? 1.07 : 0.93;
      setSettings((current) => normalizeSettings({ ...current, scale: current.scale * zoomFactor }));
    }

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  async function handleSave() {
    setIsSaving(true);
    setError("");

    try {
      const savedSettings = normalizeSettings({
        ...settings,
        aspectRatio: ASPECT_RATIO,
        outputWidth: outputSize.width,
        outputHeight: outputSize.height,
      });
      const croppedUrl = await cropImageToDataUrl(source, savedSettings);
      onSave({
        croppedUrl,
        settings: savedSettings,
        width: outputSize.width,
        height: outputSize.height,
        usedOriginal: false,
      });
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : "Unable to crop this image.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleUseOriginal() {
    if (!originalIsReady) return;
    onSave({
      croppedUrl: undefined,
      settings: undefined,
      width: image.width ?? outputSize.width,
      height: image.height ?? outputSize.height,
      usedOriginal: true,
    });
  }

  function handleFill() {
    setSettings(normalizeSettings({
      ...defaultSettings,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
    }));
  }

  function handleFit() {
    if (!originalIsReady) return;
    setSettings(normalizeSettings({
      ...defaultSettings,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
    }));
  }

  function handleReset() {
    setSettings(normalizeSettings(image.cropSettings ?? defaultSettings));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    activePointers.current.set(event.pointerId, point);

    if (activePointers.current.size === 1) {
      lastDragPoint.current = point;
      lastPinchDistance.current = null;
    } else {
      lastPinchDistance.current = distanceBetweenFirstTwoPointers();
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!activePointers.current.has(event.pointerId)) return;

    const point = { x: event.clientX, y: event.clientY };
    activePointers.current.set(event.pointerId, point);

    if (activePointers.current.size >= 2) {
      const distance = distanceBetweenFirstTwoPointers();
      const previous = lastPinchDistance.current;
      if (distance && previous) {
        setSettings((current) => normalizeSettings({ ...current, scale: current.scale * (distance / previous) }));
      }
      lastPinchDistance.current = distance;
      return;
    }

    const previous = lastDragPoint.current;
    if (!previous) {
      lastDragPoint.current = point;
      return;
    }

    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    lastDragPoint.current = point;

    setSettings((current) => {
      const preview = getPreviewGeometry(frameSize, sourceWidth, sourceHeight, current);
      return normalizeSettings({
        ...current,
        offsetX: preview.maxOffsetX ? current.offsetX + dx / preview.maxOffsetX : 0,
        offsetY: preview.maxOffsetY ? current.offsetY + dy / preview.maxOffsetY : 0,
      });
    });
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    activePointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (activePointers.current.size === 1) {
      lastDragPoint.current = firstPointer();
      lastPinchDistance.current = null;
    } else if (activePointers.current.size >= 2) {
      lastPinchDistance.current = distanceBetweenFirstTwoPointers();
    } else {
      lastDragPoint.current = null;
      lastPinchDistance.current = null;
    }
  }

  function distanceBetweenFirstTwoPointers() {
    const points = Array.from(activePointers.current.values());
    if (points.length < 2) return null;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  function firstPointer() {
    return activePointers.current.values().next().value ?? null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/50 p-4 backdrop-blur-sm">
      <div className="relative z-[1010] w-full max-w-5xl rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Crop className="h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Crop to 16:9 landscape</h2>
              <p className="truncate text-xs text-stone-500">{image.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-stone-500 transition hover:bg-stone-50"
            title="Close crop tool"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="rounded-lg border border-line bg-stone-950 p-4">
            <div
              ref={previewRef}
              className="relative mx-auto aspect-video max-h-[64vh] cursor-move touch-none overflow-hidden rounded-md bg-black"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            >
              <img
                src={source}
                alt=""
                draggable={false}
                className="absolute select-none"
                style={{
                  height: `${geometry.height}px`,
                  left: `${geometry.left}px`,
                  maxHeight: "none",
                  maxWidth: "none",
                  top: `${geometry.top}px`,
                  width: `${geometry.width}px`,
                }}
              />
              <div className="pointer-events-none absolute inset-0 border-[3px] border-white/90 shadow-[inset_0_0_0_999px_rgba(0,0,0,0.12)]" />
              <div className="pointer-events-none absolute left-1/3 top-0 h-full border-l border-white/35" />
              <div className="pointer-events-none absolute left-2/3 top-0 h-full border-l border-white/35" />
              <div className="pointer-events-none absolute left-0 top-1/3 w-full border-t border-white/35" />
              <div className="pointer-events-none absolute left-0 top-2/3 w-full border-t border-white/35" />
              <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-1 text-[11px] font-semibold text-white">
                {outputSize.width} x {outputSize.height}
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
              <button
                type="button"
                onClick={handleFill}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Fill
              </button>
              <button
                type="button"
                onClick={handleFit}
                disabled={!originalIsReady}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Minimize2 className="h-3.5 w-3.5" />
                Fit
              </button>
              <button
                type="button"
                onClick={handleUseOriginal}
                disabled={!originalIsReady}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Scan className="h-3.5 w-3.5" />
                Original
              </button>
            </div>

            <div className="rounded-md border border-line bg-mist/70 p-3">
              <p className="text-xs font-semibold uppercase text-stone-500">Output</p>
              <p className="mt-1 text-sm font-semibold">{selectedResolution} - {outputSize.width} x {outputSize.height}</p>
              <p className="mt-2 text-xs text-stone-500">Original: {image.width ?? "?"} x {image.height ?? "?"}</p>
            </div>

            {originalIsReady ? (
              <div className="rounded-md border border-teal-100 bg-teal-50 px-3 py-2 text-xs leading-5 text-teal-800">
                This image is already close to 16:9 and can be used without re-cropping.
              </div>
            ) : null}

            {willUpscale ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                The saved crop is larger than the source image, so detail may be reduced.
              </div>
            ) : null}

            <Control
              icon={<Maximize2 className="h-4 w-4" />}
              label="Scale"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={0.01}
              value={settings.scale}
              onChange={(value) => setSettings((current) => normalizeSettings({ ...current, scale: value }))}
            />
            <Control
              icon={<MoveHorizontal className="h-4 w-4" />}
              label="Horizontal"
              min={-1}
              max={1}
              step={0.01}
              value={settings.offsetX}
              onChange={(value) => setSettings((current) => normalizeSettings({ ...current, offsetX: value }))}
            />
            <Control
              icon={<MoveVertical className="h-4 w-4" />}
              label="Vertical"
              min={-1}
              max={1}
              step={0.01}
              value={settings.offsetY}
              onChange={(value) => setSettings((current) => normalizeSettings({ ...current, offsetY: value }))}
            />

            {error ? <p className="text-xs text-red-600">{error}</p> : null}

            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving crop..." : "Save cropped frame"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ControlProps = {
  icon: ReactNode;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
};

function Control({ icon, label, min, max, step, value, onChange }: ControlProps) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center justify-between text-xs font-semibold text-stone-600">
        <span className="flex items-center gap-2">
          {icon}
          {label}
        </span>
        <span>{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
      />
    </label>
  );
}

function normalizeSettings(settings: CropSettings): CropSettings {
  return {
    ...settings,
    scale: clamp(settings.scale || 1, MIN_SCALE, MAX_SCALE),
    offsetX: clamp(settings.offsetX || 0, -1, 1),
    offsetY: clamp(settings.offsetY || 0, -1, 1),
    aspectRatio: ASPECT_RATIO,
  };
}

function getPreviewGeometry(
  frameSize: { width: number; height: number },
  imageWidth: number,
  imageHeight: number,
  settings: CropSettings,
) {
  const frameWidth = frameSize.width || 16;
  const frameHeight = frameSize.height || 9;
  const imageAspect = imageWidth / imageHeight;
  const baseWidth = imageAspect > ASPECT_RATIO ? frameHeight * imageAspect : frameWidth;
  const baseHeight = imageAspect > ASPECT_RATIO ? frameHeight : frameWidth / imageAspect;
  const width = baseWidth * settings.scale;
  const height = baseHeight * settings.scale;
  const maxOffsetX = Math.max(0, (width - frameWidth) / 2);
  const maxOffsetY = Math.max(0, (height - frameHeight) / 2);

  return {
    width,
    height,
    maxOffsetX,
    maxOffsetY,
    left: (frameWidth - width) / 2 + settings.offsetX * maxOffsetX,
    top: (frameHeight - height) / 2 + settings.offsetY * maxOffsetY,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
