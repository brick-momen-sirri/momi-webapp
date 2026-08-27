import { ChangeEvent, ClipboardEvent, DragEvent, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Crop, ImagePlus, Replace, Trash2, UploadCloud } from "lucide-react";
import { getStoredAuthToken } from "../services/backendApi";
import {
  backendClipboardImageFiles,
  browserClipboardImageFiles,
  clipboardImageFiles,
  dedupeFiles,
  extensionForImageType,
  isEditablePasteTarget,
  isImageFile,
  noImageMessage,
  stripImageExtension,
} from "../features/still-images/clipboardImages";
import type { UploadedImage } from "../types";
import { getImageSize, isNearAspectRatio, outputSizeForResolution } from "../utils/imageCrop";
import { createClientId } from "../utils/id";
import { getResultImageDragData, type ResultImageDragData } from "../utils/resultDrag";
import { revokeImageObjectUrls } from "../utils/uploadedImage";
import { CropModal, type CropSaveResult } from "./CropModal";

type ImageUploaderProps = {
  images: UploadedImage[];
  onChange: (images: UploadedImage[]) => void;
  selectedResolution: string;
  requiresTwoImages: boolean;
  imageSlotCount: number;
  requiresLandscape: boolean;
  enable16By9Cropping: boolean;
  show16By9CropToggle: boolean;
  onEnable16By9CroppingChange: (enabled: boolean) => void;
  textOnly: boolean;
  frontendOnly?: boolean;
  slotLabels?: string[];
  // Read-only mode (no write access to the selected project). A disabled
  // fieldset around this component covers the buttons and file inputs; drop and
  // paste land on plain elements, so they are refused here instead.
  disabled?: boolean;
};

type Slot = {
  index: number;
  label: string;
};

