import { getStoredAuthToken } from "./authToken";

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
export const DEFAULT_API_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  readonly status?: number;
  readonly code: "http" | "network" | "timeout" | "invalid_response";

  constructor(message: string, options: { status?: number; code: ApiError["code"]; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

type ApiRequestOptions = {
  timeoutMs?: number;
};

export async function apiRequest<T>(path: string, init: RequestInit = {}, options: ApiRequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, init, options);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ApiError(`Invalid JSON response from ${path}.`, {
      status: response.status,
      code: "invalid_response",
      cause: error,
    });
  }
}

export async function apiUpload<T>(path: string, body: Blob, init: RequestInit = {}, options: ApiRequestOptions = {}) {
  return apiRequest<T>(path, { ...init, method: init.method ?? "POST", body }, options);
}

async function apiFetch(path: string, init: RequestInit, options: ApiRequestOptions) {
  const headers = new Headers(init.headers);
  const token = getStoredAuthToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);

  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const timeoutController = init.signal ? undefined : new AbortController();
  const signal = init.signal ?? timeoutController?.signal;
  const timeout =
    timeoutController && timeoutMs > 0
      ? window.setTimeout(() => timeoutController.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs)
      : undefined;

  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include", signal });
    if (!response.ok) {
      throw new ApiError(await errorMessageFromResponse(response), { status: response.status, code: "http" });
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timeoutController?.signal.aborted) {
      throw new ApiError(`Request timed out after ${timeoutMs}ms.`, { code: "timeout", cause: error });
    }
    throw new ApiError(error instanceof Error ? error.message : "Network request failed.", { code: "network", cause: error });
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export async function errorMessageFromResponse(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    // Reverse proxies can return HTML or an empty body. The status remains useful.
  }
  return `${response.status} ${response.statusText}`;
}
