import {
  assertRunpodConfig,
  comfyOrgApiKey,
  runpodApiKey,
  runpodPollIntervalMs,
  runpodRequestBodyMaxBytes,
  runpodTimeoutMs,
} from "./config.js";
import { defaultRunpodEndpoint, type RunpodEndpoint } from "./runpodEndpoints.js";
import { createStreamProgressReader, type StreamProgressChunk, type StreamProgressReader } from "./runpodStreamProgress.js";
import {
  combinedTextArtifactContent,
  extractRunpodTextArtifacts,
  isRunpodTextOutputItem,
  type RunpodTextArtifact,
} from "./runpodTextArtifactService.js";
import { logRunpodFetchError, logRunpodRequest, logRunpodResponse } from "./runpodDebugLogger.js";
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

/**
 * One observation from polling RunPod, passed through without interpretation.
 * What it means for the job is the caller's decision, not this module's.
 */
export type RunpodPollObservation = {
  status: string;
  /** Milliseconds RunPod queued the job before a worker took it. */
  delayMs?: number;
  /** Milliseconds the worker has been executing. */
  executionMs?: number;
  workerId?: string;
  /**
   * Progress the worker emitted since the previous poll, oldest first. Empty
   * for workers that report nothing, and for every poll before one starts.
   */
  streamChunks?: StreamProgressChunk[];
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
  shouldCancel?: () => boolean;
  onSubmitted?: (submission: { jobId: string; status: string }) => void | Promise<void>;
  /** Called on each status poll so a caller can surface what the job is doing. */
  onPoll?: (observation: RunpodPollObservation) => void | Promise<void>;
  // Omitted means the shared Animation endpoint. Still image jobs pass their
  // preset's own pod -- see runpodEndpoints.ts.
  endpoint?: RunpodEndpoint;
};

type ResumeRunpodComfyInput = {
  jobId: string;
  fetchImpl?: typeof fetch;
  shouldCancel?: () => boolean;
  endpoint?: RunpodEndpoint;
  onPoll?: (observation: RunpodPollObservation) => void | Promise<void>;
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

  constructor(
    message: string,
    options: { response?: unknown; status?: string; jobId?: string; creditUsage?: CreditUsageSummary } = {},
  ) {
    super(message);
    this.name = "RunpodComfyError";
    this.response = options.response;
    this.status = options.status;
    this.jobId = options.jobId;
    this.creditUsage = options.creditUsage;
  }
}

export class RunpodComfyCanceledError extends Error {
  constructor() {
    super("RunPod job canceled by request.");
    this.name = "RunpodComfyCanceledError";
  }
}

export async function runComfyWorkflowOnRunpod({
  workflow,
  images,
  videos = [],
  fetchImpl = fetch,
  shouldCancel,
  onSubmitted,
  onPoll,
  endpoint = defaultRunpodEndpoint(),
}: RunpodComfyInput): Promise<RunpodComfyResult> {
  assertRunpodConfig();
  throwIfCancellationRequested(shouldCancel);
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

  const firstResponse = await runpodFetch(
    fetchImpl,
    endpoint.submitUrl,
    {
      method: "POST",
      headers: runpodHeaders(),
      body,
    },
    startedAt,
    shouldCancel,
  );

  const submittedJobId = runpodJobId(firstResponse);
  if (submittedJobId && onSubmitted) {
    await onSubmitted({
      jobId: submittedJobId,
      status: normalizeStatus(firstResponse.status ?? "IN_QUEUE"),
    });
  }

  return resolveRunpodResponse(firstResponse, fetchImpl, startedAt, endpoint, shouldCancel, onPoll);
}

export async function resumeComfyWorkflowOnRunpod({
  jobId,
  fetchImpl = fetch,
  shouldCancel,
  endpoint = defaultRunpodEndpoint(),
  onPoll,
}: ResumeRunpodComfyInput): Promise<RunpodComfyResult> {
  assertRunpodConfig();
  throwIfCancellationRequested(shouldCancel);
  return resolveRunpodResponse({ id: jobId, status: "IN_PROGRESS" }, fetchImpl, Date.now(), endpoint, shouldCancel, onPoll);
}

