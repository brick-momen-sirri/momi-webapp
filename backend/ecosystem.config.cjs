const splitTopology = ["1", "true", "yes", "on"].includes(
  String(process.env.MOMI_TOPOLOGY_SPLIT || "").trim().toLowerCase(),
);
const sharedStateEnabled = splitTopology || ["1", "true", "yes", "on"].includes(
  String(process.env.MOMI_SHARED_STATE || "").trim().toLowerCase(),
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

// Production stays on the existing monolith until the environment flag is
// explicitly enabled. PM2 does not remove apps omitted by a new config, so use
// the documented flip/rollback commands when changing this flag.
module.exports = {
  apps: splitTopology ? [dispatcher, api] : [monolith],
};
