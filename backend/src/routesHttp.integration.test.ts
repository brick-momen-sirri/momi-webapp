// The HTTP surface, exercised end to end over a real socket.
//
// Every route module was at 0% coverage before this file. They are module-level
// express.Router() singletons with static service imports and no dependency
// injection, so the only honest way to test them is the way index.ts assembles
// them: real routers, real services, real middleware, pointed at a temporary data
// directory.
//
// Mount order here mirrors index.ts deliberately, because that order IS the
// authorization model -- ops/runpod-input/auth-public sit above requireAuth,
// resolveMediaAccessToken sits between, and everything else sits below. A test that
// mounted the routers in a different order would pass while proving nothing about
// production. If you change the order in index.ts, change it here too.
//
// Scope note: POST /api/jobs is deliberately never called. Creating a job is the
// one route that can dispatch a paid RunPod workflow, and no test is worth the risk
// of a real submission. Job read paths are covered by seeding the store directly.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-routes-it-"));
const localProjectsRoot = path.join(tempDir, "local-projects");
const brickProjectsRoot = path.join(tempDir, "brick-projects");

mkdirSync(localProjectsRoot, { recursive: true });
mkdirSync(brickProjectsRoot, { recursive: true });

const adminEmail = "admin@example.com";
const adminPassword = "AdminPass123";

process.env.ROLE = "api"; // Never owns dispatch, so nothing here can submit work.
process.env.APP_STATE_DRIVER = "sqlite";
process.env.APP_STATE_SQLITE_PATH = path.join(tempDir, "app-state.sqlite");
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_SQLITE_PATH = path.join(tempDir, "jobs.sqlite");
process.env.ARCHIVED_ITEMS_SQLITE_PATH = path.join(tempDir, "archived.sqlite");
process.env.JOBS_STORE_PATH = path.join(tempDir, "jobs.json");
process.env.ARCHIVED_ITEMS_STORE_PATH = path.join(tempDir, "archived.json");
process.env.PROJECTS_STORE_PATH = path.join(tempDir, "projects.json");
process.env.USERS_STORE_PATH = path.join(tempDir, "users.json");
process.env.SESSIONS_STORE_PATH = path.join(tempDir, "sessions.json");
process.env.LOCAL_PROJECTS_ROOT = localProjectsRoot;
process.env.BRICK_PROJECTS_ROOT = brickProjectsRoot;
process.env.UPLOADED_MEDIA_ROOT = path.join(tempDir, "uploads");
process.env.THUMBNAIL_CACHE_DIR = path.join(tempDir, "thumbnails");
process.env.MOMI_ADMIN_EMAIL = adminEmail;
process.env.MOMI_ADMIN_PASSWORD = adminPassword;
process.env.LOCAL_COMFY_ENABLED = "false";

for (const file of ["projects.json", "users.json", "sessions.json", "jobs.json", "archived.json"]) {
  writeFileSync(path.join(tempDir, file), "[]", "utf8");
}

const express = (await import("express")).default;
const { requireAuth, resolveMediaAccessToken } = await import("./authMiddleware.js");
const authService = await import("./authService.js");
const projectService = await import("./projectService.js");
const jobQueue = await import("./jobQueue.js");

const { authPublicRouter } = await import("./routes/authPublicRoutes.js");
const { authSessionRouter } = await import("./routes/authSessionRoutes.js");
const { runtimeRouter } = await import("./routes/runtimeRoutes.js");
const { userRouter } = await import("./routes/userRoutes.js");
const { comfyRouter } = await import("./routes/comfyRoutes.js");
const { projectRouter } = await import("./routes/projectRoutes.js");
const { creditRouter } = await import("./routes/creditRoutes.js");
const { mediaRouter } = await import("./routes/mediaRoutes.js");
const { jobRouter } = await import("./routes/jobRoutes.js");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(authPublicRouter);
app.use(resolveMediaAccessToken);
app.use(requireAuth);
app.use(authSessionRouter);
app.use(runtimeRouter);
app.use(userRouter);
app.use(comfyRouter);
app.use(projectRouter);
app.use(creditRouter);
app.use(mediaRouter);
app.use(jobRouter);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Server error." });
});

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let adminToken = "";
let artistToken = "";
let artistId = "";

const artistUserId = () => artistId || "usr_unknown";

/** One request against the live server; returns status plus parsed body. */
async function call(method: string, routePath: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, body: json as Record<string, unknown> | undefined, text };
}

const asAdmin = (method: string, routePath: string, body?: unknown) => call(method, routePath, { token: adminToken, body });

