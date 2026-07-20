type RunpodResponseLike = {
  id?: unknown;
  job_id?: unknown;
  status?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

type RunpodUrlInfo = {
  endpointId?: string;
  operation: string;
  operationPath: string;
  jobId?: string;
};

const omittedStringMaxLength = 300;
const maxArrayPreviewItems = 4;

export function runpodDebugEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.RUNPOD_DEBUG ?? "").trim().toLowerCase());
}

export function logRunpodRequest(url: string, init: RequestInit = {}) {
  const info = runpodUrlInfo(url);
  console.info(
    `[runpod] ${timestamp()} request ${init.method ?? "GET"} ${url} endpoint_id=${info.endpointId ?? "unknown"} operation=${info.operation}`,
  );

  if (info.operation === "/runsync") {
    console.info("[runpod] /runsync request is synchronous; RunPod request results may only be retained briefly.");
  }

  if (runpodDebugEnabled() && init.body != null) {
    console.info(`[runpod] sanitized request body ${safeJson(sanitizeRunpodRequestBody(init.body))}`);
  }
}

export function logRunpodResponse(url: string, responseStatus: number, data: RunpodResponseLike) {
  const info = runpodUrlInfo(url);
  const jobId = runpodJobId(data) ?? info.jobId;
  const runpodStatus = stringFrom(data.status);
  const output = isRecord(data.output) ? data.output : undefined;
  const outputSummary = summarizeRunpodOutput(output);

  console.info(
    [
      `[runpod] ${timestamp()} response ${responseStatus}`,
      `endpoint_id=${info.endpointId ?? "unknown"}`,
      `operation=${info.operation}`,
      jobId ? `job_id=${jobId}` : "",
      runpodStatus ? `runpod_status=${runpodStatus}` : "",
    ].filter(Boolean).join(" "),
  );

  if (info.operation === "/run") {
    console.info(`[runpod] /run accepted job_id=${jobId ?? "missing"} runpod_status=${runpodStatus ?? "missing"}`);
  }

  if (info.operation === "/status") {
    console.info(
      [
        `[runpod] status poll job_id=${jobId ?? "unknown"}`,
        `status=${runpodStatus ?? "unknown"}`,
        `output_exists=${output != null}`,
        `output.images=${outputSummary.images}`,
        `output.files=${outputSummary.files}`,
        `output.texts=${outputSummary.texts}`,
      ].join(" "),
    );
  }

  if (runpodDebugEnabled() && (info.operation === "/run" || info.operation === "/runsync")) {
    console.warn(
      [
        "[runpod] If this request is missing from the RunPod Requests dashboard, check:",
        `endpoint_id=${info.endpointId ?? "unknown"}`,
        `job_id=${jobId ?? "missing"}`,
        `operation=${info.operation}`,
        `timestamp=${timestamp()}`,
      ].join(" "),
    );
  }
}

export function logRunpodFetchError(url: string, error: unknown) {
  const info = runpodUrlInfo(url);
  console.warn(
    [
      `[runpod] ${timestamp()} request error`,
      `endpoint_id=${info.endpointId ?? "unknown"}`,
      `operation=${info.operation}`,
      `message=${error instanceof Error ? error.message : String(error)}`,
    ].join(" "),
  );
}

export function sanitizeRunpodRequestBody(body: unknown): unknown {
  const parsed = parseBody(body);
  if (parsed == null) return parsed;

  if (isRecord(parsed) && isRecord(parsed.input)) {
    return {
      ...sanitizeRunpodRecord(parsed),
      input_keys: Object.keys(parsed.input),
      input: sanitizeRunpodValue(parsed.input, "input", 0),
    };
  }

  return sanitizeRunpodValue(parsed, "body", 0);
}

export function runpodUrlInfo(url: string): RunpodUrlInfo {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const v2Index = segments.indexOf("v2");
    const endpointId = v2Index >= 0 ? segments[v2Index + 1] : undefined;
    const operationSegments = v2Index >= 0 ? segments.slice(v2Index + 2) : segments;
    const operation = operationSegments[0] ? `/${operationSegments[0]}` : "/";
    const operationPath = operationSegments.length ? `/${operationSegments.join("/")}` : "/";
    const jobId = operation === "/status" || operation === "/cancel" ? operationSegments[1] : undefined;
    return { endpointId, operation, operationPath, jobId };
  } catch {
    return { operation: "unknown", operationPath: "unknown" };
  }
}

export function summarizeRunpodOutput(output: unknown) {
  const record = isRecord(output) ? output : undefined;
  return {
    images: outputCollectionState(record?.images),
    files: outputCollectionState(record?.files),
    texts: outputCollectionState(record?.texts),
  };
}

