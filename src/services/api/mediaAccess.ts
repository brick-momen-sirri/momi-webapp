import { getStoredAuthToken } from "./authToken";
import { API_BASE, apiRequest } from "./client";

export type MediaAccess = { token: string; expiresAt: string; cookie?: boolean };

const MEDIA_COOKIE = "momi_media";

let mediaAccess: MediaAccess | undefined;
let mediaAccessRefreshTimer: ReturnType<typeof setTimeout> | undefined;

const MEDIA_ACCESS_REFRESH_FRACTION = 0.6;
const MEDIA_ACCESS_MIN_REFRESH_MS = 30_000;

export function storeMediaAccess(next: MediaAccess | undefined) {
  mediaAccess = next;
  if (mediaAccessRefreshTimer) {
    clearTimeout(mediaAccessRefreshTimer);
    mediaAccessRefreshTimer = undefined;
  }
  if (!next || typeof window === "undefined") return;

  const remainingMs = new Date(next.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return;
  const delayMs = Math.max(MEDIA_ACCESS_MIN_REFRESH_MS, remainingMs * MEDIA_ACCESS_REFRESH_FRACTION);
  mediaAccessRefreshTimer = setTimeout(() => void refreshMediaAccessToken(), delayMs);
}

export async function refreshMediaAccessToken() {
  if (!getStoredAuthToken()) return;
  try {
    const data = await apiRequest<{ mediaAccess: MediaAccess }>("/api/media/access-token", { method: "POST" });
    storeMediaAccess(data.mediaAccess);
  } catch {
    // Retain the still-valid token; session restoration will issue another one.
  }
}

export function clearMediaAccessToken() {
  storeMediaAccess(undefined);
}

/**
 * The original result, as an attachment.
 *
 * With no `format` this streams the untouched bytes the generator produced. With
 * one, the backend re-encodes -- that work belongs there rather than in a canvas,
 * which would have to hold the entire decoded bitmap in the tab.
 */
export function backendResultFileUrl(jobId: string, index = 0, format?: "png" | "jpg") {
  const params = new URLSearchParams();
  if (index > 0) params.set("index", String(index));
  if (format) params.set("format", format);
  const query = params.toString();
  return withMediaAccessToken(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/result-file${query ? `?${query}` : ""}`);
}

export function backendResultMediaUrl(jobId: string, index = 0) {
  const params = new URLSearchParams({ index: String(index) });
  return withMediaAccessToken(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/result-media?${params.toString()}`);
}

export function resolveMediaUrl(url: string) {
  if (url.startsWith("/api/")) return withMediaAccessToken(`${API_BASE}${url}`);
  return url;
}

/**
 * Adds the media credential to a media URL, unless the cookie already carries it.
 *
 * Leaving it out when the cookie is present is the point, not an optimisation
 * detail: the token rotates every few minutes, and while it was in the query
 * string it was also part of the browser's cache key -- so every rotation threw
 * away the cached copy of every thumbnail on the page. Omitting it keeps a
 * result's URL stable for as long as the result exists.
 *
 * The cookie is verified rather than assumed. The server says it set one, but if
 * the browser rejected it, falling back to the query parameter is what keeps
 * images loading instead of turning them all into 401s.
 */
export function withMediaAccessToken(url: string) {
  if (mediaAccess?.cookie && hasMediaCookie()) return url;

  const token = mediaAccess?.token;
  if (!token || url.includes("access_token=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}

function hasMediaCookie() {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((cookie) => cookie.trim().startsWith(`${MEDIA_COOKIE}=`));
}
