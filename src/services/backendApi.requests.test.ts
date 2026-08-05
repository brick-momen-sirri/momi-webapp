// The job, project and upload calls: what URL each one hits, what it sends, and
// how it behaves when the backend says no.
//
// The recurring risks in this file are not logic errors, they are wiring errors
// -- an unescaped path segment, a missing Authorization header, an error body
// swallowed into a useless "500" -- and every one of them is invisible until a
// user hits it.

import { beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[] = [];
let respond: (url: string, init: RequestInit) => { ok?: boolean; status?: number; body?: unknown };

async function loadModule() {
  vi.resetModules();
  return import("./backendApi.js");
}

function backendJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    projectId: "proj_1",
    userId: "usr_momen",
    modelType: "Nano Banana",
    inputType: "single_image",
    prompt: "a tower",
    resolution: "2K",
    status: "completed",
    // These three are required on BackendJob and mapJob dereferences them
    // directly, so a fixture without them fails in a way real traffic would not.
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function backendProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_1",
    name: "Tower",
    shortName: "TWR",
    // mapProject reads members.length and groupMembers.length unconditionally.
    members: [],
    groupMembers: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  respond = () => ({ body: {} });
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const result = respond(String(url), init);
    return Promise.resolve({
      ok: result.ok ?? true,
      status: result.status ?? 200,
      statusText: "OK",
      headers: new Headers({ "X-Request-ID": "req_client_trace_123" }),
      json: () => Promise.resolve(result.body ?? {}),
    } as Response);
  });
});

const lastCall = () => calls[calls.length - 1];
const lastBody = () => JSON.parse(String(lastCall().init.body));

describe("authentication of outgoing requests", () => {
  it("attaches the stored session token as a Bearer header", async () => {
    const api = await loadModule();
    api.setStoredAuthToken("sess_abc");
    respond = () => ({ body: { jobs: [] } });

    await api.fetchBackendJobs({ limit: 10 });
    expect(new Headers(lastCall().init.headers).get("Authorization")).toBe("Bearer sess_abc");
  });

  it("sends credentials so the momi_session cookie travels too", async () => {
    const api = await loadModule();
    respond = () => ({ body: { jobs: [] } });

    await api.fetchBackendJobs({ limit: 10 });
    expect(lastCall().init.credentials).toBe("include");
  });

  it("omits the header entirely when there is no session, rather than sending 'Bearer undefined'", async () => {
    const api = await loadModule();
    respond = () => ({ body: { jobs: [] } });

    await api.fetchBackendJobs({ limit: 10 });
    expect(new Headers(lastCall().init.headers).has("Authorization")).toBe(false);
  });
});

describe("error surfacing", () => {
  it("throws the backend's own error message", async () => {
    const api = await loadModule();
    respond = () => ({ ok: false, status: 403, body: { error: "Project editor access required." } });

    await expect(api.createBackendJob({ projectId: "p", modelId: "m", resolution: { width: 1, height: 1 } })).rejects.toThrow(
      "Project editor access required.",
    );
  });

  it("keeps the server request id on API errors for support tracing", async () => {
    const api = await loadModule();
    respond = () => ({ ok: false, status: 503, body: { error: "Temporarily unavailable." } });

    const error = await api.fetchBackendProjects().catch((caught) => caught);
    expect(error).toBeInstanceOf(api.ApiError);
    expect(error).toMatchObject({ status: 503, requestId: "req_client_trace_123" });
  });

  it("falls back to the status when the body carries no message", async () => {
    const api = await loadModule();
    respond = () => ({ ok: false, status: 500, body: {} });

    await expect(api.fetchBackendProjects()).rejects.toThrow(/500/);
  });

  it("does not hang or throw a parse error when the body is not JSON", async () => {
    const api = await loadModule();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
      } as unknown as Response),
    );

    // A proxy returning an HTML error page must still produce a usable message.
    await expect(api.fetchBackendProjects()).rejects.toThrow(/502/);
  });
});