export function ImageUploader({
  images,
  onChange,
  selectedResolution,
  requiresTwoImages,
  imageSlotCount,
  requiresLandscape,
  enable16By9Cropping,
  show16By9CropToggle,
  onEnable16By9CroppingChange,
  textOnly,
  frontendOnly = false,
  slotLabels,
  disabled = false,
}: ImageUploaderProps) {
  const [activeCropIndex, setActiveCropIndex] = useState<number | null>(null);
  const [pasteMessage, setPasteMessage] = useState("");
  const [isPasting, setIsPasting] = useState(false);
  const mountedRef = useRef(false);
  const imageProbeControllerRef = useRef<AbortController | null>(null);
  const pasteMessageTimerRef = useRef<number | null>(null);
  const slots = textOnly ? [] : imageSlots(requiresTwoImages, imageSlotCount, slotLabels);
  const cropOutputSize = outputSizeForResolution(selectedResolution);
  const use16By9Cropping = requiresLandscape && (!show16By9CropToggle || enable16By9Cropping);

  useEffect(() => {
    mountedRef.current = true;
    imageProbeControllerRef.current = new AbortController();
    return () => {
      mountedRef.current = false;
      imageProbeControllerRef.current?.abort();
      imageProbeControllerRef.current = null;
      if (pasteMessageTimerRef.current != null) {
        window.clearTimeout(pasteMessageTimerRef.current);
        pasteMessageTimerRef.current = null;
      }
    };
  }, []);

  function showPasteMessage(message: string, clearAfterMs?: number) {
    if (!mountedRef.current) return;
    if (pasteMessageTimerRef.current != null) {
      window.clearTimeout(pasteMessageTimerRef.current);
      pasteMessageTimerRef.current = null;
    }
    setPasteMessage(message);
    if (clearAfterMs != null) {
      pasteMessageTimerRef.current = window.setTimeout(() => {
        pasteMessageTimerRef.current = null;
        if (mountedRef.current) setPasteMessage("");
      }, clearAfterMs);
    }
  }

  function handle16By9CroppingChange(enabled: boolean) {
    onEnable16By9CroppingChange(enabled);
    if (!enabled) {
      setActiveCropIndex(null);
      return;
    }
    setActiveCropIndex(slots.find((slot) => images[slot.index]?.cropRequired)?.index ?? null);
  }

  async function buildUploadedImage(file: File): Promise<UploadedImage> {
    const url = URL.createObjectURL(file);
    let size: { width: number; height: number } | undefined;

    try {
      size = await getImageSize(url, { signal: imageProbeControllerRef.current?.signal });
    } catch {
      size = undefined;
    }

    const alreadyLandscape = Boolean(size && isNearAspectRatio(size.width, size.height));

    return {
      id: createClientId("img_"),
      name: file.name,
      url,
      cropRequired: requiresLandscape && !alreadyLandscape,
      width: size?.width,
      height: size?.height,
    };
  }

  async function applyFile(slotIndex: number, file: File) {
    const nextImage = await buildUploadedImage(file);
    if (!mountedRef.current) {
      revokeImageObjectUrls(nextImage);
      return false;
    }

    const previous = images[slotIndex];
    const nextImages = [...images];
    nextImages[slotIndex] = nextImage;
    onChange(nextImages);
    revokeImageObjectUrls(previous);

    if (use16By9Cropping && nextImage.cropRequired) {
      setActiveCropIndex(slotIndex);
    }
    return true;
  }

  async function applyDraggedResult(slotIndex: number, dragData: ResultImageDragData) {
    const targetSlot = slots.find((slot) => slot.index === slotIndex);
    const label = targetSlot?.label ?? "image slot";

    setIsPasting(true);
    showPasteMessage(`Loading result into ${label}...`);

    try {
      const file = await resultImageDragDataToFile(dragData);
      if (!mountedRef.current || !(await applyFile(slotIndex, file))) return;
      showPasteMessage(`Loaded result into ${label}.`, 2200);
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      showPasteMessage(`Could not load the dragged result image.${detail}`, 8000);
    } finally {
      if (mountedRef.current) setIsPasting(false);
    }
  }

  async function handlePaste(event: ClipboardEvent<HTMLElement>) {
    if (disabled || textOnly || isEditablePasteTarget(event.target)) {
      return;
    }

    event.preventDefault();
    await pasteFilesFromClipboardData(event.clipboardData);
  }

  async function handlePasteButton() {
    await pasteFilesFromSystemClipboard();
  }

  async function pasteFilesFromClipboardData(data: DataTransfer) {
    setIsPasting(true);
    showPasteMessage("Pasting image...");
    const result = await clipboardImageFiles(data, frontendOnly);
    await applyPastedFiles(result.files, noImageMessage(result.details));
  }

  async function pasteFilesFromSystemClipboard() {
    setIsPasting(true);
    showPasteMessage("Pasting image...");
    const browserResult = await browserClipboardImageFiles();
    if (browserResult.files.length) {
      await applyPastedFiles(dedupeFiles(browserResult.files), noImageMessage(browserResult.details));
      return;
    }

    const backendResult = frontendOnly
      ? { files: [], details: ["Backend clipboard access disabled."] }
      : await backendClipboardImageFiles();
    await applyPastedFiles(
      dedupeFiles(backendResult.files),
      noImageMessage([...browserResult.details, ...backendResult.details]),
    );
  }

  async function applyPastedFiles(files: File[], emptyMessage: string) {
    if (!mountedRef.current) return;
    const targetSlot = nextPasteTargetSlot(slots, images);
    if (!files.length) {
      setIsPasting(false);
      showPasteMessage(emptyMessage, 8000);
      return;
    }

    if (!targetSlot) {
      setIsPasting(false);
      showPasteMessage("All image slots are full.", 2200);
      return;
    }

    try {
      const uploaded = await buildUploadedImage(files[0]);
      if (!mountedRef.current) {
        revokeImageObjectUrls(uploaded);
        return;
      }
      const previous = images[targetSlot.index];
      const nextImages = [...images];

      nextImages[targetSlot.index] = uploaded;

      onChange(nextImages);
      revokeImageObjectUrls(previous);

      showPasteMessage(`Pasted into ${targetSlot.label}.`, 2200);

      if (use16By9Cropping && uploaded.cropRequired) {
        setActiveCropIndex(targetSlot.index);
      }
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      showPasteMessage(`Could not read the pasted image.${detail}`, 8000);
    } finally {
      if (mountedRef.current) setIsPasting(false);
    }
  }

  function removeImage(slotIndex: number) {
    const previous = images[slotIndex];
    const nextImages = [...images];
    delete nextImages[slotIndex];
    onChange(nextImages);
    revokeImageObjectUrls(previous);
  }

  function saveCrop(slotIndex: number, result: CropSaveResult) {
    const nextImages = [...images];
    const currentImage = nextImages[slotIndex];

    if (!currentImage) return;

    const updatedImage: UploadedImage = {
      ...currentImage,
      cropRequired: false,
      cropWidth: result.width,
      cropHeight: result.height,
    };

    if (result.croppedUrl) {
      updatedImage.croppedUrl = result.croppedUrl;
    } else {
      delete updatedImage.croppedUrl;
    }

    if (result.settings) {
      updatedImage.cropSettings = result.settings;
    } else {
      delete updatedImage.cropSettings;
    }

    nextImages[slotIndex] = updatedImage;
    onChange(nextImages);
    setActiveCropIndex(nextCropIndex(nextImages, slots, slotIndex));
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel" onPaste={handlePaste} tabIndex={0}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UploadCloud className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Input Image</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {!textOnly ? (
            <button
              type="button"
              onClick={() => void handlePasteButton()}
              disabled={disabled || isPasting}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50 disabled:cursor-wait disabled:opacity-60"
              title="Paste image from clipboard"
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {use16By9Cropping ? (
            <span className="rounded-full bg-teal-50 px-2 py-1 text-[11px] font-semibold text-teal-700">crop on import</span>
          ) : show16By9CropToggle ? (
            <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">original ratio</span>
          ) : null}
        </div>
      </div>

      {show16By9CropToggle && !textOnly ? (
        <label className="mb-3 flex min-h-9 items-center gap-2 rounded-md border border-line bg-stone-50 px-3 text-xs font-semibold text-stone-700">
          <input
            type="checkbox"
            checked={enable16By9Cropping}
            onChange={(event) => handle16By9CroppingChange(event.target.checked)}
            disabled={disabled}
            className="h-4 w-4 accent-accent"
          />
          Enable 16:9 Cropping
        </label>
      ) : null}

      {textOnly ? (
        <div className="rounded-md border border-dashed border-line bg-mist/70 px-4 py-8 text-center">
          <ImagePlus className="mx-auto h-6 w-6 text-stone-400" />
          <p className="mt-2 text-sm font-semibold">Text-only model selected</p>
          <p className="mt-1 text-xs text-stone-500">No input image is required for this job.</p>
        </div>
      ) : (
        <>
          <div className={`grid gap-2 ${slotGridClass(slots.length)}`}>
            {slots.map((slot) => (
              <UploadSlot
                key={slot.index}
                slot={slot}
                image={images[slot.index]}
                requiresLandscape={use16By9Cropping}
                useCroppedImage={use16By9Cropping}
                cropOutputSize={cropOutputSize}
                disabled={disabled}
                onFile={(file) => void applyFile(slot.index, file)}
                onResultImage={frontendOnly ? undefined : (dragData) => void applyDraggedResult(slot.index, dragData)}
                onRemove={() => removeImage(slot.index)}
                onCrop={() => setActiveCropIndex(slot.index)}
              />
            ))}
          </div>
          {pasteMessage ? (
            <p className="mt-2 break-words rounded-md bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-700">
              {pasteMessage}
              {isPasting ? <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-teal-600" /> : null}
            </p>
          ) : null}
        </>
      )}

      {use16By9Cropping && activeCropIndex !== null && images[activeCropIndex] ? (
        <CropModal
          image={images[activeCropIndex]}
          selectedResolution={selectedResolution}
          onCancel={() => setActiveCropIndex(null)}
          onSave={(result) => saveCrop(activeCropIndex, result)}
        />
      ) : null}
    </section>
  );
}

function nextPasteTargetSlot(slots: Slot[], images: UploadedImage[]) {
  const emptySlot = slots.find((slot) => !images[slot.index]);
  if (emptySlot) return emptySlot;
  return slots.length === 1 ? slots[0] : undefined;
}

async function resultImageDragDataToFile(dragData: ResultImageDragData) {
  const response = await fetch(dragData.url, resultFetchInit(dragData.url));
  if (!response.ok) {
    throw new Error(`Result fetch failed (${response.status}).`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("The dragged result is not an image.");
  }

  const fileName = ensureImageExtension(
    sanitizeFileName(dragData.name || fileNameFromUrl(dragData.url) || "result-image"),
    blob.type,
  );
  return new File([blob], fileName, { type: blob.type });
}

function resultFetchInit(url: string): RequestInit {
  const token = getStoredAuthToken();
  if (!token || !isBackendApiUrl(url)) {
    return { credentials: "include" };
  }

  return {
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  };
}

function isBackendApiUrl(url: string) {
  try {
    return new URL(url, window.location.href).pathname.startsWith("/api/");
  } catch {
    return url.startsWith("/api/");
  }
}

function fileNameFromUrl(url: string) {
  try {
    const pathName = new URL(url, window.location.href).pathname;
    return decodeURIComponent(pathName.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return "";
  }
}

function sanitizeFileName(name: string) {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "result-image"
  );
}

function ensureImageExtension(name: string, type: string) {
  if (/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name)) {
    return name;
  }
  return `${stripImageExtension(name)}.${extensionForImageType(type)}`;
}

function imageSlots(requiresTwoImages: boolean, imageSlotCount: number, slotLabels?: string[]): Slot[] {
  if (requiresTwoImages) {
    return [
      { index: 0, label: slotLabels?.[0] ?? "Start frame" },
      { index: 1, label: slotLabels?.[1] ?? "End frame" },
    ];
  }

  const count = Math.max(0, Math.min(9, imageSlotCount || 0));
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: slotLabels?.[index] ?? (count === 1 ? "Input image" : `Input image ${index + 1}`),
  }));
}

