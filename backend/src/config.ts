import "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendHttpError } from "./httpError.js";
import { backendProcessRole } from "./processRole.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendRoot = path.resolve(here, "..");
export const workspaceRoot = path.resolve(backendRoot, "..");

export const PORT = Number(process.env.PORT ?? 3333);
export const HOST = process.env.HOST ?? "127.0.0.1";

export const comfyServers = (process.env.COMFY_SERVERS?.split(",").map((url) => url.trim()).filter(Boolean) ?? [
  ...Array.from({ length: 20 }, (_, index) => `http://127.0.0.1:${8201 + index}`),
]).map((url) => url.replace(/\/$/, ""));

export const comfyRoot =
  process.env.COMFY_ROOT ??
  "C:\\ComfyUI_windows_portable_nvidia_cu128\\ComfyUI_windows_portable\\ComfyUI";
export const comfyPoolRoot = process.env.COMFY_POOL_ROOT ?? "C:\\Comfy_pool";

export const generationBackend = process.env.GENERATION_BACKEND === "local_comfy" ? "local_comfy" : "runpod";
export const localComfyEnabled = generationBackend === "local_comfy";

export const serverlessWorkflowRoot = process.env.SERVERLESS_WORKFLOW_ROOT ?? path.join(workspaceRoot, "workflow");
const legacyComfyWorkflowRoots = [
  path.join(comfyRoot, "custom_nodes", "Brick_flf2v_workflow", "example_workflows"),
  path.join(comfyRoot, "custom_nodes", "Brick_i2v_workflow", "example_workflows"),
  path.join(comfyRoot, "custom_nodes", "Brick_image_editing_workflow", "example_workflows"),
  path.join(comfyRoot, "custom_nodes", "Brick_video_editing_workflow", "example_workflows"),
];
export const workflowRoots = process.env.WORKFLOW_ROOTS
  ? process.env.WORKFLOW_ROOTS.split(";").map((item) => item.trim()).filter(Boolean)
  : localComfyEnabled
    ? legacyComfyWorkflowRoots
    : [serverlessWorkflowRoot];

export const brickProjectsRoot = process.env.BRICK_PROJECTS_ROOT ?? path.join(comfyRoot, "output", "projects");
export const localProjectsRoot = process.env.LOCAL_PROJECTS_ROOT ?? path.join(backendRoot, "data", "projects");
export const uploadedMediaRoot = process.env.UPLOADED_MEDIA_ROOT ?? path.join(localProjectsRoot, "_uploads");
export const workflowMappingsPath = path.join(backendRoot, "config", "workflow-mappings.json");
export const seedancePromptWorkflowPath =
  process.env.SEEDANCE_PROMPT_WORKFLOW_PATH ??
  path.join(workspaceRoot, "workflow", "prompt_generation", "Seedance_prompt_generation.json");
export const seedancePromptOpenAIModel = process.env.SEEDANCE_PROMPT_OPENAI_MODEL?.trim() ?? "gpt5.5-pro";
export const klingPromptWorkflowPath =
  process.env.KLING_PROMPT_WORKFLOW_PATH ??
  path.join(workspaceRoot, "workflow", "prompt_generation", "Kling_image_to_video_prompt_generation.json");
export const klingPromptSkillPath =
  process.env.KLING_PROMPT_SKILL_PATH ??
  path.join(workspaceRoot, "workflow", "prompt_generation", "Kling_image_to_video_skill.md");
export const klingPromptOpenAIModel = process.env.KLING_PROMPT_OPENAI_MODEL?.trim() ?? "gpt5.5-pro";
export const jobsStorePath = process.env.JOBS_STORE_PATH?.trim() || path.join(backendRoot, "data", "jobs.json");
// Opt-in SQLite job store. Defaults to the JSON file store; set
// JOB_STORE_DRIVER=sqlite to use SQLite (jobs are migrated from jobs.json on
// first boot). Scoped to the main job list for now; archived items stay JSON.
export const jobStoreDriver: "json" | "sqlite" =
  (process.env.JOB_STORE_DRIVER ?? "").trim().toLowerCase() === "sqlite" ? "sqlite" : "json";
export const jobsSqlitePath = process.env.JOBS_SQLITE_PATH?.trim() || path.join(backendRoot, "data", "jobs.sqlite");
// Web/worker split, Stage A: write each job change as a single SQLite row
// instead of the debounced whole-array replaceAll. Only meaningful with the
// SQLite driver. Off by default — this is dormant prep for the topology split
// and must be load-tested before it is relied on. See docs/web-worker-split.md.
export const jobRowLevelWrites = jobStoreDriver === "sqlite"
  && ["1", "true", "yes", "on"].includes((process.env.JOBS_ROW_LEVEL_WRITES ?? "").trim().toLowerCase());
