const splitTopology = ["1", "true", "yes", "on"].includes(
  String(process.env.MOMI_TOPOLOGY_SPLIT || "")
    .trim()
    .toLowerCase(),
);
const sharedStateEnabled =
  splitTopology ||
  ["1", "true", "yes", "on"].includes(
    String(process.env.MOMI_SHARED_STATE || "")
      .trim()
      .toLowerCase(),
  );

const commonEnv = {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  JSON_BODY_LIMIT: "15mb",
  RUNPOD_MAX_CONCURRENT_JOBS: process.env.RUNPOD_MAX_CONCURRENT_JOBS || "10",
  MEDIA_SCAN_CACHE_MS: "60000",
  MEDIA_UPLOAD_MAX_BYTES: String(1024 * 1024 * 1024),
  RUNPOD_OUTPUT_MAX_BYTES: String(1024 * 1024 * 1024),
  JOB_STORE_DRIVER: "sqlite",
  UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || "12",
  // Observability: optional outbound alert webhook (empty = structured logs only).
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || "",
  ALERT_WEBHOOK_FORMAT: process.env.ALERT_WEBHOOK_FORMAT || "json",
  // SQLite DR backups (dispatcher/monolith only; see config.ts). Off by
  // default. BACKUP_AZURE_SAS_URL is a secret -- set it in the shell
  // environment before starting pm2, never commit it here.
  SQLITE_BACKUP_ENABLED: process.env.SQLITE_BACKUP_ENABLED || "false",
  SQLITE_BACKUP_INTERVAL_MS: process.env.SQLITE_BACKUP_INTERVAL_MS || "3600000",
  SQLITE_BACKUP_RETENTION_COUNT: process.env.SQLITE_BACKUP_RETENTION_COUNT || "48",
  SQLITE_BACKUP_STAGING_DIR: process.env.SQLITE_BACKUP_STAGING_DIR || "",
  BACKUP_AZURE_SAS_URL: process.env.BACKUP_AZURE_SAS_URL || "",
  BACKUP_AZURE_PREFIX: process.env.BACKUP_AZURE_PREFIX || "momi-backend",
  AZCOPY_PATH: process.env.AZCOPY_PATH || "azcopy",
  MEDIA_BACKUP_ENABLED: process.env.MEDIA_BACKUP_ENABLED || "true",
  // Still Images preset pods (dispatcher/monolith only; see runpodEndpoints.ts).
  // Each preset runs on its own RunPod endpoint, and a job whose endpoint is
  // unset is refused at dispatch rather than falling back to the Animation
  // endpoint, where the graph would fail on its first loader node.
  //
  // Declared here rather than left to the environment because pm2 restarts
  // inherit the *daemon's* environment, captured when the daemon started -- so a
  // variable set after that never reaches the process, even with --update-env.
  // Listing it makes the pm2 CLI read it from the launching shell instead.
  // These are endpoint identifiers, not credentials.
  RUNPOD_ENDPOINT_ID_GENERAL_ENHANCEMENT: process.env.RUNPOD_ENDPOINT_ID_GENERAL_ENHANCEMENT || "",
  RUNPOD_ENDPOINT_ID_PRO_UPSCALER: process.env.RUNPOD_ENDPOINT_ID_PRO_UPSCALER || "",
  RUNPOD_ENDPOINT_ID_REFERENCE_GENERATOR: process.env.RUNPOD_ENDPOINT_ID_REFERENCE_GENERATOR || "",
  RUNPOD_ENDPOINT_ID_QWEN_EDIT: process.env.RUNPOD_ENDPOINT_ID_QWEN_EDIT || "",
};

const processSafety = {
  autorestart: true,
  restart_delay: 5000,
  // Give the graceful-shutdown handler time to drain in-flight RunPod jobs
  // and flush job state before PM2 sends SIGKILL (default is only 1600ms).
  kill_timeout: 32000,
  max_memory_restart: "1500M",
};

const sharedStateEnv = {
  ...commonEnv,
  JOBS_ROW_LEVEL_WRITES: "true",
  APP_STATE_DRIVER: "sqlite",
  // Async submission returns the RunPod job ID immediately. The dispatcher
  // persists that ID before polling so a lease successor resumes instead of
  // submitting the paid workflow again.
  RUNPOD_SUBMISSION_MODE: "async",
  CREDIT_BALANCE_DELTA_ACCOUNTING: "false",
};

const monolith = {
  name: "momi-backend",
  cwd: "C:/Momi-Animation/backend",
  script: "dist/index.js",
  instances: 1,
  exec_mode: "fork",
  ...processSafety,
  env: {
    ...(sharedStateEnabled ? sharedStateEnv : commonEnv),
    ROLE: "monolith",
    PORT: "3333",
  },
};

const dispatcher = {
  name: "momi-dispatcher",
  cwd: "C:/Momi-Animation/backend",
  script: "dist/index.js",
  instances: 1,
  exec_mode: "fork",
  ...processSafety,
  env: {
    ...sharedStateEnv,
    ROLE: "dispatcher",
    // Internal health/admin port; client traffic remains on the API cluster.
    PORT: process.env.MOMI_DISPATCHER_PORT || "3334",
    // Defaults to loopback like everything else. Only override this
    // (e.g. "0.0.0.0") if you specifically want the ops dashboard/health/metrics
    // reachable from the LAN. Those routes are behind requireOpsAccess, which
    // trusts loopback and otherwise demands OPS_ACCESS_TOKEN -- so widening this
    // without also setting a token just makes them answer 403 from the LAN.
    HOST: process.env.MOMI_DISPATCHER_HOST || "127.0.0.1",
  },
};

const api = {
  name: "momi-api",
  cwd: "C:/Momi-Animation/backend",
  script: "dist/index.js",
  instances: Math.max(2, Math.floor(Number(process.env.MOMI_API_INSTANCES || 2) || 2)),
  exec_mode: "cluster",
  ...processSafety,
  env: {
    ...sharedStateEnv,
    ROLE: "api",
    PORT: "3333",
  },
};

const web = {
  name: "momi-web",
  cwd: "C:/Momi-Animation/backend",
  script: "dist/frontendServer.js",
  instances: 1,
  exec_mode: "fork",
  ...processSafety,
  env: {
    NODE_ENV: "production",
    FRONTEND_HOST: process.env.FRONTEND_HOST || "0.0.0.0",
    FRONTEND_PORT: process.env.FRONTEND_PORT || "8190",
    FRONTEND_DIST_PATH: process.env.FRONTEND_DIST_PATH || "C:/Momi-Animation/dist",
    // The public gateway is the only process exposed to the LAN. API workers
    // remain loopback-bound, and the gateway refuses the ops-only routes.
    FRONTEND_API_TARGET: process.env.FRONTEND_API_TARGET || "http://127.0.0.1:3333",
  },
};

// Production stays on the existing monolith until the environment flag is
// explicitly enabled. PM2 does not remove apps omitted by a new config, so use
// the documented flip/rollback commands when changing this flag.
module.exports = {
  apps: splitTopology ? [dispatcher, api, web] : [monolith, web],
};
