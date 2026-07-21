import path from "node:path";
import { comfyServers } from "./config.js";
import { getUserById } from "./authService.js";
import type { CreditUsageRow, CreditUsageSummary, Job, Project, WorkflowModel } from "./types.js";

type SyncServerlessCreditUsageInput = {
  project: Project;
  job: Job;
  model: WorkflowModel;
  creditUsage?: CreditUsageSummary;
  outputFiles?: string[];
  trackerUrls?: string[];
  syncToken?: string;
  fetchImpl?: typeof fetch;
};

export type CreditTrackerSyncResult = {
  ok: boolean;
  url?: string;
  inserted?: number;
  skipped?: number;
  error?: string;
};

type CreditTrackerRow = {
  timestamp: string;
  project_name: string;
  user_name: string;
  workflow_name: string;
  partner_node_name: string;
  pricing_mode: string;
  quantity: number;
  duration_seconds: number;
  resolution: string;
  estimated_credits: number;
  estimated_usd: number;
  notes: string;
  prompt_id: string;
  node_id: string;
  node_class_type: string;
  node_title: string;
  model_name: string;
  input_summary: string;
  source: string;
  dedupe_key: string;
};

const creditsPerUsd = 211;

export async function syncServerlessCreditUsage({
  project,
  job,
  model,
  creditUsage = job.creditUsage,
  outputFiles = [],
  trackerUrls = configuredTrackerUrls(),
  syncToken = process.env.CREDIT_TRACKER_SYNC_TOKEN?.trim() ?? "",
  fetchImpl = fetch,
}: SyncServerlessCreditUsageInput): Promise<CreditTrackerSyncResult> {
  if (!creditUsage || creditUsage.total_estimated_credits <= 0) {
    return { ok: true, skipped: 1 };
  }

  const rows = buildCreditTrackerRows(project, job, model, creditUsage, outputFiles);
  if (!rows.length) {
    return { ok: true, skipped: 1 };
  }

  let lastError = "";
  for (const baseUrl of trackerUrls.map((url) => url.replace(/\/$/, "")).filter(Boolean)) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (syncToken) headers["X-Credit-Tracker-Token"] = syncToken;

      const response = await fetchImpl(`${baseUrl}/credit-tracker/api/ingest-rows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          source_instance: "momi-runpod-serverless",
          ...(syncToken ? { sync_token: syncToken } : {}),
          rows,
        }),
        signal: AbortSignal.timeout(3500),
      });
      const body = await parseResponse(response);
      if (!response.ok) {
        lastError = `Credit Tracker ${baseUrl} returned ${response.status}: ${stringify(body)}`;
        continue;
      }

      const result = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return {
        ok: result.ok !== false,
        url: baseUrl,
        inserted: numberFrom(result.inserted),
        skipped: numberFrom(result.skipped),
        error: result.ok === false ? stringify(result.error ?? result) : undefined,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Could not sync serverless credit usage.";
    }
  }

  return { ok: false, error: lastError || "No Credit Tracker endpoint accepted the serverless usage row." };
}

export function buildCreditTrackerRows(
  project: Project,
  job: Job,
  model: WorkflowModel,
  creditUsage: CreditUsageSummary,
  outputFiles: string[] = [],
): CreditTrackerRow[] {
  const rows = creditUsage.rows?.length ? creditUsage.rows : [summaryAsRow(creditUsage, model)];
  const timestamp = job.completedAt ?? new Date().toISOString();
  const user = getUserById(job.userId);
  const userName = user?.displayName || user?.name || user?.username || job.userId;
  const promptId = `runpod:${job.runpodJobId ?? job.id}`;
  // folderPath is stored with the deployment host's separators (Windows in
  // prod). path.win32.basename treats both "\" and "/" as separators on any OS,
  // so this yields the folder name whether the code runs on Windows or Linux
  // (e.g. CI); plain path.basename would return the whole Windows path on POSIX.
  const projectName = path.win32.basename(project.folderPath || project.name);
  const inputSummary = JSON.stringify({
    source: "runpod_serverless",
    job_id: job.id,
    runpod_job_id: job.runpodJobId ?? "",
    model_id: model.id,
    duration_seconds: job.durationSeconds ?? 0,
    resolution: resolutionText(job),
    input_images: summarizeInputImages(job.inputImages),
    output_files: outputFiles,
    credit_usage_source: creditUsage.source,
  });

  return rows.map((row, index) => {
    const estimatedCredits = numberFrom(row.total_estimated_credits) ?? (rows.length === 1 ? creditUsage.total_estimated_credits : 0);
    const estimatedUsd = numberFrom(row.total_estimated_usd) ?? (creditUsage.total_estimated_usd && rows.length === 1
      ? creditUsage.total_estimated_usd
      : estimatedCredits / creditsPerUsd);
    const nodeId = stringFrom(row.node_id) || `runpod_${index + 1}`;
    const classType = stringFrom(row.class_type) || "RunPodServerlessComfy";
    const nodeTitle = stringFrom(row.node_title) || stringFrom(row.class_type) || model.name;
    const dedupeKey = [
      "runpod_serverless",
      job.id,
      job.runpodJobId ?? "",
      nodeId,
      roundCredits(estimatedCredits),
    ].join("|");

    return {
      timestamp,
      project_name: projectName,
      user_name: userName,
      workflow_name: model.name,
      partner_node_name: nodeTitle,
      pricing_mode: "runpod_credit_usage",
      quantity: 1,
      duration_seconds: Math.max(0, job.durationSeconds ?? 0),
      resolution: resolutionText(job),
      estimated_credits: roundCredits(estimatedCredits),
      estimated_usd: roundCredits(estimatedUsd),
      notes: `Serverless RunPod ComfyUI job; job_id=${job.id}; runpod_job_id=${job.runpodJobId ?? ""}; source=${creditUsage.source}`,
      prompt_id: promptId,
      node_id: nodeId,
      node_class_type: classType,
      node_title: nodeTitle,
      model_name: model.name,
      input_summary: inputSummary,
      source: "runpod_serverless",
      dedupe_key: dedupeKey,
    };
  });
}

export function configuredTrackerUrls() {
  const explicit = csvUrls(process.env.CREDIT_TRACKER_URLS);
  if (explicit.length) return uniqueUrls(explicit);

  return uniqueUrls([
    ...csvUrls(process.env.CREDIT_TRACKER_URL),
    ...csvUrls(process.env.COMFY_CREDIT_TRACKER_URL),
    "http://127.0.0.1:8188",
    ...comfyServers,
  ]);
}

function csvUrls(value: string | undefined) {
  return value?.split(",").map((url) => url.trim().replace(/\/$/, "")).filter(Boolean) ?? [];
}

function uniqueUrls(urls: string[]) {
  return [...new Set(urls)];
}

function summaryAsRow(creditUsage: CreditUsageSummary, model: WorkflowModel): CreditUsageRow {
  return {
    node_title: model.name,
    class_type: "RunPodServerlessComfy",
    total_estimated_credits: creditUsage.total_estimated_credits,
    total_estimated_usd: creditUsage.total_estimated_usd,
    source: creditUsage.source,
  };
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => undefined);
  }
  return response.text().catch(() => "");
}

function resolutionText(job: Job) {
  if (job.resolution?.label) return job.resolution.label;
  if (job.resolution) return `${job.resolution.width}x${job.resolution.height}`;
  return "";
}

function numberFrom(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeInputImages(inputImages: string[] = []) {
  return inputImages.map((image, index) => {
    if (!image.startsWith("data:")) return image;
    const match = image.match(/^data:([^;]+);base64,(.*)$/);
    const base64 = match?.[2] ?? "";
    return {
      index,
      kind: "data_url",
      mime_type: match?.[1] ?? "application/octet-stream",
      approximate_bytes: estimateBase64Bytes(base64),
    };
  });
}

function estimateBase64Bytes(base64: string) {
  const clean = base64.replace(/\s/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function roundCredits(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function stringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
