import { ChangeEvent, ClipboardEvent, DragEvent, useRef, useState } from "react";
import { ClipboardPaste, Crop, ImagePlus, Replace, Trash2, UploadCloud } from "lucide-react";
import { fetchBackendClipboardImage, getStoredAuthToken } from "../services/backendApi";
import type { UploadedImage } from "../types";
import { getImageSize, isNearAspectRatio, outputSizeForResolution } from "../utils/imageCrop";
import { createClientId } from "../utils/id";
import { getResultImageDragData, type ResultImageDragData } from "../utils/resultDrag";
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
};

type Slot = {
  index: number;
  label: string;
};

type ClipboardFileResult = {
  files: File[];
  details: string[];
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
}: ImageUploaderProps) {
  const [activeCropIndex, setActiveCropIndex] = useState<number | null>(null);
  const [pasteMessage, setPasteMessage] = useState("");
  const [isPasting, setIsPasting] = useState(false);
  const slots = textOnly ? [] : imageSlots(requiresTwoImages, imageSlotCount);
  const cropOutputSize = outputSizeForResolution(selectedResolution);
  const use16By9Cropping = requiresLandscape && (!show16By9CropToggle || enable16By9Cropping);

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
      size = await getImageSize(url);
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

    const nextImages = [...images];
    nextImages[slotIndex] = nextImage;
    onChange(nextImages);

    if (use16By9Cropping && nextImage.cropRequired) {
      setActiveCropIndex(slotIndex);
    }
  }

  async function applyDraggedResult(slotIndex: number, dragData: ResultImageDragData) {
    const targetSlot = slots.find((slot) => slot.index === slotIndex);
    const label = targetSlot?.label ?? "image slot";

    setIsPasting(true);
    setPasteMessage(`Loading result into ${label}...`);

    try {
      const file = await resultImageDragDataToFile(dragData);
      await applyFile(slotIndex, file);
      setPasteMessage(`Loaded result into ${label}.`);
      window.setTimeout(() => setPasteMessage(""), 2200);
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setPasteMessage(`Could not load the dragged result image.${detail}`);
      window.setTimeout(() => setPasteMessage(""), 8000);
    } finally {
      setIsPasting(false);
    }
  }

  async function handlePaste(event: ClipboardEvent<HTMLElement>) {
    if (textOnly || isEditablePasteTarget(event.target)) {
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
    setPasteMessage("Pasting image...");
    const result = await clipboardImageFiles(data);
    await applyPastedFiles(result.files, noImageMessage(result.details));
  }

  async function pasteFilesFromSystemClipboard() {
    setIsPasting(true);
    setPasteMessage("Pasting image...");
    const browserResult = await browserClipboardImageFiles();
    if (browserResult.files.length) {
      await applyPastedFiles(dedupeFiles(browserResult.files), noImageMessage(browserResult.details));
      return;
    }

    const backendResult = await backendClipboardImageFiles();
    await applyPastedFiles(dedupeFiles(backendResult.files), noImageMessage([...browserResult.details, ...backendResult.details]));
  }

  async function applyPastedFiles(files: File[], emptyMessage: string) {
    const targetSlot = nextPasteTargetSlot(slots, images);
    if (!files.length) {
      setIsPasting(false);
      setPasteMessage(emptyMessage);
      window.setTimeout(() => setPasteMessage(""), 8000);
      return;
    }

    if (!targetSlot) {
      setIsPasting(false);
      setPasteMessage("All image slots are full.");
      window.setTimeout(() => setPasteMessage(""), 2200);
      return;
    }

    try {
      const uploaded = await buildUploadedImage(files[0]);
      const nextImages = [...images];

      nextImages[targetSlot.index] = uploaded;

      onChange(nextImages);

      setPasteMessage(`Pasted into ${targetSlot.label}.`);
      window.setTimeout(() => setPasteMessage(""), 2200);

      if (use16By9Cropping && uploaded.cropRequired) {
        setActiveCropIndex(targetSlot.index);
      }
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setPasteMessage(`Could not read the pasted image.${detail}`);
      window.setTimeout(() => setPasteMessage(""), 8000);
    } finally {
      setIsPasting(false);
    }
  }

  function removeImage(slotIndex: number) {
    const nextImages = [...images];
    delete nextImages[slotIndex];
    onChange(nextImages);
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
              disabled={isPasting}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50 disabled:cursor-wait disabled:opacity-60"
              title="Paste image from clipboard"
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {use16By9Cropping ? (
            <span className="rounded-full bg-teal-50 px-2 py-1 text-[11px] font-semibold text-teal-700">
              crop on import
            </span>
          ) : show16By9CropToggle ? (
            <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
              original ratio
            </span>
          ) : null}
        </div>
      </div>

      {show16By9CropToggle && !textOnly ? (
        <label className="mb-3 flex min-h-9 items-center gap-2 rounded-md border border-line bg-stone-50 px-3 text-xs font-semibold text-stone-700">
          <input
            type="checkbox"
            checked={enable16By9Cropping}
            onChange={(event) => handle16By9CroppingChange(event.target.checked)}
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
                onFile={(file) => void applyFile(slot.index, file)}
                onResultImage={(dragData) => void applyDraggedResult(slot.index, dragData)}
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

async function clipboardImageFiles(data: DataTransfer): Promise<ClipboardFileResult> {
  const files: File[] = [];
  const details: string[] = [];
  const pastedFiles = Array.from(data.files);
  for (const file of Array.from(data.files)) {
    if (isImageFile(file)) {
      files.push(file);
    }
  }
  details.push(pastedFiles.length ? `Paste files: ${files.length}/${pastedFiles.length} image.` : "Paste files: none.");

  let pastedItemImages = 0;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && (item.type.startsWith("image/") || !item.type)) {
      const file = item.getAsFile();
      if (file && isImageFile(file)) {
        files.push(file);
        pastedItemImages += 1;
      }
    }
  }
  details.push(data.items.length ? `Paste items: ${pastedItemImages}/${data.items.length} image.` : "Paste items: none.");

  if (files.length) {
    return { files: dedupeFiles(files), details };
  }

  const dataUrlResult = await clipboardDataUrlImageFiles(data);
  if (dataUrlResult.files.length) {
    return { files: dedupeFiles(dataUrlResult.files), details: [...details, ...dataUrlResult.details] };
  }

  const browserResult = await browserClipboardImageFiles();
  if (browserResult.files.length) {
    return { files: dedupeFiles(browserResult.files), details: [...details, ...dataUrlResult.details, ...browserResult.details] };
  }

  const backendResult = await backendClipboardImageFiles();
  return {
    files: dedupeFiles(backendResult.files),
    details: [...details, ...dataUrlResult.details, ...browserResult.details, ...backendResult.details],
  };
}

async function browserClipboardImageFiles(): Promise<ClipboardFileResult> {
  if (!navigator.clipboard?.read) {
    return { files: [], details: ["Browser clipboard: read unavailable."] };
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    const files: File[] = [];
    const types = new Set<string>();

    for (const item of clipboardItems) {
      item.types.forEach((type) => types.add(type));
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;

      const blob = await item.getType(imageType);
      files.push(new File([blob], `clipboard-image.${extensionForImageType(blob.type || imageType)}`, { type: blob.type || imageType }));
    }

    return {
      files,
      details: [
        files.length
          ? `Browser clipboard: ${files.length} image.`
          : `Browser clipboard: no image${types.size ? ` (${Array.from(types).join(", ")})` : ""}.`,
      ],
    };
  } catch (error) {
    return { files: [], details: [`Browser clipboard: ${errorMessage(error)}.`] };
  }
}

async function backendClipboardImageFiles(): Promise<ClipboardFileResult> {
  try {
    const image = await fetchBackendClipboardImage();
    const file = await dataUrlToFile(image.dataUrl, stripImageExtension(image.name || "clipboard-image"));
    return file
      ? { files: [file], details: [`Windows clipboard: ${image.type} from ${image.source}.`] }
      : { files: [], details: ["Windows clipboard: returned an image but the browser could not decode it."] };
  } catch (error) {
    return { files: [], details: [`Windows clipboard: ${errorMessage(error)}.`] };
  }
}

function dataTransferItemString(item: DataTransferItem) {
  return new Promise<string>((resolve) => {
    item.getAsString((value) => resolve(value || ""));
  });
}

async function clipboardDataUrlImageFiles(data: DataTransfer): Promise<ClipboardFileResult> {
  const textValues = await Promise.all(
    Array.from(data.items)
      .filter((item) => item.kind === "string" && (item.type === "text/html" || item.type === "text/plain"))
      .map((item) => dataTransferItemString(item)),
  );

  const files: File[] = [];

  for (const [valueIndex, value] of textValues.entries()) {
    for (const [dataUrlIndex, dataUrl] of extractImageDataUrls(value).entries()) {
      const file = await dataUrlToFile(dataUrl, `pasted-image-${valueIndex + 1}-${dataUrlIndex + 1}`);
      if (file) {
        files.push(file);
      }
    }
  }

  return {
    files,
    details: [textValues.length ? `Clipboard text/html: ${files.length} data image.` : "Clipboard text/html: none."],
  };
}

function extractImageDataUrls(value: string) {
  const urls = new Set<string>();
  const decoded = decodeHtmlEntities(value);
  for (const match of decoded.matchAll(/data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^"')\s<>]+/gi)) {
    urls.add(match[0].trim());
  }
  return Array.from(urls);
}

async function dataUrlToFile(dataUrl: string, baseName: string) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      return null;
    }

    return new File([blob], `${baseName}.${extensionForImageType(blob.type)}`, { type: blob.type });
  } catch {
    return null;
  }
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
}