// Stage D dispatcher coordination. These defaults keep lease writes infrequent
// while ensuring a standby notices new queue work within half a second.
export const dispatcherPollIntervalMs = positiveNumber(process.env.DISPATCHER_POLL_INTERVAL_MS, 350);
export const dispatcherLeaseTtlMs = positiveNumber(process.env.DISPATCHER_LEASE_TTL_MS, 15_000);
export const dispatcherLeaseHeartbeatMs = Math.min(
  positiveNumber(process.env.DISPATCHER_LEASE_HEARTBEAT_MS, 5_000),
  Math.max(100, Math.floor(dispatcherLeaseTtlMs / 2)),
);
export const dispatcherWalCheckpointMs = process.env.DISPATCHER_WAL_CHECKPOINT_MS?.trim() === "0"
  ? 0
  : positiveNumber(process.env.DISPATCHER_WAL_CHECKPOINT_MS, 30_000);
export const archivedItemsStorePath = process.env.JOBS_ARCHIVED_PATH?.trim() || path.join(backendRoot, "data", "archived-items.json");
export const archivedItemsSqlitePath = process.env.JOBS_ARCHIVED_SQLITE_PATH?.trim() || path.join(backendRoot, "data", "archived-items.sqlite");
export const projectsStorePath = process.env.PROJECTS_STORE_PATH?.trim() || path.join(backendRoot, "data", "projects.json");
export const usersStorePath = process.env.USERS_STORE_PATH?.trim() || path.join(backendRoot, "data", "users.json");
export const sessionsStorePath = process.env.SESSIONS_STORE_PATH?.trim() || path.join(backendRoot, "data", "sessions.json");
// Shared users/sessions store for horizontally scaled API workers. JSON stays
// the default and migration source until this flag is deliberately enabled.
export const appStateDriver: "json" | "sqlite" =
  (process.env.APP_STATE_DRIVER ?? "").trim().toLowerCase() === "sqlite" ? "sqlite" : "json";
export const appStateSqlitePath = process.env.APP_STATE_SQLITE_PATH?.trim()
  || path.join(backendRoot, "data", "app-state.sqlite");
export const initialAdminPath = process.env.INITIAL_ADMIN_PATH?.trim() || path.join(backendRoot, "data", "initial-admin.txt");

export const authSessionDays = Number(process.env.AUTH_SESSION_DAYS ?? 14);
export const defaultAdminEmail = process.env.MOMI_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? "momen@brickvisual.com";
export const defaultAdminPassword = process.env.MOMI_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;

export const runpodEndpointId = process.env.RUNPOD_ENDPOINT_ID?.trim() ?? "";
export const runpodSubmissionMode: "sync" | "async" =
  (process.env.RUNPOD_SUBMISSION_MODE ?? "").trim().toLowerCase() === "async" ? "async" : "sync";
export const runpodEndpointBaseUrl =
  process.env.RUNPOD_ENDPOINT_BASE_URL?.replace(/\/$/, "") ??
  (runpodEndpointId ? `https://api.runpod.ai/v2/${runpodEndpointId}` : "");
export const runpodEndpointUrl =
  process.env.RUNPOD_ENDPOINT_URL?.replace(/\/$/, "") ??
  (runpodEndpointBaseUrl ? `${runpodEndpointBaseUrl}/${runpodSubmissionMode === "async" ? "run" : "runsync"}` : "");
export const runpodStatusUrl = (jobId: string) =>
  `${runpodEndpointBaseUrl}/status/${encodeURIComponent(jobId)}`;
export const runpodCancelUrl = (jobId: string) =>
  `${runpodEndpointBaseUrl}/cancel/${encodeURIComponent(jobId)}`;
export const runpodHealthUrl = runpodEndpointBaseUrl ? `${runpodEndpointBaseUrl}/health` : "";
export const runpodApiKey = process.env.RUNPOD_API_KEY?.trim() ?? "";
export const comfyOrgApiKey = process.env.COMFY_ORG_API_KEY?.trim() ?? "";
export const runpodPollIntervalMs = positiveNumber(process.env.RUNPOD_POLL_INTERVAL_MS, 5000);
export const runpodTimeoutMs = positiveNumber(process.env.RUNPOD_TIMEOUT_MS, 2_400_000);
export const runpodInputBaseUrl =
  (process.env.RUNPOD_INPUT_BASE_URL ?? process.env.PUBLIC_API_BASE_URL ?? "").trim().replace(/\/$/, "");