describe("job list", () => {
  it("serialises only the params that were provided", async () => {
    const api = await loadModule();
    respond = () => ({ body: { jobs: [], total: 0, limit: 80, offset: 0 } });

    await api.fetchBackendJobs({ limit: 80, offset: 0, projectId: undefined, archived: false });
    const url = new URL(lastCall().url, "http://localhost");
    expect(url.searchParams.get("limit")).toBe("80");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("archived")).toBe("false");
    // undefined must be dropped, not sent as the string "undefined".
    expect(url.searchParams.has("projectId")).toBe(false);
  });

  it("hits a bare /api/jobs when given no params at all", async () => {
    const api = await loadModule();
    respond = () => ({ body: { jobs: [] } });

    await api.fetchBackendJobs();
    expect(lastCall().url).toMatch(/\/api\/jobs$/);
  });

  it("fills in pagination fields the backend omitted", async () => {
    const api = await loadModule();
    respond = () => ({ body: { jobs: [backendJob(), backendJob({ id: "job_2" })] } });

    const page = await api.fetchBackendJobs({ limit: 80 });
    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(false);
  });
});

describe("job mutations", () => {
  it("POSTs a new job as JSON to /api/jobs", async () => {
    const api = await loadModule();
    respond = () => ({ body: { job: backendJob() } });

    await api.createBackendJob({
      clientRequestId: "req_client_1234567890",
      projectId: "proj_1",
      modelId: "kling_v3",
      prompt: "a tower",
      resolution: { width: 1920, height: 1080, label: "1080p" },
    });

    expect(lastCall().url).toMatch(/\/api\/jobs$/);
    expect(lastCall().init.method).toBe("POST");
    expect(new Headers(lastCall().init.headers).get("Content-Type")).toBe("application/json");
    expect(lastBody()).toMatchObject({
      clientRequestId: "req_client_1234567890",
      projectId: "proj_1",
      modelId: "kling_v3",
      prompt: "a tower",
    });
  });

  it("escapes ids in the path so a slash cannot forge a different route", async () => {
    const api = await loadModule();
    respond = () => ({ body: { job: backendJob() } });

    // The id below would otherwise resolve to a different endpoint entirely.
    await api.updateBackendJobSaveNumber("proj/../x", "job 1/../../admin", "0012");
    expect(lastCall().url).toContain("proj%2F..%2Fx");
    expect(lastCall().url).toContain("job%201%2F..%2F..%2Fadmin");
    expect(lastCall().url).not.toContain("/../");
  });

  it("PATCHes the save number to the per-project job route", async () => {
    const api = await loadModule();
    respond = () => ({ body: { job: backendJob() } });

    await api.updateBackendJobSaveNumber("proj_1", "job_1", "0012");
    expect(lastCall().url).toMatch(/\/api\/projects\/proj_1\/jobs\/job_1\/save-number$/);
    expect(lastCall().init.method).toBe("PATCH");
    expect(lastBody()).toEqual({ saveNumber: "0012" });
  });

  it("POSTs a retry to the job's own retry route", async () => {
    const api = await loadModule();
    respond = () => ({ body: { job: backendJob({ status: "queued" }) } });

    await api.retryBackendJob("job_1");
    expect(lastCall().url).toMatch(/\/api\/jobs\/job_1\/retry$/);
    expect(lastCall().init.method).toBe("POST");
  });

  it("sends the destination folder when moving a result", async () => {
    const api = await loadModule();
    respond = () => ({ body: { job: backendJob() } });

    await api.moveBackendJobResult("proj_1", "job_1", "fld_2");
    expect(lastCall().url).toMatch(/\/api\/projects\/proj_1\/jobs\/job_1\/folder$/);
    expect(lastBody()).toMatchObject({ destinationFolderId: "fld_2" });
  });

  it("can move a result back to the project root with a null folder", async () => {
    const api = await loadModule();
    respond = () => ({ body: { job: backendJob() } });

    await api.moveBackendJobResult("proj_1", "job_1", null);
    // null must survive as null, not become the string "null" or be dropped.
    expect(lastBody().destinationFolderId).toBeNull();
  });
});

