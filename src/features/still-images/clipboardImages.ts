// Getting an image out of the operating system and into the app.
//
// Every surface that accepts an image accepts it three ways -- a file picker, a
// drop, or a paste -- and the paste is the one with real work behind it. A copy
// from Photoshop, a browser, or Explorer can arrive as a File, as an
// `<img src="data:...">` inside CF_HTML, as a `file://` reference with no
// FileDrop, or as a native PNG stream the browser will not surface at all; the
// last of those needs the backend's own clipboard reader.
//
// It lives here, apart from any component, because the uploader is no longer the
// only thing that takes images: the editor's reference strip takes them too, and
// two copies of this decoding order would drift the first time one was fixed.

import { fetchBackendClipboardImage } from "../../services/backendApi";

export type ClipboardFileResult = {
  files: File[];
  details: string[];
};

export async function clipboardImageFiles(data: DataTransfer, frontendOnly = false): Promise<ClipboardFileResult> {
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

  const backendResult = frontendOnly
    ? { files: [], details: ["Backend clipboard access disabled."] }
    : await backendClipboardImageFiles();
  return {
    files: dedupeFiles(backendResult.files),
    details: [...details, ...dataUrlResult.details, ...browserResult.details, ...backendResult.details],
  };
}

export async function browserClipboardImageFiles(): Promise<ClipboardFileResult> {
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
      files.push(
        new File([blob], `clipboard-image.${extensionForImageType(blob.type || imageType)}`, { type: blob.type || imageType }),
      );
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

export async function backendClipboardImageFiles(): Promise<ClipboardFileResult> {
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

export async function dataUrlToFile(dataUrl: string, baseName: string) {
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

export function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
}

export function extensionForImageType(type: string) {
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("svg")) return "svg";
  return type.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "png";
}

export function stripImageExtension(name: string) {
  return name.replace(/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i, "") || "clipboard-image";
}

export function noImageMessage(details: string[]) {
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

// Release blob: URLs created by buildUploadedImage/CropModal once an image
// leaves its slot, so long editing sessions don't accumulate detached blobs.
// Only blob: URLs are revoked; server (/api/media) and data: URLs are left alone.
export function dedupeFiles(files: File[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isEditablePasteTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "textarea" || tagName === "input";
}
