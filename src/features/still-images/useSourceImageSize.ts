import { useEffect, useState } from "react";

import { resolveMediaUrl } from "../../services/api/mediaAccess";
import { loadImageElement } from "./maskRaster";

export type SourceImageSize = { width: number; height: number };

/**
 * The pixel dimensions of an upload slot's image.
 *
 * `UploadedImage` carries optional width and height, but the still image slots
 * do not fill them in -- nothing needed them until a preset was priced by area.
 * Measured here rather than plumbed through the upload path: the browser has to
 * decode the image to show it in the slot regardless, so this costs a cache hit,
 * and a preset that does not care never calls it.
 *
 * The measurement is stored against the url it came from and only returned when
 * the two still match. That is what makes swapping the image read as unmeasured
 * without clearing state from inside the effect -- and it means a slow load that
 * resolves after the artist has moved on is discarded rather than shown against
 * the wrong picture.
 *
 * Undefined while loading and if the load fails. A failure is not worth
 * surfacing: the caller's job is to quote a cost, and the honest answer for an
 * image it could not measure is to say nothing rather than guess.
 */
export function useSourceImageSize(url: string | undefined): SourceImageSize | undefined {
  const [measured, setMeasured] = useState<{ url: string; size: SourceImageSize } | undefined>(undefined);

  useEffect(() => {
    if (!url) return;

    let active = true;
    loadImageElement(resolveMediaUrl(url))
      .then((image) => {
        if (!active) return;
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (width > 0 && height > 0) setMeasured({ url, size: { width, height } });
      })
      .catch(() => {
        // Swallowed on purpose: see the note above.
      });

    return () => {
      active = false;
    };
  }, [url]);

  return measured && measured.url === url ? measured.size : undefined;
}
