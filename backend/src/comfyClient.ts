type FetchOptions = RequestInit & { timeoutMs?: number };

async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 1000)}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getSystemStats(serverUrl: string) {
  return fetchJson<Record<string, unknown>>(`${serverUrl}/queue`, { timeoutMs: 30000 });
}

export async function getObjectInfo(serverUrl: string) {
  return fetchJson<Record<string, any>>(`${serverUrl}/object_info`, { timeoutMs: 8000 });
}

export async function uploadImage(serverUrl: string, file: Blob, filename: string) {
  return uploadInputFile(serverUrl, file, filename);
}

export async function uploadInputFile(serverUrl: string, file: Blob, filename: string) {
  const form = new FormData();
  form.set("image", file, filename);
  form.set("type", "input");
  form.set("overwrite", "true");

  return fetchJson<{ name?: string; subfolder?: string; type?: string }>(`${serverUrl}/upload/image`, {
    method: "POST",
    body: form,
    timeoutMs: 120000,
  });
}

export async function queuePrompt(serverUrl: string, workflow: unknown, clientId: string) {
  return fetchJson<{ prompt_id: string; number?: number; node_errors?: unknown }>(`${serverUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    timeoutMs: 12000,
  });
}

export async function getHistory(serverUrl: string, promptId: string) {
  return fetchJson<Record<string, unknown>>(`${serverUrl}/history/${encodeURIComponent(promptId)}`, {
    timeoutMs: 8000,
  });
}

export async function fetchComfyCredit(serverUrl: string) {
  return fetchJson<Record<string, unknown>>(`${serverUrl}/abuomar_credit_proxy`, { timeoutMs: 4000 });
}

export function toViewUrl(serverUrl: string, item: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const key of ["filename", "subfolder", "type"]) {
    const value = item[key];
    if (typeof value === "string" && value) {
      params.set(key, value);
    }
  }
  return `${serverUrl}/view?${params.toString()}`;
}