function slotGridClass(slotCount: number) {
  return slotCount > 1 ? "grid-cols-2" : "grid-cols-1";
}

function nextCropIndex(images: UploadedImage[], slots: Slot[], currentIndex: number) {
  const orderedSlots = [
    ...slots.filter((slot) => slot.index > currentIndex),
    ...slots.filter((slot) => slot.index < currentIndex),
  ];
  return orderedSlots.find((slot) => images[slot.index]?.cropRequired)?.index ?? null;
}

type UploadSlotProps = {
  slot: Slot;
  image?: UploadedImage;
  requiresLandscape: boolean;
  useCroppedImage: boolean;
  cropOutputSize: { width: number; height: number };
  disabled: boolean;
  onFile: (file: File) => void;
  onResultImage?: (dragData: ResultImageDragData) => void;
  onRemove: () => void;
  onCrop: () => void;
};

function UploadSlot({
  slot,
  image,
  requiresLandscape,
  useCroppedImage,
  cropOutputSize,
  disabled,
  onFile,
  onResultImage,
  onRemove,
  onCrop,
}: UploadSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // previewUrl is display-only and never replaces a crop, which is a local
  // object URL of the exact pixels that will be submitted.
  const source = useCroppedImage && image?.croppedUrl ? image.croppedUrl : (image?.previewUrl ?? image?.url);
  const tooSmall = Boolean(
    requiresLandscape &&
    image?.width &&
    image?.height &&
    (image.width < cropOutputSize.width || image.height < cropOutputSize.height),
  );
  const status = !useCroppedImage ? "original" : image?.cropRequired ? "crop required" : image?.croppedUrl ? "cropped" : "ready";
  const statusClass = !useCroppedImage
    ? "bg-stone-100 text-stone-700"
    : image?.cropRequired
      ? "bg-amber-100 text-amber-800"
      : image?.croppedUrl
        ? "bg-cyan-100 text-cyan-800"
        : "bg-teal-100 text-teal-800";
  const sizeLabel =
    image?.width && image?.height
      ? useCroppedImage && image.cropWidth && image.cropHeight
        ? `${image.width}x${image.height} -> ${image.cropWidth}x${image.cropHeight}`
        : `${image.width}x${image.height}`
      : "";

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      onFile(file);
      event.target.value = "";
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (disabled) return;
    event.preventDefault();
    setIsDragging(false);
    const resultDragData = getResultImageDragData(event.dataTransfer);
    if (resultDragData && onResultImage) {
      onResultImage(resultDragData);
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (file && isImageFile(file)) {
      onFile(file);
    }
  }

  if (image && source) {
    return (
      <div
        className={`min-w-0 rounded-md border bg-white p-2 transition ${
          isDragging ? "border-accent shadow-[0_0_0_2px_rgba(20,184,166,0.18)]" : "border-line"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <div className="relative aspect-video overflow-hidden rounded-md bg-stone-100">
          <img src={source} alt="" className={`h-full w-full ${useCroppedImage ? "object-cover" : "object-contain"}`} />
          <span className={`absolute left-2 top-2 rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass}`}>
            {status}
          </span>
          {isDragging ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/15 text-xs font-bold text-accent">
              Drop to replace
            </span>
          ) : null}
        </div>
        <div className="mt-2 min-h-8">
          <p className="truncate text-xs font-semibold">{slot.label}</p>
          <p className="truncate text-[11px] text-stone-500">{image.name}</p>
          {sizeLabel ? <p className="truncate text-[11px] text-stone-500">{sizeLabel}</p> : null}
        </div>
        {tooSmall ? (
          <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">Small input. Crop may reduce detail.</p>
        ) : null}
        <div className="mt-2 grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Replace image"
          >
            <Replace className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onCrop}
            disabled={disabled || !requiresLandscape}
            className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Open crop tool"
          >
            <Crop className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
            title="Remove image"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label={`Upload ${slot.label}`}
          disabled={disabled}
          className="hidden"
          onChange={handleFileInput}
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        disabled={disabled}
        className={`flex h-32 min-w-0 flex-col items-center justify-center rounded-md border border-dashed px-2 text-center transition disabled:cursor-not-allowed ${
          isDragging ? "border-accent bg-accent/10" : "border-line bg-mist/60 hover:bg-white"
        }`}
      >
        <ImagePlus className="h-6 w-6 text-stone-400" />
        <span className="mt-2 text-xs font-semibold">{slot.label}</span>
        <span className="mt-1 text-[11px] leading-4 text-stone-500">
          {disabled ? "View-only access" : onResultImage ? "Drop image, result, or browse" : "Drop image or browse"}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label={`Upload ${slot.label}`}
        disabled={disabled}
        className="hidden"
        onChange={handleFileInput}
      />
    </>
  );
}
