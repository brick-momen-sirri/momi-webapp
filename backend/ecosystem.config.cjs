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
  // Render output lives on the ai-data$ SMB share, not local disk. Addressed by
  // UNC on purpose: there is no mapped drive, and a drive letter would only
  // exist inside an interactive logon. Auth is the svc_momi_storage credential
  // in Credential Manager under BRICK\momen.sirri -- pm2 runs in that user's
  // session, so UNC access is automatic. Nothing here is a secret.
  // Migrated 2026-09-01 (150.6 GB, 37,035 files); the C: original was left in
  // place as the rollback copy. See backend/scripts/migrateOutputRoot.mjs.
  BRICK_PROJECTS_ROOT: process.env.BRICK_PROJECTS_ROOT || "\\\\10.101.41.11\\ai-data$\\Momi\\projects",
  // Uploads followed on 2026-09-01. Only _uploads moved -- LOCAL_PROJECTS_ROOT
  // itself stays on C:, so this must be set explicitly rather than inherited.
  // Note the C: tree was hardlink-deduped in place (846 paths / 326 content
  // groups); SMB does not carry hardlinks across, so the share holds the full
  // logical 12.65 GB rather than the deduped ~9.6 GB. Nothing depends on that
  // sharing -- the app never calls fs.link, the dedup was a one-off space pass.
  UPLOADED_MEDIA_ROOT: process.env.UPLOADED_MEDIA_ROOT || "\\\\10.101.41.11\\ai-data$\\Momi\\_uploads",
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
  // Second offsite leg for the database snapshots: a filesystem/UNC path whose
  // failure is uncorrelated with the Azure account. Empty disables it. Like its
  // siblings above it is always defined here, so a value in .env would be
  // discarded (src/env.ts only fills keys absent from process.env) -- set it at
  // User scope. See backend/docs/sqlite-dr-runbook.md.
  BACKUP_MIRROR_DIR: process.env.BACKUP_MIRROR_DIR || "",
  BACKUP_MIRROR_RETENTION_COUNT: process.env.BACKUP_MIRROR_RETENTION_COUNT || "",
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
  // Optional per-GPU rate overrides for pricing a Still Images run, as
  // `gpuTypeId=usdPerSecond` pairs separated by semicolons (see podRuntimeCost.ts).
  //
  // Not required: the rates that ship in the code were measured from this account's
  // own invoices via /v1/billing/endpoints, and a GPU absent from both stays
  // uncosted rather than being priced from a neighbour's rate. Set this to correct a
  // repricing, or to price a GPU an endpoint has newly started scheduling onto,
  // without waiting for a deploy. Example:
  //   RUNPOD_GPU_USD_PER_SECOND="NVIDIA GeForce RTX 5090=0.0004174;NVIDIA A40=0.0003221"
  //
  // Re-derive rather than guess: the billing API reports amount and timeBilledMs
  // grouped by gpuTypeId, and their ratio is the rate that was actually charged.
  RUNPOD_GPU_USD_PER_SECOND: process.env.RUNPOD_GPU_USD_PER_SECOND || "",
};

const processSafety = {
  autorestart: true,
  restart_delay: 5000,
  // A rolling reload must wait for the new worker to actually accept
  // connections, not merely to spawn. PM2 marks a process "online" the moment
  // it forks, so on 2026-09-01 a `pm2 reload` killed the old momi-api three
  // seconds after spawning its replacement -- while that replacement was still
  // ~40 s from binding -- and users got ECONNREFUSED for the gap. The app now
  // calls process.send("ready") right after listen(); wait_ready makes PM2 hold
  // the old worker until then. listen_timeout is the backstop if "ready" never
  // arrives, and is deliberately well above a cold boot that has to touch the
  // SMB share.
  wait_ready: true,
  listen_timeout: 120000,
  // Give the graceful-shutdown handler time to drain in-flight RunPod jobs
  // and flush job state before PM2 sends SIGKILL (default is only 1600ms).
  kill_timeout: 32000,
  max_memory_restart: "1500M",
  // Diagnostic reports, because this deployment dies without leaving evidence.
  //
  // Six processes have exited with 3221226505 (0xC0000409, the Windows fail-fast
  // code) since 2026-07-14 -- momi-backend twice, momi-web once, momi-dispatcher
  // three times, the last two on 2026-08-17. Every one of them left nothing to
  // work from: no JS stack in the pm2 error log, no Application event, no WER
  // dump. PM2 restarted each within seconds, which is why six went unnoticed.
  //
  // Be clear about what this does and does not buy. Measured on this host with
  // these flags: a V8 fatal error (heap exhaustion) writes a report, an uncaught
  // exception writes a report, and process.abort() writes nothing. None of the
  // three reproduces 3221226505 -- they exit 134, 1 and 134. Since stderr does
  // reach the pm2 error log and a V8 fatal error prints a long stack there, the
  // silence at both crashes is evidence that the real fault is a native or CRT
  // fail-fast below the JS layer, which is exactly the path the reporter cannot
  // hook. So these flags are cheap coverage for the failure modes they do catch,
  // not a fix for the one being hunted. Catching that needs a post-mortem native
  // dump: WER LocalDumps for node.exe, which is an HKLM change made by hand.
  //
  // Reports are a few hundred KB and only on a crash. Reading one:
  // report.<date>.<time>.<pid>.0.001.json in the directory below, where
  // "header.trigger" says which flag fired and javascriptStack/nativeStack say
  // where.
  node_args: [
    "--report-on-fatalerror",
    "--report-uncaught-exception",
    "--report-directory=C:/Momi-Animation/backend/diagnostic-reports",
  ],
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
