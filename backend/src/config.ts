import "./env.js";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BackendHttpError } from "./httpError.js";
import { backendProcessRole } from "./processRole.js";
import { STILL_IMAGE_CATEGORY_IDS } from "./stillImageCategories.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendRoot = path.resolve(here, "..");
export const workspaceRoot = path.resolve(backendRoot, "..");

export const PORT = Number(process.env.PORT ?? 3333);
export const HOST = process.env.HOST ?? "127.0.0.1";

export const comfyServers = (
  process.env.COMFY_SERVERS?.split(",")
    .map((url) => url.trim())
    .filter(Boolean) ?? [...Array.from({ length: 20 }, (_, index) => `http://127.0.0.1:${8201 + index}`)]
).map((url) => url.replace(/\/$/, ""));

export const comfyRoot = process.env.COMFY_ROOT ?? "C:\\ComfyUI_windows_portable_nvidia_cu128\\ComfyUI_windows_portable\\ComfyUI";
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
  ? process.env.WORKFLOW_ROOTS.split(";")
      .map((item) => item.trim())
      .filter(Boolean)
  : localComfyEnabled
    ? legacyComfyWorkflowRoots
    : [serverlessWorkflowRoot];

// Still image graphs live outside the scanned workflow roots on purpose.
// loadWorkflowModels recurses whatever is under workflowRoots and turns every
// JSON into a selectable model, so a subfolder of workflow/ would put four
// local-GPU preset graphs in the Animation model picker. Presets are addressed by
// name from the registry instead of being discovered.
export const stillImageWorkflowRoot = process.env.STILL_IMAGE_WORKFLOW_ROOT ?? path.join(backendRoot, "workflow-still-images");

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
export const jobRowLevelWrites =
  jobStoreDriver === "sqlite" &&
  ["1", "true", "yes", "on"].includes((process.env.JOBS_ROW_LEVEL_WRITES ?? "").trim().toLowerCase());
// Stage D dispatcher coordination. These defaults keep lease writes infrequent
// while ensuring a standby notices new queue work within half a second.
export const dispatcherPollIntervalMs = positiveNumber(process.env.DISPATCHER_POLL_INTERVAL_MS, 350);
export const dispatcherLeaseTtlMs = positiveNumber(process.env.DISPATCHER_LEASE_TTL_MS, 15_000);
export const dispatcherLeaseHeartbeatMs = Math.min(
  positiveNumber(process.env.DISPATCHER_LEASE_HEARTBEAT_MS, 5_000),
  Math.max(100, Math.floor(dispatcherLeaseTtlMs / 2)),
);
export const dispatcherWalCheckpointMs =
  process.env.DISPATCHER_WAL_CHECKPOINT_MS?.trim() === "0" ? 0 : positiveNumber(process.env.DISPATCHER_WAL_CHECKPOINT_MS, 30_000);
export const archivedItemsStorePath =
  process.env.JOBS_ARCHIVED_PATH?.trim() || path.join(backendRoot, "data", "archived-items.json");
export const archivedItemsSqlitePath =
  process.env.JOBS_ARCHIVED_SQLITE_PATH?.trim() || path.join(backendRoot, "data", "archived-items.sqlite");
export const projectsStorePath = process.env.PROJECTS_STORE_PATH?.trim() || path.join(backendRoot, "data", "projects.json");
export const usersStorePath = process.env.USERS_STORE_PATH?.trim() || path.join(backendRoot, "data", "users.json");
export const sessionsStorePath = process.env.SESSIONS_STORE_PATH?.trim() || path.join(backendRoot, "data", "sessions.json");
// Shared users/sessions store for horizontally scaled API workers. JSON stays
// the default and migration source until this flag is deliberately enabled.
export const appStateDriver: "json" | "sqlite" =
  (process.env.APP_STATE_DRIVER ?? "").trim().toLowerCase() === "sqlite" ? "sqlite" : "json";
export const appStateSqlitePath = process.env.APP_STATE_SQLITE_PATH?.trim() || path.join(backendRoot, "data", "app-state.sqlite");
export const initialAdminPath = process.env.INITIAL_ADMIN_PATH?.trim() || path.join(backendRoot, "data", "initial-admin.txt");

