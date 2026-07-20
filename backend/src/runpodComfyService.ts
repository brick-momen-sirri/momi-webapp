import {
  assertRunpodConfig,
  comfyOrgApiKey,
  runpodApiKey,
  runpodEndpointUrl,
  runpodPollIntervalMs,
  runpodRequestBodyMaxBytes,
  runpodStatusUrl,
  runpodTimeoutMs,
} from "./config.js";
import {
  combinedTextArtifactContent,
  extractRunpodTextArtifacts,
  isRunpodTextOutputItem,
  type RunpodTextArtifact,
} from "./runpodTextArtifactService.js";
import {
  logRunpodFetchError,
  logRunpodRequest,
  logRunpodResponse,
} from "./runpodDebugLogger.js";
import type { CreditUsageRow, CreditUsageSummary } from "./types.js";

export type RunpodComfyImageInput = {
  name: string;
  image?: string;
  url?: string;
};

export type RunpodMediaResult = {
  url: string;
  filename?: string;
  type?: string;
  source: string;
  isVideo: boolean;
};

export type RunpodComfyResult = {
  jobId?: string;
  status: string;
  media: RunpodMediaResult[];
  textArtifacts: RunpodTextArtifact[];
  generatedText?: string;
  creditUsage?: CreditUsageSummary;
};

type RunpodComfyInput = {
  workflow: unknown;
  images: RunpodComfyImageInput[];
  videos?: RunpodComfyImageInput[];
  fetchImpl?: typeof fetch;
};

type RunpodResponse = {
  id?: string;
  job_id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

const pendingStatuses = new Set(["IN_QUEUE", "IN_PROGRESS", "RETRYING"]);
const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "CANCELED", "TIMED_OUT"]);
const videoExtensions = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".gif"]);

export class RunpodComfyError extends Error {
  response?: unknown;
  status?: string;
  jobId?: string;
  creditUsage?: CreditUsageSummary;

  constructor(message: string, options: { response?: unknown; status?: string; jobId?: string; creditUsage?: CreditUsageSummary } = {}) {
    super(message);
    this.name = "RunpodComfyError";
    this.response = options.response;
    this.status = options.status;
    this.jobId = options.jobId;
    this.creditUsage = options.creditUsage;
  }
}

export async function runComfyWorkflowOnRunpod({ workflow, images, videos = [], fetchImpl = fetch }: RunpodComfyInput): Promise<RunpodComfyResult> {
  assertRunpodConfig();
  const startedAt = Date.now();
  const inputFiles = [...images, ...videos];
  const body = JSON.stringify({
    input: {
      workflow,
      images: inputFiles,
      comfy_org_api_key: comfyOrgApiKey,
    },
  });

  assertRunpodRequestBodySize(body);

  const firstResponse = await runpodFetch(fetchImpl, runpodEndpointUrl, {
    method: "POST",
    headers: runpodHeaders(),
    body,
  }, startedAt);

  return resolveRunpodResponse(firstResponse, fetchImpl, startedAt);
}

export function extractRunpodMedia(output: unknown): RunpodMediaResult[] {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const media: RunpodMediaResult[] = [];

  for (const key of ["videos", "images", "files", "animated"] as const) {
    for (const item of arrayFromUnknown(record[key])) {
      const parsed = mediaFromOutputItem(item, key);
      if (parsed) media.push(parsed);
    }
  }

  const byKey = new Map<string, RunpodMediaResult>();
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    byKey.set(mediaDedupKey(item, index), item);
  }
  return Array.from(byKey.values());
}