describe("projects", () => {
  it("POSTs a new project and maps the response", async () => {
    const api = await loadModule();
    respond = () => ({ body: { project: backendProject() } });

    const created = await api.createBackendProject({ id: "proj_1", name: "Tower", shortName: "TWR" } as never);
    expect(lastCall().url).toMatch(/\/api\/projects$/);
    expect(lastCall().init.method).toBe("POST");
    expect(created).toMatchObject({ id: "proj_1", name: "Tower" });
  });

  it("PATCHes an existing project at its own URL", async () => {
    const api = await loadModule();
    respond = () => ({ body: { project: backendProject({ name: "Renamed" }) } });

    const updated = await api.updateBackendProject({ id: "proj_1", name: "Renamed", shortName: "TWR" } as never);
    expect(lastCall().url).toMatch(/\/api\/projects\/proj_1$/);
    expect(lastCall().init.method).toBe("PATCH");
    expect(updated).toMatchObject({ name: "Renamed" });
  });

  it("creates and deletes folders on the nested folder routes", async () => {
    const api = await loadModule();
    respond = () => ({ body: { folder: { folderId: "fld_1", name: "Shots" }, project: backendProject() } });

    await api.createBackendProjectFolder("proj_1", "Shots");
    expect(lastCall().url).toMatch(/\/api\/projects\/proj_1\/folders$/);
    expect(lastCall().init.method).toBe("POST");

    await api.deleteBackendProjectFolder("proj_1", "fld_1");
    expect(lastCall().url).toMatch(/\/api\/projects\/proj_1\/folders\/fld_1$/);
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("depends on members and groupMembers always being sent", async () => {
    const api = await loadModule();
    respond = () => ({ body: { projects: [{ id: "p", name: "N", shortName: "N" }] } });

    // mapProject reads both arrays' .length without a guard, so a payload missing
    // either one takes down the whole project list rather than degrading. Both are
    // required on the backend type today, which is the only reason this is safe.
    // If they ever become optional on the wire, this test fails and points here.
    await expect(api.fetchBackendProjects()).rejects.toThrow(TypeError);
  });
});

describe("media upload", () => {
  const blob = () => new Blob(["binary"], { type: "image/png" });

  it("streams the blob as the raw body with its own content type", async () => {
    const api = await loadModule();
    api.setStoredAuthToken("sess_abc");
    respond = () => ({ status: 201, body: { url: "/api/media?path=x.png" } });

    const url = await api.uploadBackendMedia(blob(), { projectId: "proj_1", kind: "image", name: "shot.png" });

    const call = lastCall();
    expect(call.init.method).toBe("POST");
    // The body is the Blob itself: not FormData, not base64.
    expect(call.init.body).toBeInstanceOf(Blob);
    expect(new Headers(call.init.headers).get("Content-Type")).toBe("image/png");
    expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer sess_abc");
    expect(url).toBe("/api/media?path=x.png");
  });

  it("passes projectId, kind and name as query parameters", async () => {
    const api = await loadModule();
    respond = () => ({ status: 201, body: { url: "/api/media?path=x.png" } });

    await api.uploadBackendMedia(blob(), { projectId: "proj_1", kind: "video", name: "clip.mp4" });
    const url = new URL(lastCall().url, "http://localhost");
    expect(url.searchParams.get("projectId")).toBe("proj_1");
    expect(url.searchParams.get("kind")).toBe("video");
    expect(url.searchParams.get("name")).toBe("clip.mp4");
  });

  it("omits the name parameter when none was given", async () => {
    const api = await loadModule();
    respond = () => ({ status: 201, body: { url: "/api/media?path=x.png" } });

    await api.uploadBackendMedia(blob(), { projectId: "proj_1", kind: "image" });
    expect(new URL(lastCall().url, "http://localhost").searchParams.has("name")).toBe(false);
  });

  it("surfaces the backend's rejection message for an oversized upload", async () => {
    const api = await loadModule();
    respond = () => ({ ok: false, status: 413, body: { error: "Upload is larger than the 1 GiB limit." } });

    await expect(api.uploadBackendMedia(blob(), { projectId: "proj_1", kind: "image" })).rejects.toThrow(
      "Upload is larger than the 1 GiB limit.",
    );
  });

  it("sets no Content-Type when the blob has none, rather than guessing", async () => {
    const api = await loadModule();
    respond = () => ({ status: 201, body: { url: "/x" } });

    await api.uploadBackendMedia(new Blob(["x"]), { projectId: "proj_1", kind: "image" });
    expect(new Headers(lastCall().init.headers).has("Content-Type")).toBe(false);
  });
});