export const authSessionDays = Number(process.env.AUTH_SESSION_DAYS ?? 14);
export const defaultAdminEmail = process.env.MOMI_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? "momen@brickvisual.com";
export const defaultAdminPassword = process.env.MOMI_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;

// --- Login throttling ---
// scrypt (N=16384) makes each guess cost ~100ms of CPU, which slows an online
// attacker but does not bound them, and a burst of parallel guesses is also a
// cheap way to saturate this box's CPU. Counted per process: with api:N workers
// the effective ceiling is N x maxAttempts, which is fine for the intent here
// (stop unbounded guessing) and keeps the limiter dependency-free.
export const loginRateLimitMaxAttempts = Math.max(1, Math.floor(positiveNumber(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 10)));
export const loginRateLimitWindowMs = positiveNumber(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
export const loginRateLimitLockoutMs = positiveNumber(process.env.LOGIN_RATE_LIMIT_LOCKOUT_MS, 15 * 60 * 1000);

// --- Browser origin allowlist ---
// Comma-separated exact origins (scheme://host[:port]) that may make credentialed
// cross-origin calls. The normal frontend path is the Vite /api proxy, which is
// same-origin and never consults CORS, so this stays empty in the default setup.
// The literal "*" restores the old reflect-any-origin behaviour as an emergency
// rollback; startup warns when it is used.
export const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// Loopback and private-LAN origins on any port stay allowed by default: the app
// is opened at localhost:8190, over the LAN, and from the credit portal, and
// enumerating those ports would break the first time one moves.
export const corsAllowPrivateOrigins = !["0", "false", "no", "off"].includes(
  String(process.env.CORS_ALLOW_PRIVATE_ORIGINS ?? "true")
    .trim()
    .toLowerCase(),
);

export const runpodEndpointId = process.env.RUNPOD_ENDPOINT_ID?.trim() ?? "";
// Root for endpoints addressed by id alone (the still image pods below). The
// default endpoint keeps its own RUNPOD_ENDPOINT_BASE_URL/RUNPOD_ENDPOINT_URL
// overrides, which topologyLoadTest.ts points at a mock server.
export const runpodApiRoot = (process.env.RUNPOD_API_ROOT ?? "https://api.runpod.ai/v2").replace(/\/$/, "");
// Still image presets each run on their own RunPod endpoint, because unlike every
// Animation workflow -- which only relays to an external provider API and so needs
// nothing installed on the worker -- these execute locally on the GPU and need
// their own model weights and custom nodes present. One shared generic worker
// cannot serve them. Unset presets are refused at dispatch rather than falling
// back to the default endpoint, where the graph would fail on its first loader
// node with an error that says nothing about the real cause.
export const runpodStillImageEndpointIds: Readonly<Record<string, string>> = Object.fromEntries(
  STILL_IMAGE_CATEGORY_IDS.map((categoryId) => [
    categoryId,
    process.env[`RUNPOD_ENDPOINT_ID_${categoryId.replaceAll("-", "_").toUpperCase()}`]?.trim() ?? "",
  ]).filter(([, endpoint]) => endpoint),
);
export const runpodSubmissionMode: "sync" | "async" =
  (process.env.RUNPOD_SUBMISSION_MODE ?? "").trim().toLowerCase() === "async" ? "async" : "sync";
export const runpodEndpointBaseUrl =
  process.env.RUNPOD_ENDPOINT_BASE_URL?.replace(/\/$/, "") ??
  (runpodEndpointId ? `https://api.runpod.ai/v2/${runpodEndpointId}` : "");
export const runpodEndpointUrl =
  process.env.RUNPOD_ENDPOINT_URL?.replace(/\/$/, "") ??
  (runpodEndpointBaseUrl ? `${runpodEndpointBaseUrl}/${runpodSubmissionMode === "async" ? "run" : "runsync"}` : "");
export const runpodStatusUrl = (jobId: string) => `${runpodEndpointBaseUrl}/status/${encodeURIComponent(jobId)}`;
export const runpodCancelUrl = (jobId: string) => `${runpodEndpointBaseUrl}/cancel/${encodeURIComponent(jobId)}`;
export const runpodStreamUrl = (jobId: string) => `${runpodEndpointBaseUrl}/stream/${encodeURIComponent(jobId)}`;
export const runpodHealthUrl = runpodEndpointBaseUrl ? `${runpodEndpointBaseUrl}/health` : "";
export const runpodApiKey = process.env.RUNPOD_API_KEY?.trim() ?? "";
export const comfyOrgApiKey = process.env.COMFY_ORG_API_KEY?.trim() ?? "";
export const runpodPollIntervalMs = positiveNumber(process.env.RUNPOD_POLL_INTERVAL_MS, 5000);
export const runpodTimeoutMs = positiveNumber(process.env.RUNPOD_TIMEOUT_MS, 2_400_000);
export const runpodInputBaseUrl = (process.env.RUNPOD_INPUT_BASE_URL ?? process.env.PUBLIC_API_BASE_URL ?? "")
  .trim()
  .replace(/\/$/, "");
export const runpodInputTokenSecret = (process.env.RUNPOD_INPUT_URL_SECRET ?? runpodApiKey).trim();

// --- Media access tokens ---
// Browsers cannot put an Authorization header on <img src>, so media URLs carry
// a credential in the query string. That credential is a short-lived media-only
// token (see mediaAccessToken.ts), not the session token.
//
// The secret must be identical across every api worker and stable across
// restarts, or a token minted by one worker fails on the next request that lands
// elsewhere. Preference order:
//   1. MEDIA_ACCESS_TOKEN_SECRET, if set.
//   2. A key derived from the existing RunPod signing secret, so a correctly
//      configured production host needs no new env var. Derived through a hash
//      with a distinct label rather than used directly, so this key and the
//      RunPod input signing key cannot be interchanged.
//   3. A random per-process value, for local development with no RunPod
//      configuration at all. Media tokens then only verify on the process that
//      minted them, which is fine for a single-process monolith and is refused
//      outright for split roles in validateRuntimeConfigForStartup.
const mediaAccessTokenSecretOverride = process.env.MEDIA_ACCESS_TOKEN_SECRET?.trim() || "";
const derivedMediaAccessTokenSecret = runpodInputTokenSecret
  ? createHash("sha256").update(`momi-media-access-v1:${runpodInputTokenSecret}`).digest("hex")
  : "";
export const mediaAccessTokenSecretIsEphemeral = !mediaAccessTokenSecretOverride && !derivedMediaAccessTokenSecret;
export const mediaAccessTokenSecret =
  mediaAccessTokenSecretOverride || derivedMediaAccessTokenSecret || randomBytes(32).toString("hex");
// Kept short because these tokens are self-verifying and therefore cannot be
// revoked before they expire. The frontend refreshes well before this elapses.
export const mediaAccessTokenTtlMs = positiveNumber(process.env.MEDIA_ACCESS_TOKEN_TTL_MS, 30 * 60 * 1000);
export const runpodInputUrlTtlMs = positiveNumber(process.env.RUNPOD_INPUT_URL_TTL_MS, runpodTimeoutMs + 15 * 60_000);
export const runpodInlineMediaMaxBytes = positiveNumber(process.env.RUNPOD_INLINE_MEDIA_MAX_BYTES, 6 * 1024 * 1024);
export const runpodRequestBodyMaxBytes = positiveNumber(process.env.RUNPOD_REQUEST_BODY_MAX_BYTES, 9 * 1024 * 1024);
export const runpodInlineImageAutoCompress = !["0", "false", "no", "off"].includes(
  String(process.env.RUNPOD_INLINE_IMAGE_AUTO_COMPRESS ?? "true")
    .trim()
    .toLowerCase(),
);
export const runpodInlineImageMaxDimension = positiveNumber(process.env.RUNPOD_INLINE_IMAGE_MAX_DIMENSION, 4096);
export const runpodInlineImageMinQuality = boundedNumber(process.env.RUNPOD_INLINE_IMAGE_MIN_QUALITY, 55, 20, 95);
// The same fallback for video: without RUNPOD_INPUT_BASE_URL an oversized video
// input is re-encoded at a lower bitrate rather than failing the job outright.
// Unlike the image fallback this never changes resolution -- see
// runpodVideoInlineService.ts for why that is load-bearing.
export const runpodInlineVideoAutoCompress = !["0", "false", "no", "off"].includes(
  String(process.env.RUNPOD_INLINE_VIDEO_AUTO_COMPRESS ?? "true")
    .trim()
    .toLowerCase(),
);
// Floor for the re-encode. Below this a long clip squeezed into the inline
// budget would be too degraded to be worth the paid provider run, so the
// backend fails with the base-URL hint instead.
export const runpodInlineVideoMinBitrate = positiveNumber(process.env.RUNPOD_INLINE_VIDEO_MIN_BITRATE, 400_000);
export const runpodOutputMaxBytes = positiveNumber(process.env.RUNPOD_OUTPUT_MAX_BYTES, 1024 * 1024 * 1024);
export const runpodTextOutputMaxBytes = Math.max(1024, positiveNumber(process.env.RUNPOD_TEXT_OUTPUT_MAX_BYTES, 1024 * 1024));
// Retries downloading completed results whose media is still on a remote URL
// (e.g. after a failed persist). "0" disables the periodic pass.
export const resultRecoveryIntervalMs =
  process.env.RESULT_RECOVERY_INTERVAL_MS?.trim() === "0"
    ? 0
    : positiveNumber(process.env.RESULT_RECOVERY_INTERVAL_MS, 10 * 60 * 1000);
export const runpodDebug = ["1", "true", "yes", "on"].includes(
  String(process.env.RUNPOD_DEBUG ?? "")
    .trim()
    .toLowerCase(),
);
export const creditBalanceDeltaAccountingEnabled = ["1", "true", "yes", "on", "exclusive"].includes(
  String(process.env.CREDIT_BALANCE_DELTA_ACCOUNTING ?? "")
    .trim()
    .toLowerCase(),
);
export const mediaUploadMaxBytes = positiveNumber(process.env.MEDIA_UPLOAD_MAX_BYTES, 1024 * 1024 * 1024);
export const jsonBodyLimit = process.env.JSON_BODY_LIMIT ?? "15mb";

// --- Result thumbnails ---
// Grid and feed views ask for a downscaled WebP rendition instead of the
// full-size original (image results average ~2.8 MiB). Renditions are generated
// on demand and cached on disk keyed by source path + mtime + size, so the
// existing library is covered without a backfill pass and a re-rendered result
// invalidates itself.
export const thumbnailCacheDir = process.env.THUMBNAIL_CACHE_DIR?.trim() || path.join(backendRoot, "data", "thumbnail-cache");
// Whitelisted widths. Requests for anything else snap to the nearest allowed
// width, so an arbitrary ?w= cannot fan the cache out to unbounded variants.
export const thumbnailWidths = (
  process.env.THUMBNAIL_WIDTHS?.trim()
    ? process.env.THUMBNAIL_WIDTHS.split(",")
        .map((value) => Math.floor(Number(value.trim())))
        .filter((value) => Number.isFinite(value) && value >= 32 && value <= 4096)
    : [240, 480, 960, 1440]
).sort((left, right) => left - right);
export const thumbnailQuality = boundedNumber(process.env.THUMBNAIL_QUALITY, 72, 20, 95);
// Widths generated once, at save time, so the first person to open a project does
// not pay for decoding a 100 MB PNG. These are exactly the widths the UI asks for
// (grid cards, inline preview, fullscreen); anything else still generates on
// demand. Values outside THUMBNAIL_WIDTHS snap to an allowed width, which would
// warm a key nobody reads, so keep the two lists in step.
export const resultPreviewWidths = (
  process.env.RESULT_PREVIEW_WIDTHS?.trim()
    ? process.env.RESULT_PREVIEW_WIDTHS.split(",")
        .map((value) => Math.floor(Number(value.trim())))
        .filter((value) => Number.isFinite(value) && value >= 32 && value <= 4096)
    : [480, 960, 1440]
).sort((left, right) => left - right);
// Sharp is multithreaded internally, so keep per-process concurrency modest;
// three backend processes share the box with nothing else CPU-bound.
export const thumbnailMaxConcurrency = Math.max(1, Math.floor(positiveNumber(process.env.THUMBNAIL_MAX_CONCURRENCY, 4)));
// Sources already at or below this size are streamed as-is: no rendition can
// meaningfully beat them over the wire, and caching a copy would only add IO.
export const thumbnailPassthroughMaxBytes = positiveNumber(process.env.THUMBNAIL_PASSTHROUGH_MAX_BYTES, 96 * 1024);
// Cap on the buffer retry used when sharp cannot open a source by path (e.g. a
// path over the Windows 260-char MAX_PATH limit). Sources larger than this are
// left to fail so the route falls back to streaming the original, rather than
// reading a huge file into every concurrent encode slot.
export const thumbnailBufferRetryMaxBytes = positiveNumber(process.env.THUMBNAIL_BUFFER_RETRY_MAX_BYTES, 256 * 1024 * 1024);
// Disk budget for the cache. This host has a single volume under real space
// pressure, so the cache is pruned rather than left to grow unbounded.
export const thumbnailCacheMaxBytes = positiveNumber(process.env.THUMBNAIL_CACHE_MAX_BYTES, 8 * 1024 * 1024 * 1024);
export const thumbnailPruneIntervalMs = positiveNumber(process.env.THUMBNAIL_PRUNE_INTERVAL_MS, 6 * 60 * 60 * 1000);
// Video posters: a frame is extracted with ffmpeg, then encoded through the same
// sharp pipeline as images so both share one set of encoder settings.
export const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
// Frame 0 of a render is often black or mid fade-in, so seek in slightly first.
// Clips shorter than this yield no frame and fall back to frame 0.
export const videoPosterSeekSeconds = Math.max(0, positiveNumber(process.env.VIDEO_POSTER_SEEK_SECONDS, 1));
export const videoPosterTimeoutMs = positiveNumber(process.env.VIDEO_POSTER_TIMEOUT_MS, 20_000);
export const memoryLogIntervalMs = positiveNumber(process.env.MEMORY_LOG_INTERVAL_MS, 15_000);
export const mediaIndexRefreshMs = positiveNumber(process.env.MEDIA_INDEX_REFRESH_MS, 500);

// --- Observability / health watchdog (web/worker split) ---
// How often the dispatch/queue watchdog evaluates its rules.
export const watchdogIntervalMs = positiveNumber(process.env.WATCHDOG_INTERVAL_MS, 30_000);
// Consecutive evaluations with a non-draining backlog (queued > 0 while RunPod
// capacity is free) before we alert that dispatch is stuck. 4 × 30s ≈ 2 minutes.
export const watchdogQueueStallEvals = Math.max(1, Math.floor(positiveNumber(process.env.WATCHDOG_QUEUE_STALL_EVALS, 4)));
// Alert when free space on the output volume drops below this. Default 5 GiB.
export const watchdogDiskFreeMinBytes = positiveNumber(process.env.WATCHDOG_DISK_FREE_MIN_BYTES, 5 * 1024 * 1024 * 1024);
// Alert when a process RSS exceeds this. Default 1275 MiB ≈ 85% of the 1500M
// pm2 max_memory_restart, so we warn before pm2 force-restarts the process.
export const watchdogMemoryHighMiB = positiveNumber(process.env.WATCHDOG_MEMORY_HIGH_MIB, 1275);
// Optional outbound alert webhook. Empty = structured logs only. Format "slack"
// sends a single { text } (also works for Teams/Mattermost/Google Chat incoming
// webhooks); "json" sends the raw structured event.
export const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL?.trim() || "";
export const alertWebhookFormat: "json" | "slack" =
  process.env.ALERT_WEBHOOK_FORMAT?.trim().toLowerCase() === "slack" ? "slack" : "json";

// --- Ops surface access ---
// /metrics, /ops-dashboard, /api/health, /api/alerts/recent, /api/backup-status
// and /api/ops-config sit above requireAuth because a Prometheus scraper and the
// dashboard's first paint have no session to present. They still expose queue
// depth, RSS, disk headroom and backup state, so they get their own guard:
// loopback callers are trusted (local scrapers, the topology load test) and
// anything else must present OPS_ACCESS_TOKEN. Empty token + trusted loopback is
// the default, which is equivalent to binding the ops surface to localhost.
// If a same-host reverse proxy or tunnel fronts this backend, its requests also
// arrive from 127.0.0.1 -- set a token AND OPS_ALLOW_LOOPBACK=false in that case.
export const opsAccessToken = process.env.OPS_ACCESS_TOKEN?.trim() || "";
export const opsAllowLoopback = !["0", "false", "no", "off"].includes(
  String(process.env.OPS_ALLOW_LOOPBACK ?? "true")
    .trim()
    .toLowerCase(),
);

// --- SQLite disaster recovery ---
// This host has a single local volume, so a snapshot alone only protects
// against corruption/accidental deletion. Real DR requires shipping snapshots
// offsite; set BACKUP_AZURE_SAS_URL (a container SAS URL) to enable that leg.
// Off by default: no backups run until a driver actually needs them.
export const backupEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.SQLITE_BACKUP_ENABLED ?? "")
    .trim()
    .toLowerCase(),
);
export const backupIntervalMs = positiveNumber(process.env.SQLITE_BACKUP_INTERVAL_MS, 60 * 60 * 1000);
export const backupRetentionCount = Math.max(1, Math.floor(positiveNumber(process.env.SQLITE_BACKUP_RETENTION_COUNT, 48)));
export const backupStagingDir = process.env.SQLITE_BACKUP_STAGING_DIR?.trim() || path.join(backendRoot, "data", "backups");
// Container SAS URL, e.g. https://<account>.blob.core.windows.net/<container>?<sas>.
// Never logged. Empty = local snapshots only (no offsite leg).
export const backupAzureSasUrl = process.env.BACKUP_AZURE_SAS_URL?.trim() || "";
export const backupAzurePrefix = process.env.BACKUP_AZURE_PREFIX?.trim() || "momi-backend";
export const azcopyPath = process.env.AZCOPY_PATH?.trim() || "azcopy";
// Generated media already lives locally; when SQLite DR has an offsite Azure
// leg, include the application-managed project tree by default. Set explicitly
// false only if another system owns that directory's backup.
export const mediaBackupEnabled = !["0", "false", "no", "off"].includes(
  String(process.env.MEDIA_BACKUP_ENABLED ?? "true")
    .trim()
    .toLowerCase(),
);