export function normalizeRunpodCreditUsage(raw: unknown): CreditUsageSummary | undefined {
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    const rows = raw.map(normalizeCreditUsageRow).filter((row): row is CreditUsageRow => Boolean(row));
    if (!rows.length) return undefined;
    const totalCredits = sumRows(rows, "total_estimated_credits");
    const totalUsd = sumRows(rows, "total_estimated_usd");
    return {
      total_estimated_credits: roundMoney(totalCredits),
      ...(totalUsd > 0 ? { total_estimated_usd: roundMoney(totalUsd) } : {}),
      source: "runpod_output",
      rows,
    };
  }

  if (typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const rows = creditUsageRows(record);
  const totalCredits =
    numberFrom(record.total_estimated_credits) ??
    numberFrom(record.total_credits) ??
    numberFrom(record.credits) ??
    numberFrom(record.estimated_credits) ??
    (rows.length ? sumRows(rows, "total_estimated_credits") : undefined);
  const totalUsd =
    numberFrom(record.total_estimated_usd) ??
    numberFrom(record.total_usd) ??
    numberFrom(record.usd) ??
    numberFrom(record.estimated_usd) ??
    (rows.length ? sumRows(rows, "total_estimated_usd") : undefined);

  if (totalCredits == null && totalUsd == null && !rows.length) return undefined;
  const source = stringFrom(record.source) ?? "runpod_output";
  const roundedCredits = roundMoney(totalCredits ?? 0);
  const roundedUsd = totalUsd != null ? roundMoney(totalUsd) : undefined;

  if (!rows.length && isMissingCreditUsageSource(source) && roundedCredits <= 0 && (roundedUsd ?? 0) <= 0) {
    return undefined;
  }

  return {
    total_estimated_credits: roundedCredits,
    ...(roundedUsd != null ? { total_estimated_usd: roundedUsd } : {}),
    source,
    ...(rows.length ? { rows } : {}),
  };
}

export function creditUsageFromRunpodOutput(output: unknown) {
  if (!output || typeof output !== "object") return undefined;
  return normalizeRunpodCreditUsage((output as Record<string, unknown>).credit_usage);
}

async function resolveRunpodResponse(response: RunpodResponse, fetchImpl: typeof fetch, startedAt: number): Promise<RunpodComfyResult> {
  let current = response;
  while (true) {
    const status = normalizeStatus(current.status ?? (current.output as Record<string, unknown> | undefined)?.status ?? "COMPLETED");
    if (pendingStatuses.has(status)) {
      const jobId = runpodJobId(current);
      if (!jobId) {
        throw new RunpodComfyError("RunPod returned a pending status without a job id.", { response: current, status });
      }

      await waitBeforePoll(startedAt);
      current = await runpodFetch(fetchImpl, runpodStatusUrl(jobId), {
        method: "GET",
        headers: runpodHeaders(),
      }, startedAt);
      continue;
    }

    if (!terminalStatuses.has(status) && current.output && !current.error) {
      return completedResult(current, status, fetchImpl);
    }

    if (status === "COMPLETED") {
      return completedResult(current, status, fetchImpl);
    }

    const creditUsage = creditUsageFromRunpodOutput(current.output);
    throw new RunpodComfyError(runpodFailureMessage(current, status), {
      response: current,
      status,
      jobId: runpodJobId(current),
      creditUsage,
    });
  }
}

async function completedResult(response: RunpodResponse, status: string, fetchImpl: typeof fetch): Promise<RunpodComfyResult> {
  const output = response.output ?? response;
  const textArtifacts = await extractRunpodTextArtifacts(output, fetchImpl);
  logTextArtifacts(textArtifacts);
  const generatedText = combinedTextArtifactContent(textArtifacts);
  return {
    jobId: runpodJobId(response),
    status,
    media: extractRunpodMedia(output),
    textArtifacts,
    ...(generatedText ? { generatedText } : {}),
    creditUsage: creditUsageFromRunpodOutput(output),
  };
}

function logTextArtifacts(textArtifacts: RunpodTextArtifact[]) {
  if (!textArtifacts.length) return;
  const labels = textArtifacts
    .map((artifact) => artifact.filename ?? artifact.url ?? artifact.source)
    .filter(Boolean)
    .join(", ");
  console.info(`[runpod] Found ${textArtifacts.length} text artifact(s)${labels ? `: ${labels}` : "."}`);
}

