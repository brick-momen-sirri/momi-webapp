// Application wiring and process lifecycle. Everything that answers a request
// lives in routes/ and the service modules alongside this file.
//
// This file used to be ~2,500 lines with roughly 70 route handlers and 60 helper
// functions inline. What it keeps now is the part that genuinely belongs here:
// building the express app, the middleware order, mounting the routers, the
// error handler, and boot()/shutdown.
//
// Mount order is a correctness constraint, not formatting -- see the comments
// around the router mounts below before moving anything.

import cors from "cors";
import express from "express";

import { backendProcessRole, isDispatcher } from "./processRole.js";
import { startStorageCanary } from "./storageCanaryService.js";

import { createHealthWatchdog } from "./healthWatchdog.js";
import { backupMediaViaAzcopy, startScheduledBackups, uploadViaAzcopy } from "./sqliteBackupService.js";
import { prunePlayableVideoCache } from "./playableVideoService.js";
import { pruneThumbnailCache } from "./thumbnailService.js";

import {
  generationBackend,
  HOST,
  jsonBodyLimit,
  localComfyEnabled,
  memoryLogIntervalMs,
  resultRecoveryIntervalMs,
  PORT,
  thumbnailPruneIntervalMs,
  validateRuntimeConfigForStartup,
  watchdogIntervalMs,
  watchdogQueueStallEvals,
  watchdogDiskFreeMinBytes,
  watchdogMemoryHighMiB,
  alertWebhookUrl,
  alertWebhookFormat,
  storageCanaryIntervalMs,
  brickProjectsRoot,
  backupEnabled,
  backupIntervalMs,
  backupRetentionCount,
  backupStagingDir,
  backupAzureSasUrl,
  backupAzurePrefix,
  backupMirrorDir,
  backupMirrorRetentionCount,
  azcopyPath,
  mediaBackupEnabled,
  localProjectsRoot,
  jobsSqlitePath,
  archivedItemsSqlitePath,
  appStateSqlitePath,
  jobStoreDriver,
  appStateDriver,
  corsAllowedOrigins,
  corsAllowPrivateOrigins,
} from "./config.js";
import { closeAuthStore, loadAuthData } from "./authService.js";
import { requireAuth, resolveMediaAccessToken } from "./authMiddleware.js";

import { isOriginAllowed } from "./corsOrigin.js";

import { refreshServers } from "./comfyPool.js";

import {
  activeRunpodJobCount,
  closeJobStore,
  flushPersistedJobs,
  loadJobs,
  pauseJobDispatch,
  recoverRemoteResultMedia,
  scheduleRemoteResultRecovery,
} from "./jobQueue.js";
import { closeProjectStore, loadProjects } from "./projectService.js";

import { loadWorkflowModels } from "./workflowService.js";

import { assertMetadataHealth } from "./metadataHealthService.js";
import { logMemory, startMemoryLogging } from "./memoryLogger.js";
import { closeMediaIndex, initializeMediaIndex } from "./mediaService.js";

import { buildObservabilitySnapshot } from "./observabilitySnapshot.js";
import { opsRouter } from "./routes/opsRoutes.js";
import { runpodInputRouter } from "./routes/runpodInputRoutes.js";
import { authPublicRouter } from "./routes/authPublicRoutes.js";
import { authSessionRouter } from "./routes/authSessionRoutes.js";
import { runtimeRouter } from "./routes/runtimeRoutes.js";
import { userRouter } from "./routes/userRoutes.js";
import { comfyRouter } from "./routes/comfyRoutes.js";
import { projectRouter } from "./routes/projectRoutes.js";
import { creditRouter } from "./routes/creditRoutes.js";
import { promptRouter } from "./routes/promptRoutes.js";
import { mediaRouter } from "./routes/mediaRoutes.js";
import { jobRouter } from "./routes/jobRoutes.js";
import { createRequestObservability } from "./requestObservability.js";

const app = express();
app.use(createRequestObservability());

// Pinned rather than reflect-any-origin. The frontend reaches the API through
// the Vite /api proxy (same-origin, CORS never consulted), so this only governs
// direct cross-origin callers -- see corsOrigin.ts for the decision order.
const corsOriginPolicy = { allowedOrigins: corsAllowedOrigins, allowPrivateOrigins: corsAllowPrivateOrigins };
app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin, corsOriginPolicy)),
    credentials: true,
    exposedHeaders: ["X-Request-ID"],
  }),
);
app.use(express.json({ limit: jsonBodyLimit }));