export async function cancelComfyWorkflowOnRunpod(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
  endpoint: RunpodEndpoint = defaultRunpodEndpoint(),
) {
  assertRunpodConfig();
  const response = await runpodFetch(
    fetchImpl,
    endpoint.cancelUrl(jobId),
    {
      method: "POST",
      headers: runpodHeaders(),
    },
    Date.now(),
  );
  return {
    jobId: runpodJobId(response) ?? jobId,
    status: normalizeStatus(response.status ?? "CANCELLED"),
  };
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

  // "message" is the Still Images pods' output key: those workers return
  // { message: [url], status: "success" } instead of the images/videos arrays the
  // Animation worker uses.
  //
  // It gets its own strict reader rather than joining the loop above, for two
  // reasons found by testing the first live run: the generic reader drops a bare
  // string because arrayFromUnknown only unwraps arrays and objects, and it would
  // happily turn a prose message into a media entry, because the text-artifact
  // check only recognises text by extension, content type or URL -- not by a
  // sentence. So only things that actually look like media are accepted here.
  for (const entry of messageEntries(record.message)) {
    const parsed = mediaFromMessageEntry(entry);
    if (parsed) media.push(parsed);
  }

  const byKey = new Map<string, RunpodMediaResult>();
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    byKey.set(mediaDedupKey(item, index), item);
  }
  return Array.from(byKey.values());
}

/**
 * Did the worker declare its own failure inside an otherwise fine response?
 *
 * Only acts on an explicit non-success `output.status`. The Animation worker does
 * not set that field at all, so its behaviour is unchanged; the Still Images pods
 * set "success" on the happy path.
 */