async function runpodFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, startedAt: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingTimeoutMs(startedAt));
  logRunpodRequest(url, init);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const data = await parseRunpodResponse(response);
    logRunpodResponse(url, response.status, data);
    if (!response.ok) {
      throw new RunpodComfyError(runpodHttpFailureMessage(response, data), {
        response: data,
        status: stringFrom(data.status) ?? String(response.status),
        jobId: runpodJobId(data),
      });
    }
    return data;
  } catch (error) {
    if (!(error instanceof RunpodComfyError)) {
      logRunpodFetchError(url, error);
    }
    if (error instanceof RunpodComfyError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new RunpodComfyError(`RunPod request timed out after ${Math.round(runpodTimeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseRunpodResponse(response: Response): Promise<RunpodResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json() as RunpodResponse;
  }

  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text) as RunpodResponse;
  } catch {
    return { message: text || response.statusText };
  }
}

function runpodHeaders() {
  return {
    Authorization: `Bearer ${runpodApiKey}`,
    "Content-Type": "application/json",
  };
}

function assertRunpodRequestBodySize(body: string) {
  const byteLength = Buffer.byteLength(body, "utf8");
  if (byteLength <= runpodRequestBodyMaxBytes) return;

  throw new RunpodComfyError(
    `RunPod request body would be ${formatBytes(byteLength)}, above the safe ${formatBytes(runpodRequestBodyMaxBytes)} limit. Configure RUNPOD_INPUT_BASE_URL so input media is sent as original-quality download URLs instead of base64 JSON.`,
  );
}

function remainingTimeoutMs(startedAt: number) {
  const elapsed = Date.now() - startedAt;
  const remaining = runpodTimeoutMs - elapsed;
  if (remaining <= 0) {
    throw new RunpodComfyError(`RunPod job timed out after ${Math.round(runpodTimeoutMs / 1000)} seconds.`);
  }
  return remaining;
}

async function waitBeforePoll(startedAt: number) {
  const interval = Math.min(runpodPollIntervalMs, remainingTimeoutMs(startedAt));
  await new Promise((resolve) => setTimeout(resolve, interval));
}

function normalizeStatus(status: unknown) {
  return String(status ?? "").trim().toUpperCase();
}

function runpodJobId(response: RunpodResponse) {
  return stringFrom(response.id) ?? stringFrom(response.job_id);
}

function runpodFailureMessage(response: RunpodResponse, status: string) {
  const detail = stringFrom(response.error) ?? stringFrom(response.message) ?? stringFrom((response.output as Record<string, unknown> | undefined)?.message);
  const serialized = safeJson(response);
  const prefix = isUnauthorizedComfyError(response)
    ? "Comfy API authorization failed. COMFY_ORG_API_KEY is missing, invalid, or was not accepted by the worker."
    : `RunPod job ${status || "FAILED"}.`;
  return `${prefix}${detail ? ` ${detail}` : ""}\n\nRunPod response:\n${serialized}`;
}

function runpodHttpFailureMessage(response: Response, data: unknown) {
  return `RunPod request failed with ${response.status} ${response.statusText}.\n\nRunPod response:\n${safeJson(data)}`;
}

function isUnauthorizedComfyError(value: unknown) {
  return safeJson(value).includes("Unauthorized: Please login first to use this node.");
}

function mediaFromOutputItem(item: unknown, source: string): RunpodMediaResult | undefined {
  if (isRunpodTextOutputItem(item, source)) return undefined;

  if (typeof item === "string") {
    const filename = filenameFromValue(item);
    return {
      url: item,
      filename,
      source,
      isVideo: source === "videos" || source === "animated" || hasVideoExtension(filename) || hasVideoExtension(item),
    };
  }

  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const data = stringFrom(record.data);
  const url =
    stringFrom(record.url) ??
    stringFrom(record.href) ??
    stringFrom(record.s3_url) ??
    stringFrom(record.download_url) ??
    stringFrom(record.file) ??
    stringFrom(record.path) ??
    data;
  if (!url) return undefined;

  const filename =
    stringFrom(record.filename) ??
    stringFrom(record.file_name) ??
    stringFrom(record.name) ??
    filenameFromValue(url);
  const type = stringFrom(record.type);

  return {
    url,
    filename,
    type,
    source,
    isVideo: source === "videos" || source === "animated" || hasVideoExtension(filename) || hasVideoExtension(url),
  };
}

function mediaDedupKey(media: RunpodMediaResult, index: number) {
  if (!media.url.startsWith("data:")) {
    return `${media.url}|${media.filename ?? ""}`;
  }

  const prefix = media.url.slice(0, 80);
  const suffix = media.url.slice(-80);
  return `data|${index}|${media.url.length}|${media.filename ?? ""}|${media.source}|${media.type ?? ""}|${prefix}|${suffix}`;
}

function arrayFromUnknown(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}

function filenameFromValue(value: string | undefined) {
  if (!value) return undefined;
  if (value.startsWith("data:")) {
    const mime = value.slice(5, value.indexOf(";"));
    const extension = extensionFromMime(mime);
    return extension ? `output${extension}` : undefined;
  }

  try {
    const url = new URL(value);
    const fromParam = url.searchParams.get("filename") ?? url.searchParams.get("path");
    const pathName = fromParam || url.pathname;
    const filename = pathName.split("/").filter(Boolean).at(-1);
    return filename ? decodeURIComponent(filename) : undefined;
  } catch {
    const filename = value.split(/[\\/]/).filter(Boolean).at(-1);
    return filename;
  }
}

function hasVideoExtension(value: string | undefined) {
  if (!value) return false;
  const clean = value.split("?")[0].split("#")[0].toLowerCase();
  const extension = clean.includes(".") ? `.${clean.split(".").at(-1)}` : "";
  return videoExtensions.has(extension);
}

function extensionFromMime(mime: string) {
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/webm") return ".webm";
  if (mime === "video/quicktime") return ".mov";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return undefined;
}

function creditUsageRows(record: Record<string, unknown>) {
  const candidate =
    record.per_node_rows ??
    record.per_node ??
    record.perNode ??
    record.node_usage ??
    record.nodes ??
    record.rows;
  return arrayFromUnknown(candidate)
    .map(normalizeCreditUsageRow)
    .filter((row): row is CreditUsageRow => Boolean(row));
}

function normalizeCreditUsageRow(row: unknown): CreditUsageRow | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  return {
    ...record,
    node_id: stringFrom(record.node_id) ?? stringFrom(record.nodeId) ?? stringFrom(record.node) ?? stringFrom(record.id),
    node_title: stringFrom(record.node_title) ?? stringFrom(record.nodeTitle) ?? stringFrom(record.title) ?? stringFrom(record.name),
    class_type: stringFrom(record.class_type) ?? stringFrom(record.classType),
    total_estimated_credits:
      numberFrom(record.total_estimated_credits) ??
      numberFrom(record.credits) ??
      numberFrom(record.estimated_credits),
    total_estimated_usd:
      numberFrom(record.total_estimated_usd) ??
      numberFrom(record.usd) ??
      numberFrom(record.estimated_usd),
    source: stringFrom(record.source),
    status: stringFrom(record.status),
  };
}

function sumRows(rows: CreditUsageRow[], key: "total_estimated_credits" | "total_estimated_usd") {
  return rows.reduce((sum, row) => sum + (numberFrom(row[key]) ?? 0), 0);
}

function numberFrom(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  return parsed != null && Number.isFinite(parsed) ? parsed : undefined;
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isMissingCreditUsageSource(source: string) {
  return ["none", "missing", "unavailable", "no_credit_usage"].includes(source.trim().toLowerCase());
}

function roundMoney(value: number) {
  return Math.round(value * 10000) / 10000;
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