function sanitizeRunpodValue(value: unknown, key: string, depth: number): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    return sanitizeRunpodString(value, key);
  }

  if (Array.isArray(value)) {
    if (isMediaInputKey(key)) {
      return {
        length: value.length,
        items: value.slice(0, maxArrayPreviewItems).map((item) => sanitizeRunpodMediaInput(item)),
      };
    }

    return value.slice(0, maxArrayPreviewItems).map((item) => sanitizeRunpodValue(item, key, depth + 1));
  }

  if (!isRecord(value)) return `[${typeof value}]`;
  if (key === "workflow") return summarizeWorkflow(value);

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (isSensitiveKey(childKey)) {
      result[childKey] = "[redacted]";
    } else {
      result[childKey] = sanitizeRunpodValue(childValue, childKey, depth + 1);
    }
  }
  return result;
}

function sanitizeRunpodRecord(value: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "input") continue;
    result[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeRunpodValue(child, key, 0);
  }
  return result;
}

function sanitizeRunpodMediaInput(value: unknown) {
  if (!isRecord(value)) return sanitizeRunpodValue(value, "media", 0);
  return {
    name: stringFrom(value.name),
    has_inline_data: Boolean(stringFrom(value.image) || stringFrom(value.video) || stringFrom(value.data)),
    has_url: Boolean(stringFrom(value.url)),
    url: stringFrom(value.url) ? sanitizeUrl(stringFrom(value.url) ?? "") : undefined,
    inline_bytes_estimate: inlineBytesEstimate(stringFrom(value.image) ?? stringFrom(value.video) ?? stringFrom(value.data)),
  };
}

function sanitizeRunpodString(value: string, key: string) {
  const trimmed = value.trim();
  if (isSensitiveKey(key)) return "[redacted]";
  if (key.toLowerCase().includes("base64") || key.toLowerCase() === "image" || key.toLowerCase() === "video") {
    return `[omitted media string length=${trimmed.length}]`;
  }
  if (trimmed.startsWith("data:")) {
    return `[omitted data-url length=${trimmed.length}]`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeUrl(trimmed);
  }
  if (looksLikeLargeBase64(trimmed)) {
    return `[omitted base64-like string length=${trimmed.length}]`;
  }
  if (trimmed.length > omittedStringMaxLength) {
    return `${trimmed.slice(0, omittedStringMaxLength)}... [length=${trimmed.length}]`;
  }
  return value;
}

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[redacted-query]";
    if (url.hash) url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function summarizeWorkflow(workflow: Record<string, unknown>) {
  const nodeEntries = Object.entries(workflow).filter(([, node]) => isRecord(node) && stringFrom(node.class_type));
  const classTypes = Array.from(new Set(nodeEntries.map(([, node]) => stringFrom((node as Record<string, unknown>).class_type)).filter((item): item is string => Boolean(item))));
  const titles = nodeEntries
    .map(([, node]) => isRecord((node as Record<string, unknown>)._meta) ? stringFrom(((node as Record<string, unknown>)._meta as Record<string, unknown>).title) : undefined)
    .filter((item): item is string => Boolean(item));

  return {
    type: nodeEntries.length ? "comfy_api_prompt" : "workflow_object",
    name: stringFrom(workflow.name) ?? stringFrom(workflow.workflow_name) ?? stringFrom(workflow.title),
    node_count: nodeEntries.length || Object.keys(workflow).length,
    class_types: classTypes.slice(0, 20),
    titles: titles.slice(0, 12),
  };
}

function outputCollectionState(value: unknown) {
  if (Array.isArray(value)) return `present:${value.length}`;
  if (isRecord(value)) return `present:${Object.keys(value).length}`;
  return value == null ? "missing" : "present";
}

function parseBody(body: unknown) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return `[unparsed body length=${body.length}]`;
    }
  }

  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }

  if (body instanceof ArrayBuffer) {
    return `[arraybuffer body bytes=${body.byteLength}]`;
  }

  if (ArrayBuffer.isView(body)) {
    return `[binary body bytes=${body.byteLength}]`;
  }

  return body;
}

function inlineBytesEstimate(value: string | undefined) {
  if (!value) return undefined;
  const payload = value.includes(",") ? value.split(",", 2)[1] : value;
  return Math.round(payload.length * 0.75);
}

function looksLikeLargeBase64(value: string) {
  return value.length > 512 && /^[a-zA-Z0-9+/=\r\n]+$/.test(value);
}

function isSensitiveKey(key: string) {
  const clean = key.toLowerCase();
  return clean.includes("api_key") || clean.includes("apikey") || clean.includes("authorization") || clean.includes("secret") || clean.includes("token") || clean === "key" || clean.endsWith("_key");
}

function isMediaInputKey(key: string) {
  const clean = key.toLowerCase();
  return clean === "images" || clean === "videos" || clean === "files";
}

function runpodJobId(response: RunpodResponseLike) {
  return stringFrom(response.id) ?? stringFrom(response.job_id);
}

function timestamp() {
  return new Date().toISOString();
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
