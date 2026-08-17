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

import { THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../../services/backendApi";
import type { Job, UploadedImage } from "../../types";
import { createClientId } from "../../utils/id";

/**
 * The result of `job` as an upload slot's image, or undefined if there is none
 * to chain -- a job that failed, or one still running.
 */
export function chainableResultImage(job: Pick<Job, "id" | "status" | "resultUrl" | "fileName" | "modelType">) {
  if (job.status !== "completed") return undefined;
  const url = job.resultUrl;
  if (!url) return undefined;

  const image: UploadedImage = {
    id: createClientId("img_"),
    name: job.fileName || `${job.modelType} result`,
    // Submitted as-is. Not a rendition: the next preset should run on the full
    // result, not on a downscaled copy of it.
    url,
    // Displayed instead. The slot is a ~200px box and the original can be 100+
    // MB, so this is the one place the rendition belongs.
    previewUrl: thumbnailMediaUrl(url, THUMBNAIL_WIDTH.chip),
    // Still Images has no 16:9 crop surface, and a chained result is already the
    // shape the previous preset produced.
    cropRequired: false,
  };
  return image;
}
