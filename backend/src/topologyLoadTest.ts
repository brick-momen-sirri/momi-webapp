import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, any>;

type BackendRuntime = {
  name: string;
  role: "api" | "dispatcher";
  port: number;
  child: ChildProcess;
  logs: string;
  expectedExit: boolean;
};

type MockJob = {
  id: string;
  promptKey: string;
  readyAt: number;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
};

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const adminEmail = "topology-admin@example.test";
const adminPassword = "TopologyAdmin123!";
const userEmail = "topology-user@example.test";
const userPassword = "TopologyUser123!";

class MockRunpod {
  readonly jobs = new Map<string, MockJob>();
  readonly submissionsByPrompt = new Map<string, number>();
  maxActive = 0;
  statusCalls = 0;
  syncRows = 0;
  private sequence = 0;
  private server?: http.Server;

  async listen(port: number) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "127.0.0.1", resolve);
    });
  }

  async close() {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  get submissionCount() {
    return this.jobs.size;
  }

  get duplicateSubmissionCount() {
    return [...this.submissionsByPrompt.values()].filter((count) => count > 1).length;
  }

  private activeCount() {
    return [...this.jobs.values()].filter((job) => job.status === "IN_QUEUE" || job.status === "IN_PROGRESS").length;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/v2/topology/run") {
      const body = JSON.parse(await readBody(request)) as JsonRecord;
      const promptKey = topologyPromptKey(body) ?? `payload-${this.sequence + 1}`;
      this.submissionsByPrompt.set(promptKey, (this.submissionsByPrompt.get(promptKey) ?? 0) + 1);
      const id = `mock-runpod-${String(++this.sequence).padStart(4, "0")}`;
      this.jobs.set(id, {
        id,
        promptKey,
        readyAt: Date.now() + 1_800,
        status: "IN_QUEUE",
      });
      this.maxActive = Math.max(this.maxActive, this.activeCount());
      return sendJson(response, 200, { id, status: "IN_QUEUE" });
    }

    const statusMatch = url.pathname.match(/^\/v2\/topology\/status\/([^/]+)$/);
    if (request.method === "GET" && statusMatch) {
      this.statusCalls += 1;
      const job = this.jobs.get(decodeURIComponent(statusMatch[1]));
      if (!job) return sendJson(response, 404, { error: "unknown mock job" });
      if ((job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") && Date.now() >= job.readyAt) {
        job.status = "COMPLETED";
      } else if (job.status === "IN_QUEUE") {
        job.status = "IN_PROGRESS";
      }
      if (job.status !== "COMPLETED") return sendJson(response, 200, { id: job.id, status: job.status });
      return sendJson(response, 200, {
        id: job.id,
        status: "COMPLETED",
        output: {
          images: [{ filename: `${job.id}.png`, data: tinyPng }],
          credit_usage: { total_estimated_credits: 1, source: "topology_mock" },
        },
      });
    }

    const cancelMatch = url.pathname.match(/^\/v2\/topology\/cancel\/([^/]+)$/);
    if (request.method === "POST" && cancelMatch) {
      const job = this.jobs.get(decodeURIComponent(cancelMatch[1]));
      if (!job) return sendJson(response, 404, { error: "unknown mock job" });
      job.status = "CANCELLED";
      return sendJson(response, 200, { id: job.id, status: job.status });
    }

    if (request.method === "GET" && url.pathname === "/v2/topology/health") {
      const active = this.activeCount();
      return sendJson(response, 200, {
        workers: { running: active, idle: Math.max(0, 10 - active), stopped: 0, unavailable: 0 },
        jobs: { running: active, queued: 0, completed: this.jobs.size - active },
      });
    }

    if (request.method === "GET" && url.pathname === "/credits") {
      return sendJson(response, 200, { credits: 100_000, currency: "credits", updatedAt: new Date().toISOString() });
    }

    if (request.method === "POST" && url.pathname === "/credit-tracker/api/ingest-rows") {
      const body = JSON.parse(await readBody(request)) as JsonRecord;
      const rows = Array.isArray(body.rows) ? body.rows.length : 0;
      this.syncRows += rows;
      return sendJson(response, 200, { ok: true, inserted: rows, skipped: 0 });
    }

    if (request.method === "GET" && url.pathname === "/credit-tracker/api/usage-rows") {
      return sendJson(response, 200, { rows: [] });
    }

    if (request.method === "GET" && url.pathname === "/credit-tracker/api/summary") {
      return sendJson(response, 200, { by_project: [] });
    }

    return sendJson(response, 404, { error: `Unhandled mock route: ${request.method} ${url.pathname}` });
  }
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-topology-gate-"));
  const runtimes: BackendRuntime[] = [];
  const mock = new MockRunpod();
  let polling = true;
  const pollErrors: string[] = [];
  const enqueueLatencies: number[] = [];
  const visibilityLatencies: number[] = [];
  let pollCycles = 0;
  let observedBackendActive = 0;

  try {
    const [mockPort, dispatcherPort, standbyPort, apiAPort, apiBPort] = await allocatePorts(5);
    await mock.listen(mockPort);
    const paths = await prepareIsolatedState(tempDir);
    const commonEnv = isolatedEnvironment(paths, mockPort);

    const dispatcher = startBackend("dispatcher-1", "dispatcher", dispatcherPort, commonEnv);
    runtimes.push(dispatcher);
    await waitForHealth(dispatcher);

    const apiA = startBackend("api-a", "api", apiAPort, commonEnv);
    const apiB = startBackend("api-b", "api", apiBPort, commonEnv);
    runtimes.push(apiA, apiB);
    await Promise.all([waitForHealth(apiA), waitForHealth(apiB)]);
    const apiBases = [`http://127.0.0.1:${apiAPort}`, `http://127.0.0.1:${apiBPort}`];

    const adminLogin = await jsonRequest(apiBases[0], "/api/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    });
    const adminToken = String(adminLogin.token);
    const crossWorkerAdmin = await jsonRequest(apiBases[1], "/api/auth/me", { token: adminToken });
    assert.equal(crossWorkerAdmin.user.email, adminEmail, "session created on API A must authenticate on API B");

    const createdUser = await jsonRequest(apiBases[0], "/api/users", {
      method: "POST",
      token: adminToken,
      body: { email: userEmail, name: "Topology User", password: userPassword, role: "user" },
    });
    const userLogin = await jsonRequest(apiBases[1], "/api/auth/login", {
      method: "POST",
      body: { email: userEmail, password: userPassword },
    });
    const userToken = String(userLogin.token);
    const crossWorkerUser = await jsonRequest(apiBases[0], "/api/auth/me", { token: userToken });
    assert.equal(crossWorkerUser.user.id, createdUser.user.id, "user session must work across API workers");

    const createdProject = await jsonRequest(apiBases[0], "/api/projects", {
      method: "POST",
      token: adminToken,
      body: {
        shortName: "9001",
        client: "Topology",
        name: "Gate",
        folderName: "9001_Topology_Gate",
      },
    });
    const projectId = String(createdProject.project.id);
    await jsonRequest(apiBases[1], `/api/projects/${projectId}/members`, {
      method: "POST",
      token: adminToken,
      body: { userId: createdUser.user.id, role: "editor" },
    });
    const visibleProject = await jsonRequest(apiBases[0], `/api/projects/${projectId}`, { token: userToken });
    assert.equal(visibleProject.project.id, projectId, "project ACL mutation must be visible on the other API worker");
    await jsonRequest(apiBases[0], `/api/projects/${projectId}`, {
      method: "PATCH",
      token: adminToken,
      body: { client: "Topology", name: "Gate Renamed" },
    });
    await waitUntil(async () => {
      const response = await jsonRequest(apiBases[1], `/api/projects/${projectId}`, { token: userToken });
      return response.project.name === "Gate Renamed"
        && String(response.project.folderPath).endsWith("9001_Topology_Gate_Renamed");
    }, 1_000, "project rename/path was not visible cross-worker within 1s");

    const modelResponse = await jsonRequest(apiBases[1], "/api/models", { token: userToken });
    const model = (modelResponse.models as JsonRecord[]).find((candidate) => candidate.outputType === "image" && !candidate.requiresImage);
    assert.ok(model, "isolated workflow model was not loaded");

    const pollers = Array.from({ length: 100 }, (_, index) => (async () => {
      const base = apiBases[index % apiBases.length];
      while (polling) {
        try {
          const [, snapshot] = await Promise.all([
            jsonRequest(base, "/api/jobs?limit=80", { token: userToken }),
            jsonRequest(base, "/api/snapshot", { token: userToken }),
          ]);
          pollCycles += 1;
          observedBackendActive = Math.max(observedBackendActive, Number(snapshot.podStatus?.queue?.runpodActive ?? 0));
        } catch (error) {
          pollErrors.push(error instanceof Error ? error.message : String(error));
        }
        await delay(200);
      }
    })());

    const jobCount = 32;
    const createdJobs = await Promise.all(Array.from({ length: jobCount }, async (_, index) => {
      const base = apiBases[index % apiBases.length];
      const startedAt = performance.now();
      const response = await jsonRequest(base, "/api/jobs", {
        method: "POST",
        token: userToken,
        body: {
          projectId,
          modelId: model.id,
          prompt: `topology-job-${String(index + 1).padStart(3, "0")}`,
        },
      });
      enqueueLatencies.push(performance.now() - startedAt);
      return response.job as JsonRecord;
    }));

    await Promise.all(createdJobs.map(async (job, index) => {
      const base = apiBases[(index + 1) % apiBases.length];
      const startedAt = performance.now();
      await waitUntil(async () => {
        const response = await jsonRequest(base, `/api/jobs/${job.id}`, { token: userToken, allowStatus: 404 });
        return response.statusCode !== 404;
      }, 1_000, `job ${job.id} was not visible cross-worker within 1s`);
      visibilityLatencies.push(performance.now() - startedAt);
    }));

    await waitUntil(() => mock.submissionCount >= 10, 10_000, "dispatcher did not fill the 10-job RunPod cap");
    assert.ok(mock.maxActive <= 10, `mock RunPod observed ${mock.maxActive} active submissions, above the cap`);
    await waitUntil(async () => {
      const response = await jsonRequest(apiBases[1], "/api/jobs?limit=80", { token: userToken });
      return (response.jobs as JsonRecord[]).filter((job) => job.runpodJobId).length >= 10;
    }, 5_000, "acknowledged RunPod IDs were not persisted before failover");

    // Run a deliberately competing dispatcher to exercise the lease fence.
    // It must remain passive while dispatcher-1 is alive, then take over the
    // same acknowledged RunPod IDs after the leader is force-killed.
    const dispatcherStandby = startBackend("dispatcher-standby", "dispatcher", standbyPort, commonEnv);
    runtimes.push(dispatcherStandby);
    await waitForHealth(dispatcherStandby);
    const standbyBefore = await jsonRequest(`http://127.0.0.1:${standbyPort}`, "/api/health");
    assert.equal(standbyBefore.queue?.dispatcher?.heldByThisProcess, false, "standby dispatcher must not own the live leader's lease");
    const submissionsBeforeStandby = mock.submissionCount;
    await delay(300);
    assert.equal(mock.submissionCount, submissionsBeforeStandby, "standby dispatcher submitted work without owning the lease");

    const beforeCancel = await jsonRequest(apiBases[0], "/api/jobs?limit=80", { token: userToken });
    const cancelTarget = (beforeCancel.jobs as JsonRecord[]).find((job) => job.runpodJobId && job.status === "running");
    assert.ok(cancelTarget, "expected an acknowledged active job for the cross-process cancellation check");
    await jsonRequest(apiBases[0], `/api/jobs/${cancelTarget.id}/cancel`, { method: "POST", token: userToken });
    await waitUntil(async () => {
      const response = await jsonRequest(apiBases[1], `/api/jobs/${cancelTarget.id}`, { token: userToken });
      return response.job.cancelRequested === true;
    }, 1_000, "cancelRequested was not visible on the other API worker within 1s");

    await forceStopBackend(dispatcher);
    await waitUntil(async () => {
      const health = await jsonRequest(`http://127.0.0.1:${standbyPort}`, "/api/health");
      return health.queue?.dispatcher?.heldByThisProcess === true;
    }, 5_000, "standby dispatcher did not acquire the lease after leader death");

    let finalJobs: JsonRecord[] = [];
    await waitUntil(async () => {
      const response = await jsonRequest(apiBases[1], "/api/jobs?limit=80", { token: userToken });
      finalJobs = response.jobs as JsonRecord[];
      const targetJobs = finalJobs.filter((job) => createdJobs.some((created) => created.id === job.id));
      return targetJobs.length === jobCount && targetJobs.every((job) => ["completed", "failed", "canceled"].includes(job.status));
    }, 35_000, "queue did not drain after dispatcher failover");

    const targetIds = new Set(createdJobs.map((job) => job.id));
    finalJobs = finalJobs.filter((job) => targetIds.has(job.id));
    const canceledJobs = finalJobs.filter((job) => job.status === "canceled");
    const completedJobs = finalJobs.filter((job) => job.status === "completed");
    const failedJobs = finalJobs.filter((job) => job.status === "failed");
    assert.deepEqual(failedJobs.map((job) => ({ id: job.id, error: job.errorMessage })), [], "no job may be lost during failover");
    assert.equal(canceledJobs.length, 1, "exactly the requested active job must be canceled");
    assert.equal(canceledJobs[0]?.id, cancelTarget.id);
    assert.equal(completedJobs.length, jobCount - 1);
    assert.equal(mock.submissionCount, completedJobs.length + canceledJobs.length, "every submitted or completed job must map to one RunPod job");
    assert.equal(mock.duplicateSubmissionCount, 0, "a workflow prompt was submitted more than once across failover");
    assert.equal(new Set(completedJobs.map((job) => job.runpodJobId)).size, completedJobs.length, "RunPod job IDs must be unique");
    assert.equal(new Set(completedJobs.map((job) => job.resultUrls?.[0])).size, completedJobs.length, "reserved output paths must be unique");
    assert.ok([...completedJobs, ...canceledJobs].every((job) => job.runpodSubmissionState === "submitted"), "acknowledged jobs must retain durable submission state");
    assert.equal(canceledJobs[0]?.runpodStatus, "CANCELLED", "dispatcher must cancel the acknowledged remote RunPod job");
    assert.ok(completedJobs.every((job) => job.creditUsage?.total_estimated_credits === 1 && job.creditsUsed === 1), "credits must stay attributed to each job");
    assert.equal(mock.syncRows, completedJobs.length, "each completed job must sync exactly one credit row");

    const folderResponse = await jsonRequest(apiBases[0], `/api/projects/${projectId}/folders`, {
      method: "POST",
      token: adminToken,
      body: { name: "Moved Results" },
    });
    const healthBeforeMove = await jsonRequest(apiBases[1], "/api/health");
    const movedJob = completedJobs[0];
    await jsonRequest(apiBases[0], `/api/projects/${projectId}/jobs/${movedJob.id}/folder`, {
      method: "PATCH",
      token: userToken,
      body: { destinationFolderId: folderResponse.folder.folderId },
    });
    await waitUntil(async () => {
      const health = await jsonRequest(apiBases[1], "/api/health");
      return Number(health.mediaIndex?.builtRevision ?? 0) > Number(healthBeforeMove.mediaIndex?.builtRevision ?? 0)
        && Number(health.mediaIndex?.builtRevision ?? 0) >= Number(health.mediaIndex?.dirtyRevision ?? 0);
    }, 1_000, "dispatcher-published media index did not converge within 1s after a cross-worker move");

    const mediaResponse = await fetch(`${apiBases[1]}/api/jobs/${movedJob.id}/result-media`, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(mediaResponse.status, 200, "moved result media must remain readable from the other API worker");
    assert.match(mediaResponse.headers.get("content-type") ?? "", /^image\//);
    await mediaResponse.arrayBuffer();

    await delay(500);
    const canceledAfterDrain = await jsonRequest(apiBases[0], `/api/jobs/${cancelTarget.id}`, { token: userToken });
    assert.equal(canceledAfterDrain.job.status, "canceled", "canceled job must not resurrect after drain");

    polling = false;
    await Promise.all(pollers);
    const allLogs = runtimes.map((runtime) => runtime.logs).join("\n");
    assert.doesNotMatch(allLogs, /SQLITE_BUSY|database is locked/i, "topology logs contain SQLite lock failures");
    assert.deepEqual(pollErrors, [], "100-client polling produced HTTP errors");
    assert.ok(pollCycles >= 100, "every simulated client should complete at least one polling cycle");
    assert.ok(percentile(enqueueLatencies, 99) < 5_000, "enqueue p99 exceeded the 5s topology gate");
    assert.ok(Math.max(...visibilityLatencies) < 1_000, "cross-worker read staleness exceeded 1s");
    assert.ok(Math.max(observedBackendActive, mock.maxActive) <= 10, "global active work exceeded the SQL cap");

    console.log(JSON.stringify({
      ok: true,
      clients: 100,
      pollCycles,
      jobsCreated: jobCount,
      jobsCompleted: completedJobs.length,
      jobsCanceled: canceledJobs.length,
      runpodSubmissions: mock.submissionCount,
      duplicateSubmissions: mock.duplicateSubmissionCount,
      maxRunpodActive: mock.maxActive,
      maxBackendActive: observedBackendActive,
      enqueueP99Ms: Math.round(percentile(enqueueLatencies, 99)),
      maxReadStalenessMs: Math.round(Math.max(...visibilityLatencies)),
      creditRowsSynced: mock.syncRows,
      dispatcherFailover: true,
      mediaIndexConverged: true,
      tempState: process.env.TOPOLOGY_KEEP_TEMP === "true" ? tempDir : undefined,
    }, null, 2));
  } catch (error) {
    polling = false;
    const diagnostics = runtimes.map((runtime) => `===== ${runtime.name} =====\n${runtime.logs.slice(-12_000)}`).join("\n");
    if (diagnostics.trim()) console.error(diagnostics);
    throw error;
  } finally {
    polling = false;
    await Promise.all(runtimes.map((runtime) => stopBackend(runtime)));
    await mock.close();
    if (process.env.TOPOLOGY_KEEP_TEMP !== "true") {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  }
}

async function prepareIsolatedState(tempDir: string) {
  const dataDir = path.join(tempDir, "data");
  const workflowDir = path.join(tempDir, "workflow");
  const projectsRoot = path.join(tempDir, "projects");
  const localProjectsRoot = path.join(tempDir, "local-projects");
  await Promise.all([dataDir, workflowDir, projectsRoot, localProjectsRoot].map((directory) => fs.mkdir(directory, { recursive: true })));
  const jsonFiles = ["jobs.json", "archived-items.json", "users.json", "sessions.json", "projects.json"];
  await Promise.all(jsonFiles.map((file) => fs.writeFile(path.join(dataDir, file), "[]\n", "utf8")));
  await fs.writeFile(path.join(workflowDir, "topology_text_to_image.json"), `${JSON.stringify({
    "1": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  }, null, 2)}\n`, "utf8");
  return { dataDir, workflowDir, projectsRoot, localProjectsRoot };
}

function isolatedEnvironment(paths: Awaited<ReturnType<typeof prepareIsolatedState>>, mockPort: number) {
  const mockBase = `http://127.0.0.1:${mockPort}`;
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    GENERATION_BACKEND: "runpod",
    RUNPOD_ENDPOINT_ID: "topology",
    RUNPOD_API_KEY: "topology-runpod-key",
    COMFY_ORG_API_KEY: "topology-comfy-key",
    RUNPOD_ENDPOINT_BASE_URL: `${mockBase}/v2/topology`,
    RUNPOD_SUBMISSION_MODE: "async",
    RUNPOD_POLL_INTERVAL_MS: "50",
    RUNPOD_TIMEOUT_MS: "15000",
    RUNPOD_MAX_CONCURRENT_JOBS: "10",
    RESULT_RECOVERY_INTERVAL_MS: "0",
    JOB_STORE_DRIVER: "sqlite",
    JOBS_ROW_LEVEL_WRITES: "true",
    JOBS_STORE_PATH: path.join(paths.dataDir, "jobs.json"),
    JOBS_SQLITE_PATH: path.join(paths.dataDir, "jobs.sqlite"),
    JOBS_ARCHIVED_PATH: path.join(paths.dataDir, "archived-items.json"),
    JOBS_ARCHIVED_SQLITE_PATH: path.join(paths.dataDir, "archived-items.sqlite"),
    APP_STATE_DRIVER: "sqlite",
    APP_STATE_SQLITE_PATH: path.join(paths.dataDir, "app-state.sqlite"),
    USERS_STORE_PATH: path.join(paths.dataDir, "users.json"),
    SESSIONS_STORE_PATH: path.join(paths.dataDir, "sessions.json"),
    PROJECTS_STORE_PATH: path.join(paths.dataDir, "projects.json"),
    INITIAL_ADMIN_PATH: path.join(paths.dataDir, "initial-admin.txt"),
    MOMI_ADMIN_EMAIL: adminEmail,
    MOMI_ADMIN_PASSWORD: adminPassword,
    SERVERLESS_WORKFLOW_ROOT: paths.workflowDir,
    BRICK_PROJECTS_ROOT: paths.projectsRoot,
    LOCAL_PROJECTS_ROOT: paths.localProjectsRoot,
    UPLOADED_MEDIA_ROOT: path.join(paths.localProjectsRoot, "_uploads"),
    DISPATCHER_POLL_INTERVAL_MS: "25",
    DISPATCHER_LEASE_HEARTBEAT_MS: "100",
    DISPATCHER_LEASE_TTL_MS: "400",
    DISPATCHER_WAL_CHECKPOINT_MS: "200",
    MEDIA_INDEX_REFRESH_MS: "100",
    MEDIA_SCAN_CACHE_MS: "15000",
    MEMORY_LOG_INTERVAL_MS: "500",
    CREDIT_BADGE_URL: `${mockBase}/credits`,
    CREDIT_TRACKER_URLS: mockBase,
    COMFY_SERVERS: mockBase,
    CREDIT_BALANCE_DELTA_ACCOUNTING: "false",
  };
}

function startBackend(name: string, role: BackendRuntime["role"], port: number, commonEnv: Record<string, string>) {
  const runtime: BackendRuntime = {
    name,
    role,
    port,
    child: undefined as unknown as ChildProcess,
    logs: "",
    expectedExit: false,
  };
  const child = spawn(process.execPath, [path.join(backendRoot, "dist", "index.js")], {
    cwd: backendRoot,
    env: { ...process.env, ...commonEnv, ROLE: role, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  runtime.child = child;
  const append = (chunk: Buffer) => {
    runtime.logs = `${runtime.logs}${chunk.toString("utf8")}`.slice(-2_000_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return runtime;
}

async function waitForHealth(runtime: BackendRuntime) {
  await waitUntil(async () => {
    if (runtime.child.exitCode != null) {
      throw new Error(`${runtime.name} exited during boot (${runtime.child.exitCode}).\n${runtime.logs.slice(-8_000)}`);
    }
    try {
      const response = await jsonRequest(`http://127.0.0.1:${runtime.port}`, "/api/health");
      return response.ok === true && response.role === runtime.role;
    } catch {
      return false;
    }
  }, 15_000, `${runtime.name} did not become healthy`);
}

async function forceStopBackend(runtime: BackendRuntime) {
  if (runtime.child.exitCode != null) return;
  runtime.expectedExit = true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(runtime.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    runtime.child.kill("SIGKILL");
  }
  await waitForExit(runtime.child, 5_000);
}

async function stopBackend(runtime: BackendRuntime) {
  if (!runtime.child || runtime.child.exitCode != null) return;
  runtime.expectedExit = true;
  runtime.child.kill("SIGTERM");
  try {
    await waitForExit(runtime.child, 4_000);
  } catch {
    await forceStopBackend(runtime);
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function jsonRequest(base: string, route: string, options: {
  method?: string;
  token?: string;
  body?: unknown;
  allowStatus?: number;
} = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: JsonRecord = {};
  try {
    body = text ? JSON.parse(text) as JsonRecord : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok && response.status !== options.allowStatus) {
    throw new Error(`${options.method ?? "GET"} ${route} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { ...body, statusCode: response.status } as JsonRecord & { statusCode: number };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${message}.${detail}`);
}

async function allocatePorts(count: number) {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    ports.push(address.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return ports;
}

function topologyPromptKey(value: unknown): string | undefined {
  if (typeof value === "string") return value.match(/topology-job-\d+/)?.[0];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = topologyPromptKey(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as JsonRecord)) {
      const found = topologyPromptKey(item);
      if (found) return found;
    }
  }
  return undefined;
}

function percentile(values: number[], requestedPercentile: number) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((requestedPercentile / 100) * sorted.length) - 1));
  return sorted[index];
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return;
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  response.end(data);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