export const runpodInputTokenSecret = (process.env.RUNPOD_INPUT_URL_SECRET ?? runpodApiKey).trim();
export const runpodInputUrlTtlMs = positiveNumber(process.env.RUNPOD_INPUT_URL_TTL_MS, runpodTimeoutMs + 15 * 60_000);
export const runpodInlineMediaMaxBytes = positiveNumber(process.env.RUNPOD_INLINE_MEDIA_MAX_BYTES, 12 * 1024 * 1024);
export const runpodRequestBodyMaxBytes = positiveNumber(process.env.RUNPOD_REQUEST_BODY_MAX_BYTES, 19 * 1024 * 1024);
export const runpodInlineImageAutoCompress = !["0", "false", "no", "off"].includes(
  String(process.env.RUNPOD_INLINE_IMAGE_AUTO_COMPRESS ?? "true").trim().toLowerCase(),
);
export const runpodInlineImageMaxDimension = positiveNumber(process.env.RUNPOD_INLINE_IMAGE_MAX_DIMENSION, 4096);
export const runpodInlineImageMinQuality = boundedNumber(process.env.RUNPOD_INLINE_IMAGE_MIN_QUALITY, 55, 20, 95);
export const runpodOutputMaxBytes = positiveNumber(process.env.RUNPOD_OUTPUT_MAX_BYTES, 1024 * 1024 * 1024);
export const runpodTextOutputMaxBytes = Math.max(1024, positiveNumber(process.env.RUNPOD_TEXT_OUTPUT_MAX_BYTES, 1024 * 1024));
// Retries downloading completed results whose media is still on a remote URL
// (e.g. after a failed persist). "0" disables the periodic pass.
export const resultRecoveryIntervalMs = process.env.RESULT_RECOVERY_INTERVAL_MS?.trim() === "0"
  ? 0
  : positiveNumber(process.env.RESULT_RECOVERY_INTERVAL_MS, 10 * 60 * 1000);
export const runpodDebug = ["1", "true", "yes", "on"].includes(String(process.env.RUNPOD_DEBUG ?? "").trim().toLowerCase());
export const creditBalanceDeltaAccountingEnabled = ["1", "true", "yes", "on", "exclusive"].includes(
  String(process.env.CREDIT_BALANCE_DELTA_ACCOUNTING ?? "").trim().toLowerCase(),
);
export const mediaUploadMaxBytes = positiveNumber(process.env.MEDIA_UPLOAD_MAX_BYTES, 1024 * 1024 * 1024);
export const jsonBodyLimit = process.env.JSON_BODY_LIMIT ?? "15mb";
export const memoryLogIntervalMs = positiveNumber(process.env.MEMORY_LOG_INTERVAL_MS, 15_000);
export const mediaIndexRefreshMs = positiveNumber(process.env.MEDIA_INDEX_REFRESH_MS, 500);

export function validateRuntimeConfigForStartup() {
  if (backendProcessRole !== "monolith" && !jobRowLevelWrites) {
    throw new Error("ROLE=dispatcher/api requires JOB_STORE_DRIVER=sqlite and JOBS_ROW_LEVEL_WRITES=true.");
  }
  if (backendProcessRole !== "monolith" && appStateDriver !== "sqlite") {
    throw new Error("ROLE=dispatcher/api requires APP_STATE_DRIVER=sqlite for shared app state and media indexing.");
  }
  if (backendProcessRole !== "monolith" && generationBackend === "local_comfy") {
    throw new Error("ROLE=dispatcher/api does not support GENERATION_BACKEND=local_comfy until Comfy ownership is shared.");
  }
  if (backendProcessRole !== "monolith" && creditBalanceDeltaAccountingEnabled) {
    throw new Error("ROLE=dispatcher/api requires CREDIT_BALANCE_DELTA_ACCOUNTING to remain disabled.");
  }
  if (backendProcessRole !== "monolith" && generationBackend === "runpod" && runpodSubmissionMode !== "async") {
    throw new Error("ROLE=dispatcher/api requires RUNPOD_SUBMISSION_MODE=async so acknowledged RunPod jobs can resume after dispatcher failover.");
  }
  if (generationBackend !== "runpod") return;
  const missing = missingRunpodEnvVars();
  if (!missing.length) return;

  const message = `RunPod serverless generation is missing required env vars: ${missing.join(", ")}.`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.warn(`${message} Jobs will fail until these are configured.`);
}

export function assertRunpodConfig() {
  const missing = missingRunpodEnvVars();
  if (missing.length) {
    throw new BackendHttpError(`RunPod serverless generation is not configured. Missing env vars: ${missing.join(", ")}.`, {
      statusCode: 500,
      code: "runpod_not_configured",
    });
  }
}

function missingRunpodEnvVars() {
  return [
    ["RUNPOD_ENDPOINT_ID", runpodEndpointId],
    ["RUNPOD_API_KEY", runpodApiKey],
    ["COMFY_ORG_API_KEY", comfyOrgApiKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = positiveNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}