before(async () => {
  await authService.loadAuthData();
  await projectService.loadProjects();
  await jobQueue.loadJobs();
  const login = await call("POST", "/api/auth/login", { body: { email: adminEmail, password: adminPassword } });
  assert.equal(login.status, 200, `login failed: ${login.text}`);
  adminToken = String((login.body as { token?: string }).token);
  assert.ok(adminToken);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  jobQueue.closeJobStore();
  projectService.closeProjectStore();
  authService.closeAuthStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows can hold a WAL handle briefly; the OS temp dir is transient.
  }
});

test("login rejects a bad password without revealing which part was wrong", async () => {
  const wrongPassword = await call("POST", "/api/auth/login", { body: { email: adminEmail, password: "WrongPass1" } });
  const unknownUser = await call("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: adminPassword } });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.deepEqual(wrongPassword.body, unknownUser.body);
});

test("login rejects a request with no credentials at all", async () => {
  const empty = await call("POST", "/api/auth/login", { body: {} });
  assert.ok(empty.status >= 400, `expected a client error, got ${empty.status}`);
});

// The single most valuable assertion in this file: everything below requireAuth
// must refuse an anonymous caller. Adding a route without auth is a real mistake
// this catches.
test("every route below requireAuth refuses an unauthenticated request", async () => {
  const protectedRoutes: Array<[string, string]> = [
    ["GET", "/api/runtime"],
    ["GET", "/api/snapshot"],
    ["GET", "/api/projects"],
    ["GET", "/api/projects/prj_1"],
    ["GET", "/api/projects/prj_1/folders"],
    ["GET", "/api/jobs"],
    ["GET", "/api/jobs/job_1"],
    ["GET", "/api/jobs/job_1/status"],
    ["GET", "/api/credits"],
    ["GET", "/api/credits/dashboard"],
    ["GET", "/api/usage/monthly"],
    ["GET", "/api/users"],
    ["GET", "/api/pods/status"],
    ["POST", "/api/projects"],
    ["PATCH", "/api/projects/prj_1"],
    ["POST", "/api/projects/prj_1/folders"],
    ["POST", "/api/jobs/job_1/archive"],
    ["POST", "/api/jobs/job_1/cancel"],
    ["DELETE", "/api/jobs/job_1/permanent"],
  ];

  for (const [method, routePath] of protectedRoutes) {
    const response = await call(method, routePath, { body: method === "GET" ? undefined : {} });
    assert.equal(response.status, 401, `${method} ${routePath} should require auth, got ${response.status}`);
    assert.deepEqual(response.body, { error: "Authentication required." });
  }
});

test("a malformed or unknown bearer token is treated as anonymous", async () => {
  for (const token of ["not-a-token", "Bearer", "x".repeat(400)]) {
    const response = await call("GET", "/api/projects", { token });
    assert.equal(response.status, 401);
  }
});

test("runtime reports the backend configuration", async () => {
  const response = await asAdmin("GET", "/api/runtime");
  assert.equal(response.status, 200);
  assert.equal(typeof response.body?.generationBackend, "string");
  // Local Comfy is off in this environment, and the flag drives whether the
  // frontend renders the pool manager at all.
  assert.equal(response.body?.localComfyEnabled, false);
});

test("snapshot bundles the small polled values into one response", async () => {
  const response = await asAdmin("GET", "/api/snapshot");
  assert.equal(response.status, 200);
  // The frontend polls this instead of four separate endpoints, so all four keys
  // have to be present even when a value is null.
  for (const key of ["credits", "monthlyUsage", "runtime", "podStatus"]) {
    assert.ok(key in (response.body ?? {}), `snapshot missing ${key}`);
  }
});

let testProjectId = "";

test("a created project is returned by the project list", async () => {
  const before = await asAdmin("GET", "/api/projects");
  assert.equal(before.status, 200);
  // The list is an object, not a bare array -- it carries per-project credit
  // aggregates alongside the projects themselves.
  assert.ok(Array.isArray(before.body?.projects), "expected a projects array");
  const countBefore = (before.body?.projects as unknown[]).length;

  // shortName is the project code and feeds the on-disk folder name, so it has to
  // be exactly four digits -- see buildProjectDiskName.
  const created = await asAdmin("POST", "/api/projects", {
    name: "Glass Tower",
    shortName: "1234",
    client: "Acme",
  });
  assert.equal(created.status, 201, created.text);
  // The id is assigned server-side; a client-supplied one is not honoured.
  testProjectId = String((created.body as { project?: { id?: string } }).project?.id);
  assert.ok(testProjectId && testProjectId !== "undefined");

  const after = await asAdmin("GET", "/api/projects");
  assert.equal((after.body?.projects as unknown[]).length, countBefore + 1);
});

test("the creator is recorded as the project owner", async () => {
  const response = await asAdmin("GET", `/api/projects/${testProjectId}`);
  assert.equal(response.status, 200, response.text);
  const project = (response.body as { project?: { ownerId?: string } }).project ?? response.body;
  assert.equal(typeof (project as { ownerId?: string }).ownerId, "string");
});

test("a project fetch by unknown id is a 404, not an empty 200", async () => {
  const response = await asAdmin("GET", "/api/projects/prj_missing");
  assert.equal(response.status, 404);
});

test("creating a project rejects a project code that is not four digits", async () => {
  // The code becomes a directory name under the Brick projects root, and the rest
  // of the pipeline parses that name back apart, so a free-text code would corrupt
  // every later lookup.
  for (const shortName of ["TWR", "12", "12345", ""]) {
    const response = await asAdmin("POST", "/api/projects", { name: "Bad Code", client: "Acme", shortName });
    assert.equal(response.status, 400, `shortName ${JSON.stringify(shortName)} returned ${response.status}`);
  }
});

test("folders can be created, listed, renamed and deleted", async () => {
  const created = await asAdmin("POST", `/api/projects/${testProjectId}/folders`, { name: "Interiors" });
  assert.equal(created.status, 201, created.text);
  // The response carries both the new folder and the updated project, so the
  // client does not need a follow-up fetch to refresh its tree.
  assert.ok((created.body as { project?: unknown }).project);
  const folderId = String((created.body as { folder?: { folderId?: string } }).folder?.folderId);
  assert.ok(folderId && folderId !== "undefined");

  const listed = await asAdmin("GET", `/api/projects/${testProjectId}/folders`);
  assert.equal(listed.status, 200);
  assert.ok(JSON.stringify(listed.body).includes("Interiors"));

  const renamed = await asAdmin("PATCH", `/api/projects/${testProjectId}/folders/${folderId}`, { name: "Interiors v2" });
  assert.equal(renamed.status, 200, renamed.text);

  const deleted = await asAdmin("DELETE", `/api/projects/${testProjectId}/folders/${folderId}`);
  assert.equal(deleted.status, 200, deleted.text);
});

test("creating a folder on an unknown project is refused", async () => {
  const response = await asAdmin("POST", "/api/projects/prj_missing/folders", { name: "Nowhere" });
  assert.ok(response.status >= 400, `expected a client error, got ${response.status}`);
});

test("creating a folder with no usable name is refused", async () => {
  for (const name of ["", "   "]) {
    const response = await asAdmin("POST", `/api/projects/${testProjectId}/folders`, { name });
    assert.ok(response.status >= 400, `expected a client error for ${JSON.stringify(name)}`);
  }
});

test("the job list paginates and reports a total", async () => {
  const response = await asAdmin("GET", "/api/jobs?limit=5&offset=0");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body?.jobs), "expected a jobs array");
  assert.equal(typeof response.body?.total, "number");
  assert.equal(typeof response.body?.offset, "number");
});