function extensionForImageType(type: string) {
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("svg")) return "svg";
  return type.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "png";
}

function stripImageExtension(name: string) {
  return name.replace(/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i, "") || "clipboard-image";
}

function noImageMessage(details: string[]) {
  const detail = details.filter(Boolean).join(" ");
  return detail ? `No image found. ${detail}` : "No image found on the clipboard.";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}

function decodeHtmlEntities(value: string) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function dedupeFiles(files: File[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  const fileName = ensureImageExtension(sanitizeFileName(dragData.name || fileNameFromUrl(dragData.url) || "result-image"), blob.type);
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
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, " ").trim() || "result-image";
}

function ensureImageExtension(name: string, type: string) {
  if (/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name)) {
    return name;
  }
  return `${stripImageExtension(name)}.${extensionForImageType(type)}`;
}

function isEditablePasteTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "textarea" || tagName === "input";
}

function imageSlots(requiresTwoImages: boolean, imageSlotCount: number): Slot[] {
  if (requiresTwoImages) {
    return [
      { index: 0, label: "Start frame" },
      { index: 1, label: "End frame" },
    ];
  }

  const count = Math.max(0, Math.min(9, imageSlotCount || 0));
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: count === 1 ? "Input image" : `Input image ${index + 1}`,
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
  onFile: (file: File) => void;
  onResultImage: (dragData: ResultImageDragData) => void;
  onRemove: () => void;
  onCrop: () => void;
};