// --- Routes -------------------------------------------------------------
// Mount order is the middleware contract, not a style choice. These three go
// above the session middleware: the ops surface has its own guard, RunPod input
// links carry their own signed token, and sign-in obviously cannot require a
// session.
app.use(opsRouter);
app.use(runpodInputRouter);
app.use(authPublicRouter);

// Must precede requireAuth: it resolves the media-only query token on media read
// paths so those requests arrive already authenticated. Everything else still has
// to present a session in a header or cookie.
app.use(resolveMediaAccessToken);
app.use(requireAuth);

// Everything below here has an authenticated user on the request.
app.use(authSessionRouter);
app.use(runtimeRouter);
app.use(userRouter);
app.use(comfyRouter);
app.use(projectRouter);
app.use(creditRouter);
app.use(promptRouter);
app.use(mediaRouter);
app.use(jobRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
    requestId: res.locals.requestId,
  });
});

async function boot() {
  validateRuntimeConfigForStartup();
  if (isDispatcher()) startMemoryLogging(memoryLogIntervalMs);
  // Health watchdog: the dispatcher/monolith judges dispatch stalls; the
  // lowest-id API worker watches for a dead dispatcher lease (a dispatcher
  // cannot alert on its own death). Other API workers stay quiet to avoid N
  // duplicate pages. Runs on a self-unref'd timer so it never blocks shutdown.
  const isDesignatedApiWatcher = backendProcessRole === "api" && (process.env.NODE_APP_INSTANCE ?? "0") === "0";
  if (backendProcessRole !== "api" || isDesignatedApiWatcher) {
    createHealthWatchdog({
      getSnapshot: buildObservabilitySnapshot,
      thresholds: {
        queueStallEvals: watchdogQueueStallEvals,
        diskFreeMinBytes: watchdogDiskFreeMinBytes,
        memoryHighMiB: watchdogMemoryHighMiB,
      },
      flags: {
        evaluatesQueueStall: backendProcessRole !== "api",
        evaluatesOutage: backendProcessRole === "api",
      },
      intervalMs: watchdogIntervalMs,
      webhookUrl: alertWebhookUrl || undefined,
      webhookFormat: alertWebhookFormat,
    }).start();
  }
  logMemory("boot-start");
  // Auth and projects share app-state.sqlite. Initialize its auth schema and
  // one-time migration before opening the project connection.
  await loadAuthData();
  await Promise.all([
    loadWorkflowModels(),
    loadProjects(),
    isDispatcher() && localComfyEnabled ? refreshServers() : Promise.resolve([]),
  ]);
  // Dispatcher startup may immediately resume acknowledged RunPod jobs. Load
  // shared projects and workflows first so those runners cannot observe an
  // empty project/model cache during lease takeover.
  await loadJobs();
  await initializeMediaIndex();
  // SQLite DR backups: dispatcher/monolith only. Running this on every API
  // worker too would multiply backup cycles by instance count for no benefit
  // (they'd all snapshot the same shared databases) and race on the same
  // staging directory and offsite prefix. Started only after the stores above
  // are loaded/migrated, so a fresh environment's first boot can't fire a
  // spurious "database missing" alert before migration has even run. Each
  // target is gated on the driver actually being sqlite (not just "the flag is
  // on"), since e.g. a monolith without MOMI_SHARED_STATE never creates
  // app-state.sqlite at all.
  if (isDispatcher() && backupEnabled) {
    const backupTargets = [
      ...(jobStoreDriver === "sqlite"
        ? [
            { name: "jobs", sourcePath: jobsSqlitePath },
            { name: "archived-items", sourcePath: archivedItemsSqlitePath },
          ]
        : []),
      ...(appStateDriver === "sqlite" ? [{ name: "app-state", sourcePath: appStateSqlitePath }] : []),
    ];
    if (backupTargets.length) {
      startScheduledBackups({
        targets: backupTargets,
        stagingDir: backupStagingDir,
        retention: backupRetentionCount,
        intervalMs: backupIntervalMs,
        uploader: backupAzureSasUrl
          ? (files) => uploadViaAzcopy(files, backupAzureSasUrl, backupAzurePrefix, azcopyPath)
          : undefined,
        mediaUploader:
          backupAzureSasUrl && mediaBackupEnabled
            ? () =>
                backupMediaViaAzcopy({
                  sourceDir: localProjectsRoot,
                  stagingDir: backupStagingDir,
                  sasUrl: backupAzureSasUrl,
                  prefix: backupAzurePrefix,
                  azcopyPath,
                  role: backendProcessRole,
                })
            : undefined,
        mediaSourceDir: localProjectsRoot,
        mirrorDir: backupMirrorDir || undefined,
        mirrorRetention: backupMirrorRetentionCount,
        role: backendProcessRole,
        webhookUrl: alertWebhookUrl || undefined,
        webhookFormat: alertWebhookFormat,
      });
    } else {
      console.warn(
        `SQLITE_BACKUP_ENABLED is set but no target uses the sqlite driver (JOB_STORE_DRIVER=${jobStoreDriver}, APP_STATE_DRIVER=${appStateDriver}); no backups will run.`,
      );
    }
  }
  const server = app.listen(PORT, HOST, () => {
    console.log(`Momi backend listening on http://${HOST}:${PORT}`);
    console.log(`Process role: ${backendProcessRole}`);
    console.log(`Generation backend: ${generationBackend}`);
    logMemory("boot-listening");
  });

  installGracefulShutdown(server);

  // Deliberately after listen(). This reads every project's manifest.jsonl, and
  // since render output moved to the SMB share that is 100 files / ~20 MB of
  // network reads -- it was pushing API boot to ~90 s while the port stayed
  // closed. It asserts that metadata is well-formed; it is not a precondition
  // for serving, so a corrupt manifest should surface as a loud error rather
  // than an invisible startup stall. Failures are logged, not thrown, because
  // rejecting here would take down a process that is already serving traffic.
  void assertMetadataHealth().catch((error) => {
    console.error(`Metadata health check failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Dispatcher-only: one probe per interval is enough to know the share is
  // alive, and running it on every API worker would multiply identical writes
  // and duplicate every alert by instance count.
  if (isDispatcher() && storageCanaryIntervalMs > 0) {
    startStorageCanary({
      root: brickProjectsRoot,
      intervalMs: storageCanaryIntervalMs,
      webhookUrl: alertWebhookUrl || undefined,
      webhookFormat: alertWebhookFormat,
    });
  }

  if (isDispatcher() && resultRecoveryIntervalMs > 0) {
    // Re-download completed results that are still remote-only (failed or
    // skipped persists) while their signed URLs are valid: once shortly after
    // boot, then periodically.
    scheduleRemoteResultRecovery(30_000);
    setInterval(() => {
      void recoverRemoteResultMedia().catch(() => undefined);
    }, resultRecoveryIntervalMs).unref();
  }

  // Keep the thumbnail cache inside its disk budget. Dispatcher-only so the two
  // API workers do not race each other deleting the same entries; any worker's
  // renditions are pruned all the same since the cache is one shared directory.
  if (isDispatcher() && thumbnailPruneIntervalMs > 0) {
    setInterval(() => {
      void pruneThumbnailCache()
        .then((result) => {
          if (result.deletedFiles > 0) {
            console.log(
              `Pruned thumbnail cache: removed ${result.deletedFiles} renditions (${Math.round(result.deletedBytes / 1048576)} MiB).`,
            );
          }
        })
        .catch(() => undefined);
      // Same timer, separate budget: one video rendition outweighs a thousand
      // WebPs, so a shared budget would let a few 4K proxies evict the whole
      // image cache.
      void prunePlayableVideoCache()
        .then((result) => {
          if (result.deletedFiles > 0) {
            console.log(
              `Pruned playable video cache: removed ${result.deletedFiles} renditions (${Math.round(result.deletedBytes / 1048576)} MiB).`,
            );
          }
        })
        .catch(() => undefined);
    }, thumbnailPruneIntervalMs).unref();
  }
}

let shuttingDown = false;

function installGracefulShutdown(server: import("node:http").Server) {
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    // Stop pulling new queued jobs into the dispatchers, and stop accepting new
    // HTTP connections; in-flight requests and RunPod jobs keep running.
    pauseJobDispatch();
    server.close(() => console.log("HTTP server closed."));

    const deadline = Date.now() + 25_000;
    const finish = async () => {
      while (activeRunpodJobCount() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        await flushPersistedJobs();
        closeJobStore();
        closeAuthStore();
        closeProjectStore();
        closeMediaIndex();
        console.log("Pending job state flushed.");
      } catch (error) {
        console.error("Failed to flush job state on shutdown:", error);
      }
      process.exit(0);
    };
    void finish();

    // Hard cap so a stuck job can't block the process forever.
    setTimeout(() => {
      console.warn("Graceful shutdown timed out; forcing exit.");
      process.exit(0);
    }, 30_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void boot().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
