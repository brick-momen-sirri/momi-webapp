import { apiRequest, apiUpload } from "./client";
import type { BackendClipboardImage } from "./types";

export { backendResultFileUrl, backendResultMediaUrl, clearMediaAccessToken, refreshMediaAccessToken } from "./mediaAccess";

export async function uploadBackendMedia(
  media: Blob,
  options: { projectId: string; kind: "image" | "video"; name?: string; signal?: AbortSignal },
) {
  const search = new URLSearchParams({ projectId: options.projectId, kind: options.kind });
  if (options.name) search.set("name", options.name);
  const headers = new Headers();
  if (media.type) headers.set("Content-Type", media.type);
  const data = await apiUpload<{ url: string }>(`/api/media/upload?${search.toString()}`, media, {
    headers,
    signal: options.signal,
  });
  return data.url;
}

/**
 * Rendition widths the UI asks for. Every value must exist in the backend's
 * THUMBNAIL_WIDTHS, or the request snaps up to the next allowed width and the
 * rendition warmed at save time is not the one served.
 *
 * `fullscreen` is deliberately not the original: at screen size a 1440px WebP is
 * indistinguishable from a 10K PNG, transfers ~300 KB instead of ~100 MB, and
 * decodes to ~14 MB instead of ~420 MB.
 */
export const THUMBNAIL_WIDTH = { chip: 240, grid: 480, preview: 960, fullscreen: 1440 } as const;

export function thumbnailMediaUrl(url: string, width: number): string;
export function thumbnailMediaUrl(url: string | undefined, width: number): string | undefined;
export function thumbnailMediaUrl(url: string | undefined, width: number) {
  if (!url || /^(data|blob):/i.test(url)) return url;
  try {
    const parsed = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    if (parsed.pathname === "/api/media") {
      parsed.pathname = "/api/media/thumbnail";
    } else if (parsed.pathname !== "/api/media/thumbnail" && !/^\/api\/jobs\/[^/]+\/result-media$/.test(parsed.pathname)) {
      return url;
    }
    parsed.searchParams.set("w", String(width));
    return url.startsWith("/") ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Rewrites a video result URL to the rendition the browser can decode.
 *
 * Only the player uses this. Downloads deliberately keep pointing at the
 * original, so what people save is the master the generator produced -- 4K HEVC
 * included -- while what they watch in the tab is guaranteed to decode. The
 * backend passes through anything already playable, so this is safe to apply to
 * every video result rather than trying to guess the codec here.
 */
export function playableVideoUrl(url: string): string;
export function playableVideoUrl(url: string | undefined): string | undefined;
export function playableVideoUrl(url: string | undefined) {
  if (!url || /^(data|blob):/i.test(url)) return url;
  try {
    const parsed = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    if (parsed.pathname === "/api/media") {
      parsed.pathname = "/api/media/playable";
    } else if (/^\/api\/jobs\/[^/]+\/result-media$/.test(parsed.pathname)) {
      parsed.searchParams.set("playable", "1");
    } else {
      return url;
    }
    return url.startsWith("/") ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch {
    return url;
  }
}

export async function fetchBackendClipboardImage() {
  const data = await apiRequest<{ image: BackendClipboardImage }>("/api/clipboard/image");
  return data.image;
}