function UploadSlot({ slot, image, requiresLandscape, useCroppedImage, cropOutputSize, onFile, onResultImage, onRemove, onCrop }: UploadSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const source = useCroppedImage ? image?.croppedUrl ?? image?.url : image?.url;
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
  const sizeLabel = image?.width && image?.height
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
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(false);
    const resultDragData = getResultImageDragData(event.dataTransfer);
    if (resultDragData) {
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
          <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            Small input. Crop may reduce detail.
          </p>
        ) : null}
        <div className="mt-2 grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50"
            title="Replace image"
          >
            <Replace className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onCrop}
            disabled={!requiresLandscape}
            className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Open crop tool"
          >
            <Crop className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-red-50 hover:text-red-600"
            title="Remove image"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFileInput} />
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
        className={`flex h-32 min-w-0 flex-col items-center justify-center rounded-md border border-dashed px-2 text-center transition ${
          isDragging ? "border-accent bg-accent/10" : "border-line bg-mist/60 hover:bg-white"
        }`}
      >
        <ImagePlus className="h-6 w-6 text-stone-400" />
        <span className="mt-2 text-xs font-semibold">{slot.label}</span>
        <span className="mt-1 text-[11px] leading-4 text-stone-500">Drop image, result, or browse</span>
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFileInput} />
    </>
  );
}
