import type { ImageDownloadFormat } from "../../components/DownloadImageChoiceModal";
import { backendResultFileUrl, getStoredAuthToken } from "../../services/backendApi";
import type { Job } from "../../types";

export function getPrimaryResultUrl(job: Job) {
  return job.resultUrls?.[0] ?? job.resultUrl ?? job.thumbnailUrls?.[0] ?? job.thumbnailUrl;
}

export function isImageResult(job: Job) {
  return job.outputType === "image" || (!job.outputType && !job.videoLength);
}

export function hasTwoImageDownloadChoices(job: Job) {
  const resultCount = job.resultUrls?.length ?? 0;
  return job.status === "completed" && isImageResult(job) && resultCount === 2;
}

export async function fetchResultBlob(job: Job, resultIndex = 0) {
  const fallbackUrl = job.resultUrls?.[resultIndex] ?? (resultIndex === 0 ? getPrimaryResultUrl(job) : undefined);
  const urls = [backendResultFileUrl(job.id, resultIndex), fallbackUrl].filter((url): url is string => Boolean(url));
  let lastError: unknown;
  for (const url of urls) {
    try {
      const token = getStoredAuthToken();
      const response = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error(`Could not read result file (${response.status}).`);
      return await response.blob();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not read result file.");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadNameForJob(job: Job, blob: Blob, resultIndex = 0) {
  const extension = extensionFromBlob(blob);
  const baseName = `${job.modelType || "result"}-${job.id}`.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  const imageSuffix = hasTwoImageDownloadChoices(job) ? `_image-${resultIndex + 1}` : "";
  return `${baseName}${imageSuffix}${extension}`;
}

function extensionFromBlob(blob: Blob) {
  if (blob.type.includes("jpeg")) return ".jpg";
  if (blob.type.includes("png")) return ".png";
  if (blob.type.includes("webp")) return ".webp";
  if (blob.type.includes("gif")) return ".gif";
  if (blob.type.includes("mp4")) return ".mp4";
  if (blob.type.includes("quicktime")) return ".mov";
  if (blob.type.includes("webm")) return ".webm";
  return ".bin";
}

export async function convertImageBlobForDownload(blob: Blob, format: ImageDownloadFormat) {
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  if (format === "png" && blob.type === mimeType) return blob;

  return convertImageBlob(blob, mimeType, format === "jpg" ? 1 : undefined, format === "jpg");
}

export async function clipboardCompatibleImageBlob(blob: Blob) {
  const clipboardTypeSupported =
    typeof ClipboardItem.supports === "function" ? ClipboardItem.supports(blob.type) : blob.type === "image/png";
  if (clipboardTypeSupported) return blob;
  return convertImageBlobToPng(blob);
}

function convertImageBlobToPng(blob: Blob) {
  return convertImageBlob(blob, "image/png", undefined, false, "Could not prepare image for clipboard.");
}

function convertImageBlob(
  blob: Blob,
  mimeType: "image/png" | "image/jpeg",
  quality?: number,
  fillWhite = false,
  errorMessage = "Could not prepare image download.",
) {
  return new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error(errorMessage));
        return;
      }
      if (fillWhite) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob(
        (convertedBlob) => {
          URL.revokeObjectURL(url);
          if (!convertedBlob) {
            reject(new Error(errorMessage));
            return;
          }
          resolve(convertedBlob);
        },
        mimeType,
        quality,
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(errorMessage));
    };
    image.src = url;
  });
}
