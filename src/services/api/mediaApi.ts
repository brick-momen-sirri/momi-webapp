import { apiRequest, apiUpload } from "./client";
import type { BackendClipboardImage } from "./types";

export { backendResultFileUrl, backendResultMediaUrl, clearMediaAccessToken, refreshMediaAccessToken } from "./mediaAccess";

export async function uploadBackendMedia(media: Blob, options: { projectId: string; kind: "image" | "video"; name?: string }) {
  const search = new URLSearchParams({ projectId: options.projectId, kind: options.kind });
  if (options.name) search.set("name", options.name);
  const headers = new Headers();
  if (media.type) headers.set("Content-Type", media.type);
  const data = await apiUpload<{ url: string }>(`/api/media/upload?${search.toString()}`, media, { headers });
  return data.url;
}

export const THUMBNAIL_WIDTH = { chip: 240, grid: 480, preview: 960 } as const;

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

export async function fetchBackendClipboardImage() {
  const data = await apiRequest<{ image: BackendClipboardImage }>("/api/clipboard/image");
  return data.image;
}
