import http from "node:http";

import { createFrontendGateway } from "../backend/.e2e-dist/frontendGateway.js";

const apiPort = Number(process.env.E2E_API_PORT ?? 13_339);
const webPort = Number(process.env.E2E_WEB_PORT ?? 18_190);
const frontendDistPath = new URL("../.e2e-dist/frontend", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) =>
  value.slice(1),
);

const user = {
  id: "usr_e2e",
  name: "E2E Artist",
  displayName: "E2E Artist",
  email: "artist@brickvisual.com",
  role: "admin",
  active: true,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
  pinnedProjectIds: [],
};

const project = {
  id: "proj_e2e",
  name: "E2E Glass Tower",
  shortName: "E2E",
  ownerId: user.id,
  members: [{ userId: user.id, role: "owner" }],
  groupMembers: [],
  folders: [],
  jobCount: 0,
  createdAt: "2026-08-05T00:00:00.000Z",
  visibility: "private",
};

const model = {
  id: "nano_banana_e2e",
  name: "Nano Banana E2E",
  category: "image_editing",
  workflowPath: "e2e/nano-banana.json",
  description: "Production-browser upload test workflow",
  requiredInputs: ["single_image", "prompt", "resolution"],
  requiresPrompt: true,
  requiresImage: true,
  requiresStartEndFrames: false,
  imageSlotCount: 1,
  outputType: "image",
  estimatedCredits: 3,
  estimatedTime: "Queued",
  supportedResolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K",
};

const state = { uploads: [], submissions: [], jobs: [] };