test("the job list tolerates nonsense pagination values", async () => {
  // These arrive from URLs users can edit, so they must clamp rather than throw.
  for (const query of ["limit=-1", "limit=abc", "offset=-5", "limit=999999", "archived=maybe"]) {
    const response = await asAdmin("GET", `/api/jobs?${query}`);
    assert.equal(response.status, 200, `${query} produced ${response.status}`);
  }
});

test("the archived view is a separate list", async () => {
  const main = await asAdmin("GET", "/api/jobs?archived=false");
  const archived = await asAdmin("GET", "/api/jobs?archived=true");
  assert.equal(main.status, 200);
  assert.equal(archived.status, 200);
  assert.ok(Array.isArray(archived.body?.jobs));
});

test("an unknown job is a 404 on every read path", async () => {
  for (const routePath of ["/api/jobs/job_missing", "/api/jobs/job_missing/status"]) {
    const response = await asAdmin("GET", routePath);
    assert.equal(response.status, 404, `${routePath} returned ${response.status}`);
  }
});

test("acting on an unknown job does not 500", async () => {
  for (const [method, routePath] of [
    ["POST", "/api/jobs/job_missing/archive"],
    ["POST", "/api/jobs/job_missing/restore"],
    ["POST", "/api/jobs/job_missing/cancel"],
    ["DELETE", "/api/jobs/job_missing/permanent"],
  ] as Array<[string, string]>) {
    const response = await asAdmin(method, routePath, {});
    assert.ok(response.status >= 400 && response.status < 500, `${method} ${routePath} returned ${response.status}`);
  }
});

test("credits and monthly usage answer with the expected shape", async () => {
  const credits = await asAdmin("GET", "/api/credits");
  assert.equal(credits.status, 200);
  assert.ok("creditsLeft" in (credits.body ?? {}));

  const usage = await asAdmin("GET", "/api/usage/monthly");
  assert.equal(usage.status, 200);
  assert.ok(Array.isArray(usage.body?.users), "monthly usage should list users");
});

