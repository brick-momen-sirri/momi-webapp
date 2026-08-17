import type { UploadedImage } from "../types";

/**
 * Release the object URLs an upload slot's image was holding.
 *
 * A locally chosen file lives in the tab as a blob: URL, and the bytes behind it
 * are only freed when it is revoked -- for the renders this app deals in that is
 * tens of megabytes per slot. Anything else (saved media, a data URL, the
 * preview rendition of a chained result) owns no memory here and is left alone.
 *
 * Lives in utils rather than in ImageUploader because replacing a slot's image
 * is no longer something only the uploader does: chaining a result into the next
 * preset and restoring a saved job both write slots directly.
 */
export function revokeImageObjectUrls(image: UploadedImage | undefined) {
  if (!image) return;
  for (const url of [image.url, image.croppedUrl]) {
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}