// A second project with a realistic history, for the result-link tests: 80 results,
// the newest 50 of them in SHOT0002 above an older one that a link points at, so
// the linked result is on no first page and has to be fetched by id. A third
// project the artist is not a member of holds a result they must not be shown.
const marina = {
  ...project,
  id: "proj_marina",
  name: "E2E Marina",
  shortName: "MAR",
  folders: [
    { folderId: "fld_shot1", parentId: null, name: "SHOT0001", archived: false },
    { folderId: "fld_shot2", parentId: null, name: "SHOT0002", archived: false },
  ],
};
const library = [
  ...Array.from({ length: 80 }, (_, index) =>
    libraryJob(`job_marina_${String(index).padStart(2, "0")}`, {
      folderId: index < 50 ? "fld_shot2" : "fld_shot1",
      prompt: `Marina pass ${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 30, 12) - index * 3_600_000).toISOString(),
    }),
  ),
  libraryJob("job_link_target", {
    folderId: "fld_shot2",
    prompt: "Shared marina flythrough",
    createdAt: "2026-07-01T10:00:00.000Z",
  }),
  libraryJob("job_private", { projectId: "proj_private", prompt: "Not yours", createdAt: "2026-09-01T10:00:00.000Z" }),
];
const visibleProjectIds = new Set([project.id, marina.id]);
// Per-path response delays, set by a test to production's measured medians.
let latencyMs = {};
const requestLog = [];

function libraryJob(id, overrides) {
  return {
    id,
    projectId: marina.id,
    userId: user.id,
    modelId: model.id,
    modelName: model.name,
    category: model.category,
    workflowPath: model.workflowPath,
    inputType: "single_image",
    resolution: { width: 1024, height: 1024, label: "1K" },
    status: "completed",
    inputImages: [],
    resultUrls: [`/api/media?path=${id}.png`],
    thumbnailUrls: [`/api/media?path=${id}.png`],
    outputType: "image",
    creditsEstimated: 3,
    ...overrides,
    folderName: overrides.folderId === "fld_shot1" ? "SHOT0001" : overrides.folderId === "fld_shot2" ? "SHOT0002" : undefined,
    completedAt: overrides.createdAt,
  };
}

function jobsPage(url) {
  const projectId = url.searchParams.get("projectId");
  const folderId = url.searchParams.get("folderId");
  const limit = Number(url.searchParams.get("limit") ?? 30);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const matching = [...state.jobs, ...library]
    .filter((job) => visibleProjectIds.has(job.projectId))
    .filter((job) => !projectId || job.projectId === projectId)
    .filter((job) => !folderId || job.folderId === folderId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const jobs = matching.slice(offset, offset + limit);
  return { jobs, total: matching.length, limit, offset, hasMore: offset + jobs.length < matching.length };
}
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const apiServer = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${apiPort}`);
  const method = request.method ?? "GET";
  const body = await readBody(request);

  if (method === "GET" && url.pathname === "/api/e2e/state") {
    return json(response, 200, state);
  }
  if (method === "POST" && url.pathname === "/api/e2e/latency") {
    latencyMs = JSON.parse(body.toString("utf8") || "{}");
    return json(response, 200, { latencyMs });
  }
  if (method === "GET" && url.pathname === "/api/e2e/requests") return json(response, 200, { requests: requestLog });
  if (method === "POST" && url.pathname === "/api/e2e/requests/reset") {
    requestLog.length = 0;
    return json(response, 200, { ok: true });
  }
  requestLog.push({ method, path: url.pathname, search: url.search, at: Date.now() });
  const delay = latencyMs[url.pathname] ?? (/^\/api\/jobs\/[^/]+$/.test(url.pathname) ? latencyMs["/api/jobs/:id"] : undefined);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (method === "POST" && url.pathname === "/api/auth/login") {
    return json(response, 200, {
      token: "e2e-session-token",
      user,
      mediaAccess: { token: "e2e-media-token", expiresAt: futureIso() },
    });
  }
  if (method === "GET" && url.pathname === "/api/auth/me") {
    if (!request.headers.authorization) return json(response, 401, { error: "Authentication required." });
    return json(response, 200, { user, mediaAccess: { token: "e2e-media-token", expiresAt: futureIso() } });
  }
  if (method === "GET" && url.pathname === "/api/models") return json(response, 200, { models: [model] });
  if (method === "GET" && url.pathname === "/api/projects") return json(response, 200, { projects: [project, marina] });
  if (method === "GET" && url.pathname === "/api/users") return json(response, 200, { users: [user] });
  if (method === "GET" && url.pathname === "/api/credits") {
    return json(response, 200, { creditsLeft: 500, source: "e2e" });
  }
  if (method === "GET" && url.pathname === "/api/usage/monthly") {
    return json(response, 200, { month: "2026-08", startAt: "", endAt: "", users: [] });
  }
  if (method === "GET" && url.pathname === "/api/runtime") return json(response, 200, runtime());
  if (method === "GET" && url.pathname === "/api/snapshot") {
    return json(response, 200, {
      credits: { creditsLeft: 500, source: "e2e" },
      monthlyUsage: { month: "2026-08", startAt: "", endAt: "", users: [] },
      runtime: runtime(),
      podStatus: podStatus(),
    });
  }
  if (method === "GET" && url.pathname === "/api/pods/status") return json(response, 200, { status: podStatus() });
  if (method === "GET" && url.pathname === "/api/jobs") return json(response, 200, jobsPage(url));
  if (method === "GET" && /^\/api\/jobs\/[^/]+\/result-(media|file)$/.test(url.pathname)) {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(onePixelPng.length) });
    response.end(onePixelPng);
    return;
  }
  if (method === "GET" && /^\/api\/jobs\/[^/]+$/.test(url.pathname)) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
    const job = [...state.jobs, ...library].find((item) => item.id === jobId && visibleProjectIds.has(item.projectId));
    return job ? json(response, 200, { job }) : json(response, 404, { error: "Job not found" });
  }
  if (method === "GET" && (url.pathname === "/api/media" || url.pathname === "/api/media/thumbnail")) {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(onePixelPng.length) });
    response.end(onePixelPng);
    return;
  }
  if (method === "POST" && url.pathname === "/api/media/upload") {
    state.uploads.push({
      bytes: body.length,
      contentType: request.headers["content-type"],
      projectId: url.searchParams.get("projectId"),
    });
    return json(response, 201, {
      url: "/api/media?path=e2e-upload.png",
      name: "e2e-input.png",
      kind: "image",
      bytes: body.length,
    });
  }
  if (method === "POST" && url.pathname === "/api/jobs") {
    const submission = JSON.parse(body.toString("utf8"));
    state.submissions.push(submission);
    const job = {
      id: "job_e2e_1",
      projectId: project.id,
      userId: user.id,
      modelId: model.id,
      modelName: model.name,
      category: model.category,
      workflowPath: model.workflowPath,
      inputType: "single_image",
      prompt: submission.prompt,
      resolution: submission.resolution,
      status: "queued",
      inputImages: submission.inputImages ?? [],
      resultUrls: [],
      thumbnailUrls: [],
      outputType: "image",
      creditsEstimated: 3,
      createdAt: new Date().toISOString(),
    };
    state.jobs = [job];
    return json(response, 201, { job });
  }

  return json(response, 404, { error: `No E2E route for ${method} ${url.pathname}` });
});

await listen(apiServer, apiPort);
const gateway = createFrontendGateway({ frontendDistPath, apiTarget: `http://127.0.0.1:${apiPort}` });
const webServer = gateway.listen(webPort, "127.0.0.1");
await new Promise((resolve, reject) => {
  webServer.once("listening", resolve);
  webServer.once("error", reject);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    webServer.close(() => apiServer.close(() => process.exit(0)));
  });
}

function runtime() {
  return {
    generationBackend: "runpod",
    localComfyEnabled: false,
    runpodConfigured: true,
    runpodPollIntervalMs: 5_000,
    runpodTimeoutMs: 2_400_000,
  };
}

function podStatus() {
  return {
    backend: "runpod",
    status: "idle",
    available: 1,
    running: 0,
    idle: 1,
    stopped: 0,
    unavailable: 0,
    queued: 0,
    hasQueuedTasks: false,
    capacity: 10,
    queue: { queued: 0, sending: 0, running: 0, active: 0, runpodActive: 0, capacity: 10, activeJobs: [], waitingJobs: [] },
    pods: [],
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(encoded.length) });
  response.end(encoded);
}

function futureIso() {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}