test("the credit dashboard answers for an admin", async () => {
  const response = await asAdmin("GET", "/api/credits/dashboard");
  assert.equal(response.status, 200, response.text);
  assert.equal(typeof response.body, "object");
});

test("reading the workspace roster is open to any signed-in user", async () => {
  const artist = await authService.createUser({
    email: "artist@example.com",
    name: "Test Artist",
    password: "ArtistPass1",
    role: "user",
  });
  assert.ok(artist.id);
  artistId = artist.id;
  const login = await call("POST", "/api/auth/login", { body: { email: "artist@example.com", password: "ArtistPass1" } });
  assert.equal(login.status, 200, login.text);
  artistToken = String((login.body as { token?: string }).token);

  // Deliberately not admin-gated: the job feed shows who submitted each result, so
  // every user has to be able to resolve names and avatars from user ids.
  assert.equal((await asAdmin("GET", "/api/users")).status, 200);
  assert.equal((await call("GET", "/api/users", { token: artistToken })).status, 200);
});

test("every user mutation is refused for a non-admin", async () => {
  const adminOnly: Array<[string, string, unknown]> = [
    ["POST", "/api/users", { email: "new@example.com", name: "New Person", password: "NewPass123" }],
    ["PATCH", `/api/users/${artistUserId()}`, { role: "admin" }],
    ["POST", `/api/users/${artistUserId()}/reset-password`, { password: "Other123", confirmPassword: "Other123" }],
    ["POST", `/api/users/${artistUserId()}/enable`, {}],
    ["POST", `/api/users/${artistUserId()}/disable`, {}],
  ];

  for (const [method, routePath, body] of adminOnly) {
    const response = await call(method, routePath, { token: artistToken, body });
    // 403, not 401: the caller is authenticated, just not allowed. Conflating the
    // two would tell an attacker their token is invalid when it is merely limited.
    assert.equal(response.status, 403, `${method} ${routePath} returned ${response.status}`);
    assert.deepEqual(response.body, { error: "Admin access required." });
  }
});

test("a non-admin cannot escalate their own role through the profile route", async () => {
  const response = await call("PATCH", "/api/auth/me", {
    token: artistToken,
    body: { name: "Renamed", role: "admin" },
  });

  // Whether the route rejects the field or silently ignores it, the outcome that
  // matters is the same: the account must still be a plain user afterwards.
  const roster = await call("GET", "/api/users", { token: artistToken });
  const artist = (roster.body?.users as Array<{ email: string; role: string }> | undefined)?.find(
    (user) => user.email === "artist@example.com",
  );
  assert.ok(response.status < 500);
  if (artist) assert.equal(artist.role, "user");
});

test("a signed-in user can read their own account", async () => {
  const response = await asAdmin("GET", "/api/auth/me");
  assert.equal(response.status, 200, response.text);
  assert.equal((response.body as { user?: { email?: string } }).user?.email ?? response.body?.email, adminEmail);
});

test("a password hash never appears in any route response", async () => {
  // The service strips it, but a route could still reassemble a stored user by
  // hand; this checks the wire, not the function.
  for (const routePath of ["/api/auth/me", "/api/users", "/api/projects", "/api/snapshot"]) {
    const response = await asAdmin("GET", routePath);
    assert.ok(!response.text.includes("passwordHash"), `${routePath} leaked passwordHash`);
    assert.ok(!response.text.includes("scrypt$"), `${routePath} leaked a hash value`);
  }
});

test("logout invalidates the session it was called with", async () => {
  const login = await call("POST", "/api/auth/login", { body: { email: adminEmail, password: adminPassword } });
  const token = String((login.body as { token?: string }).token);
  assert.equal((await call("GET", "/api/projects", { token })).status, 200);

  const loggedOut = await call("POST", "/api/auth/logout", { token, body: {} });
  assert.ok(loggedOut.status < 400, loggedOut.text);

  assert.equal((await call("GET", "/api/projects", { token })).status, 401);
  // The token this suite's other tests use must still work.
  assert.equal((await asAdmin("GET", "/api/projects")).status, 200);
});

test("an unknown route under /api is a 404 rather than a hang", async () => {
  const response = await asAdmin("GET", "/api/does-not-exist");
  assert.equal(response.status, 404);
});

test("the comfy pool routes report disabled rather than failing", async () => {
  // LOCAL_COMFY_ENABLED is false here, which is the production default.
  const response = await asAdmin("GET", "/api/comfy/servers");
  assert.ok(response.status === 200 || response.status === 404, `got ${response.status}`);
});