function workerReportedFailure(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const record = output as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : undefined;
  if (!status || status === "success" || status === "ok" || status === "completed") return undefined;

  const detail = [record.error, record.message]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .slice(0, 500);

  return `RunPod worker reported status "${record.status}"${detail ? `: ${detail}` : " with no detail."}`;
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

async function resolveRunpodResponse(
  response: RunpodResponse,
  fetchImpl: typeof fetch,
  startedAt: number,
  endpoint: RunpodEndpoint,
  shouldCancel?: () => boolean,
  onPoll?: (observation: RunpodPollObservation) => void | Promise<void>,
): Promise<RunpodComfyResult> {
  let current = response;
  // Only built when someone is listening, so a caller that does not want
  // progress does not pay for an extra request per poll.
  const streamReader = onPoll ? createStreamProgressReader(endpoint.id || "endpoint") : undefined;
  // The stream request currently open, awaited on the next pass. Never rejects:
  // readStreamChunks resolves to an empty list on any failure.
  let pendingStream: Promise<StreamProgressChunk[]> | undefined;

  while (true) {
    throwIfCancellationRequested(shouldCancel);
    const status = normalizeStatus(
      current.status ?? (current.output as Record<string, unknown> | undefined)?.status ?? "COMPLETED",
    );
    // Reported before the pending check so a caller sees the terminal poll too,
    // and never awaited into the failure path: a progress listener must not be
    // able to break a job that RunPod is running fine.
    if (onPoll) {
      const jobId = runpodJobId(current);
      // Read the request issued on the previous pass, then immediately issue the
      // next one so it stays open across the status call and the wait that
      // follows. A request opened and closed in milliseconds every few seconds
      // only sees what happens to be buffered at that instant; forge keeps one
      // in flight continuously, and that is the difference between reading this
      // pod's progress and reading nothing from it.
      // Where the progress actually is. These workers call RunPod's
      // progress_update(), which surfaces the latest message on the *status*
      // response -- "Running node 32: KSampler", "[comfy-log][enhance-step]
      // node=32 item=2 step=5/30". /stream carries nothing for them, because
      // that is for generator handlers and these are not, which is why it
      // honestly answered with an empty list every time it was asked.
      //
      // Only the newest message is kept by RunPod, so a poll sees the current
      // step rather than every step. That is what the UI wants anyway.
      //
      // The field is `output`, and only while the job is pending. RunPod's
      // progress_update() overwrites the job's output with the latest message
      // as it runs, then replaces it with the real result on completion --
      // observed live:
      //
      //   IN_PROGRESS  output: "Running node 32: KSampler"      <- progress
      //   COMPLETED    output: { message: [s3Url], status: ... } <- the result
      //
      // Hence both guards. Reading `output` on a terminal poll would feed the
      // result payload, S3 URL and all, into the progress line.
      const statusChunks =
        streamReader && pendingStatuses.has(status) && typeof current.output === "string"
          ? streamReader.read({ progress: current.output })
          : [];

      // Still drained, for any worker that is a generator. Kept deliberately:
      // it costs one request per poll and the presets do not all share an image.
      const streamChunks = pendingStream ? await pendingStream : [];
      pendingStream =
        streamReader && jobId && pendingStatuses.has(status)
          ? readStreamChunks(fetchImpl, endpoint, jobId, streamReader)
          : undefined;
      try {
        await onPoll({
          status,
          delayMs: finiteNumber(current.delayTime),
          executionMs: finiteNumber(current.executionTime),
          workerId: stringFrom(current.workerId),
          // Status-reported progress first: it is the newest thing the worker
          // said, so a caller taking the last recognisable entry gets the step
          // that is actually running.
          streamChunks: [...streamChunks, ...statusChunks],
        });
      } catch {
        // Progress reporting is decoration; losing it must not lose the render.
      }
    }
    // Past this point the job is no longer pending, so no further chunks can
    // arrive. Reported here rather than on a poll count, so a job that finishes
    // in seconds still says whether its worker streamed.
    if (!pendingStatuses.has(status)) streamReader?.summarize();

    if (pendingStatuses.has(status)) {
      const jobId = runpodJobId(current);
      if (!jobId) {
        throw new RunpodComfyError("RunPod returned a pending status without a job id.", { response: current, status });
      }

      await waitBeforePoll(startedAt, shouldCancel);
      current = await runpodFetch(
        fetchImpl,
        withCacheBuster(endpoint.statusUrl(jobId)),
        {
          method: "GET",
          headers: runpodHeaders(),
        },
        startedAt,
        shouldCancel,
      );
      continue;
    }

    // A worker can report its own failure inside a COMPLETED envelope: RunPod ran
    // the job fine, but the graph did not. Without this the job would be recorded
    // as succeeding with no media, which is what made the first live Still Images
    // failure so hard to read.
    const workerFailure = workerReportedFailure(current.output);
    if (workerFailure) {
      throw new RunpodComfyError(workerFailure, {
        response: current,
        status,
        jobId: runpodJobId(current),
        creditUsage: creditUsageFromRunpodOutput(current.output),
      });
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

async function runpodFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  startedAt: number,
  shouldCancel?: () => boolean,
) {
  throwIfCancellationRequested(shouldCancel);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingTimeoutMs(startedAt));
  let canceled = false;
  let cancellationError: unknown;
  const cancellationTimer = shouldCancel
    ? setInterval(
        () => {
          try {
            if (!shouldCancel()) return;
            canceled = true;
            controller.abort();
          } catch (error) {
            cancellationError = error;
            controller.abort();
          }
        },
        Math.min(1000, Math.max(50, runpodPollIntervalMs)),
      )
    : undefined;
  cancellationTimer?.unref?.();
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
    if (cancellationError) throw cancellationError;
    if (error instanceof Error && error.name === "AbortError" && canceled) {
      throw new RunpodComfyCanceledError();
    }
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
    if (cancellationTimer) clearInterval(cancellationTimer);
  }
}

async function parseRunpodResponse(response: Response): Promise<RunpodResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as RunpodResponse;
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
    // Progress polling reads the same two URLs every few seconds and needs the
    // newest answer each time, not whatever an intermediary held on to. Without
    // these (and the cache buster below) /stream can keep answering with the
    // empty list it returned before the worker started emitting, which reads
    // exactly like a worker that never streams at all.
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

/**
 * A unique query parameter per request.
 *
 * Belt and braces with the no-cache headers above: the same URL polled on a
 * timer is precisely the shape a cache is happiest to serve stale, and a stale
 * status also stalls the phase the UI reports.
 */
function withCacheBuster(url: string) {
  return `${url}${url.includes("?") ? "&" : "?"}_t=${Date.now()}`;
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

async function waitBeforePoll(startedAt: number, shouldCancel?: () => boolean) {
  throwIfCancellationRequested(shouldCancel);
  const interval = Math.min(runpodPollIntervalMs, remainingTimeoutMs(startedAt));
  await new Promise((resolve) => setTimeout(resolve, interval));
  throwIfCancellationRequested(shouldCancel);
}

function throwIfCancellationRequested(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) {
    throw new RunpodComfyCanceledError();
  }
}

function normalizeStatus(status: unknown) {
  return String(status ?? "")
    .trim()
    .toUpperCase();
}

function runpodJobId(response: RunpodResponse) {
  return stringFrom(response.id) ?? stringFrom(response.job_id);
}

function runpodFailureMessage(response: RunpodResponse, status: string) {
  const detail =
    stringFrom(response.error) ??
    stringFrom(response.message) ??
    stringFrom((response.output as Record<string, unknown> | undefined)?.message);
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
    stringFrom(record.filename) ?? stringFrom(record.file_name) ?? stringFrom(record.name) ?? filenameFromValue(url);
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

/** output.message is a single string on some responses and a list on others. */
function messageEntries(value: unknown): unknown[] {
  if (typeof value === "string") return [value];
  return arrayFromUnknown(value);
}

function mediaFromMessageEntry(value: unknown): RunpodMediaResult | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed) || /^data:(image|video)\//i.test(trimmed)) {
    const filename = filenameFromValue(trimmed);
    return {
      url: trimmed,
      filename,
      source: "message",
      isVideo: hasVideoExtension(filename) || hasVideoExtension(trimmed),
    };
  }

  // Bare base64, which forge's reader also accepts. Sniffed by magic bytes rather
  // than guessed at, so prose cannot be mistaken for an image, and wrapped into a
  // data URL because that is the shape the rest of the result pipeline handles.
  const mimeType = base64MediaMimeType(trimmed);
  if (!mimeType) return undefined;
  return {
    url: `data:${mimeType};base64,${trimmed}`,
    filename: `output${extensionFromMime(mimeType) ?? ".bin"}`,
    source: "message",
    isVideo: mimeType.startsWith("video/"),
  };
}