export function validateRuntimeConfigForStartup() {
  if (corsAllowedOrigins.includes("*")) {
    console.warn(
      "CORS_ALLOWED_ORIGINS=* reflects any browser origin. This is an emergency rollback setting, not a configuration.",
    );
  }
  if (opsAccessToken && opsAllowLoopback) {
    console.log("Ops endpoints: loopback trusted, OPS_ACCESS_TOKEN accepted from remote callers.");
  } else if (!opsAccessToken && !opsAllowLoopback) {
    throw new Error("OPS_ALLOW_LOOPBACK=false with no OPS_ACCESS_TOKEN set would make /metrics and /ops-dashboard unreachable.");
  }
  if (backendProcessRole !== "monolith" && !jobRowLevelWrites) {
    throw new Error("ROLE=dispatcher/api requires JOB_STORE_DRIVER=sqlite and JOBS_ROW_LEVEL_WRITES=true.");
  }
  if (backendProcessRole !== "monolith" && mediaAccessTokenSecretIsEphemeral) {
    throw new Error(
      "ROLE=dispatcher/api requires MEDIA_ACCESS_TOKEN_SECRET (or a configured RunPod signing secret) so media tokens minted by one worker verify on the others.",
    );
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
    throw new Error(
      "ROLE=dispatcher/api requires RUNPOD_SUBMISSION_MODE=async so acknowledged RunPod jobs can resume after dispatcher failover.",
    );
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
