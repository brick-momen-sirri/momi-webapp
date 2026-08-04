import { apiRequest } from "./client";
import type {
  BackendRuntime,
  BackendSnapshot,
  ComfyPoolAction,
  ComfyPoolActionResult,
  ComfyServer,
  PodStatusResponse,
} from "./types";

export function fetchBackendRuntime() {
  return apiRequest<BackendRuntime>("/api/runtime");
}

export function fetchBackendSnapshot() {
  return apiRequest<BackendSnapshot>("/api/snapshot");
}

export async function fetchPodStatus() {
  const data = await apiRequest<{ status: PodStatusResponse }>("/api/pods/status");
  return data.status;
}

export async function fetchComfyServers() {
  const data = await apiRequest<{ servers: ComfyServer[] }>("/api/comfy/servers");
  return data.servers;
}

export function runComfyPoolAction(action: ComfyPoolAction, port?: number) {
  return apiRequest<ComfyPoolActionResult>("/api/comfy/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, port }),
  });
}
