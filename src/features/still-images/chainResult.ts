// Feeding one still image result into the next preset.
//
// The archviz flow is a chain -- Qwen Edit or General Enhancement, then Pro
// Upscaler -- and until now the only way to walk it was Download followed by a
// re-upload of a 4K-10K PNG that had never left the server in the first place.
//
// Nothing here fetches anything. A result already IS saved project media, and
// uploadJobMediaUrl passes a saved-media URL through untouched, so the chained
// input reaches the next job as the same path on disk. The bytes never enter the
// tab, which is the whole point: these files routinely pass 100 MB, and the
// Animation drag-a-result path (resultImageDragDataToFile) does download them.
//
// Which URL is submitted is the entire subtlety, and getting it wrong made this
// feature fail every time it was used. job.resultUrl is not a media path: mapJob
// rewrites it to /api/jobs/:id/result-media?index=0&access_token=... so the browser
// can fetch a result through the backend. Submitted, that reaches the still image
// materializer, which resolves media by reading the `path` parameter of an
// /api/media URL -- finds none, concludes it has been handed a link to somewhere on
// the internet, and refuses it:
//
//   Still image slot 1 must be saved project media or an uploaded image;
//   remote URLs cannot be inlined.
//
// So the submitted value comes from resultSourceUrls, the /api/media?path= form the
// backend stored, while the displayed value stays the proxied one.

import { THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../../services/backendApi";
import type { Job, UploadedImage } from "../../types";
import { createClientId } from "../../utils/id";

/**
 * The result of `job` as an upload slot's image, or undefined if there is none
 * to chain -- a job that failed, or one still running.
 */
export function chainableResultImage(
  job: Pick<Job, "id" | "status" | "resultUrl" | "resultSourceUrls" | "fileName" | "modelType">,
) {
  if (job.status !== "completed") return undefined;
  const url = chainableResultUrl(job);
  if (!url) return undefined;

  const image: UploadedImage = {
    id: createClientId("img_"),
    name: job.fileName || `${job.modelType} result`,
    // Submitted as-is. Not a rendition: the next preset should run on the full
    // result, not on a downscaled copy of it.
    url,
    // Displayed instead. The slot is a ~200px box and the original can be 100+
    // MB, so this is the one place the rendition belongs.
    previewUrl: thumbnailMediaUrl(job.resultUrl ?? url, THUMBNAIL_WIDTH.chip),
    // Still Images has no 16:9 crop surface, and a chained result is already the
    // shape the previous preset produced.
    cropRequired: false,
  };
  return image;
}

/**
 * The result as something the next job can actually be submitted against, or
 * undefined when there is no such thing.
 *
 * Undefined for a result that is still only on the provider's storage: a job whose
 * media has not been pulled back yet carries an https link, and the presets cannot
 * take one. Better to refuse in the menu than at Generate.
 */
export function chainableResultUrl(job: Pick<Job, "resultSourceUrls">) {
  const url = job.resultSourceUrls?.[0];
  return url && isSavedMediaUrl(url) ? url : undefined;
}

function isSavedMediaUrl(url: string) {
  try {
    return new URL(url, "http://localhost").pathname === "/api/media";
  } catch {
    return false;
  }
}
