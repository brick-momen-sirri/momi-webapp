import { safeSegment } from "./storageService.js";

// Stored uploads are named "<uploadId>-<fileName>", where uploadId is
// "<13-digit epoch ms>-<12 hex>". A re-upload — cropping an image, or reusing a
// result as an input — hands the server back a basename that already carries one
// of those prefixes. Without stripping them the name grows by 26 characters on
// every round trip, and the stored path eventually crosses the Windows
// 260-character limit that native tools (ffmpeg, libvips) are subject to.
const UPLOAD_ID_PREFIX = /^\d{13}-[0-9a-f]{12}-/i;

// Tighter than safeSegment's 140: the stored path also carries the uploads root,
// a project segment, a user segment and the 26-character uploadId, so the
// basename needs a budget that keeps the total clear of the 260-char limit.
export const UPLOAD_BASE_NAME_MAX_LENGTH = 80;

export function stripUploadIdPrefixes(name: string) {
  let stripped = name;
  while (UPLOAD_ID_PREFIX.test(stripped)) {
    stripped = stripped.replace(UPLOAD_ID_PREFIX, "");
  }
  return stripped;
}

/**
 * Sanitises the basename of an upload: strips any upload-id prefixes the client
 * echoed back, then applies the length budget. Returns `fallback` when nothing
 * usable survives.
 */
export function uploadedMediaBaseName(rawName: string, fallback: string) {
  const cleaned = safeSegment(stripUploadIdPrefixes(rawName))
    .slice(0, UPLOAD_BASE_NAME_MAX_LENGTH)
    // A separator left dangling by the slice reads as a truncation artefact.
    .replace(/[._-]+$/, "");
  return cleaned || fallback;
}