function base64MediaMimeType(value: string) {
  // Long enough to be media, and only base64 characters.
  if (value.length < 64 || /[^A-Za-z0-9+/=\s]/.test(value)) return undefined;

  let head: Buffer;
  try {
    head = Buffer.from(value.slice(0, 64).replace(/\s/g, ""), "base64");
  } catch {
    return undefined;
  }
  if (head.byteLength < 12) return undefined;

  if (head.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (head.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (head.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (head.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return undefined;
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
  const candidate = record.per_node_rows ?? record.per_node ?? record.perNode ?? record.node_usage ?? record.nodes ?? record.rows;
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
    node_title:
      stringFrom(record.node_title) ?? stringFrom(record.nodeTitle) ?? stringFrom(record.title) ?? stringFrom(record.name),
    class_type: stringFrom(record.class_type) ?? stringFrom(record.classType),
    total_estimated_credits:
      numberFrom(record.total_estimated_credits) ?? numberFrom(record.credits) ?? numberFrom(record.estimated_credits),
    total_estimated_usd: numberFrom(record.total_estimated_usd) ?? numberFrom(record.usd) ?? numberFrom(record.estimated_usd),
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

/**
 * Drains the worker's progress buffer.
 *
 * Swallows every failure and returns nothing on error: the stream is an extra
 * request per poll against an endpoint that may not implement it at all, and a
 * job must never fail because its progress feed did.
 */
async function readStreamChunks(
  fetchImpl: typeof fetch,
  endpoint: RunpodEndpoint,
  jobId: string,
  reader: StreamProgressReader,
): Promise<StreamProgressChunk[]> {
  try {
    const response = await fetchImpl(withCacheBuster(endpoint.streamUrl(jobId)), {
      method: "GET",
      headers: runpodHeaders(),
      // Matches forge's 30s. Now that the request is deliberately left open
      // across a poll interval, a shorter budget would abort a connection that
      // is doing exactly what it should.
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // The difference between "this pod does not report progress" and "we are
      // asking it wrong". Without this the two are indistinguishable, because
      // everything here is swallowed.
      reader.note(`stream request returned HTTP ${response.status}`);
      return [];
    }
    const payload = await response.json();
    const chunks = reader.read(payload);
    // Until something parses, record what actually came back. "No chunks" says
    // the parse found nothing; it does not say whether the body was empty or
    // full of a shape this does not recognise, and guessing between those two
    // has already cost several rounds. Deduped, and only while nothing parses,
    // so a working stream logs this once at most.
    if (!chunks.length) {
      reader.note(`raw stream body: ${JSON.stringify(payload).slice(0, 400)}`);
    }
    return chunks;
  } catch (error) {
    reader.note(`stream request failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function finiteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
