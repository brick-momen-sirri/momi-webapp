import { getStoredAuthToken } from "./authToken";
import { API_BASE, apiRequest } from "./client";

export type MediaAccess = { token: string; expiresAt: string };

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

export function backendResultFileUrl(jobId: string, index = 0) {
  const suffix = index > 0 ? `?${new URLSearchParams({ index: String(index) }).toString()}` : "";
  return withMediaAccessToken(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/result-file${suffix}`);
}

export function backendResultMediaUrl(jobId: string, index = 0) {
  const params = new URLSearchParams({ index: String(index) });
  return withMediaAccessToken(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/result-media?${params.toString()}`);
}

export function resolveMediaUrl(url: string) {
  if (url.startsWith("/api/")) return withMediaAccessToken(`${API_BASE}${url}`);
  return url;
}

export function withMediaAccessToken(url: string) {
  const token = mediaAccess?.token;
  if (!token || url.includes("access_token=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}
