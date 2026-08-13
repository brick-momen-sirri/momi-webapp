import { backendResultFileUrl, getStoredAuthToken } from "../../services/backendApi";
import type { Job } from "../../types";

export function getPrimaryResultUrl(job: Job) {
  return job.resultUrls?.[0] ?? job.resultUrl ?? job.thumbnailUrls?.[0] ?? job.thumbnailUrl;
}

export function isImageResult(job: Job) {
  return job.outputType === "image" || (!job.outputType && !job.videoLength);
}

/**
 * Hands a URL to the browser's download manager.
 *
 * Deliberately a bare anchor rather than fetch + Blob + createObjectURL. The
 * backend answers the result routes with Content-Disposition: attachment, so the
 * browser streams straight to disk; buffering it into a Blob first would put the
 * whole file -- up to 100+ MB for a 10K still -- into this tab's memory for no
 * benefit. The filename comes from the response header, which is why no `download`
 * value is set here: the server already knows the result's real name.
 */
export function downloadFromUrl(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
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

export async function clipboardCompatibleImageBlob(blob: Blob) {
  const clipboardTypeSupported =
    typeof ClipboardItem.supports === "function" ? ClipboardItem.supports(blob.type) : blob.type === "image/png";
  if (clipboardTypeSupported) return blob;
  return convertImageBlobToPng(blob);
}

/**
 * Canvas re-encode, for the clipboard only.
 *
 * This holds the image's full decoded bitmap in memory -- roughly width x height
 * x 4 bytes, which is several hundred MB for a 10K still -- so it is reserved for
 * the one path that genuinely needs the pixels inside the page. Download format
 * conversion used to come through here too; it now happens on the backend, where
 * libvips streams the work instead of materialising the whole bitmap.
 */
function convertImageBlobToPng(blob: Blob) {
  const errorMessage = "Could not prepare image for clipboard.";
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
      context.drawImage(image, 0, 0);
      canvas.toBlob((convertedBlob) => {
        URL.revokeObjectURL(url);
        if (!convertedBlob) {
          reject(new Error(errorMessage));
          return;
        }
        resolve(convertedBlob);
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(errorMessage));
    };
    image.src = url;
  });
}
