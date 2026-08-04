// Harness for rendering the whole App.
//
// Design choice worth stating: this stubs `fetch`, not the backendApi module.
// App imports ~40 functions from backendApi, so mocking the module means keeping
// 40 stubs in step with it forever, and every test would then be asserting
// against fictional return shapes. Stubbing the transport instead means the real
// mapping layer (mapJob, mapProject, mapUser, the media-token plumbing) runs, so
// a response shape that would break the app in production breaks it here too.
//
// Endpoints are matched by pathname and answered from `state`, which tests mutate
// before rendering. Anything unrouted returns 404 loudly rather than {}, so a new
// call site shows up as a visible failure instead of silently receiving undefined.

import { vi } from "vitest";

export type Recorded = { method: string; path: string; search: string; body?: unknown };

export type HarnessState = {
  user: Record<string, unknown> | null;
  users: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  runtime: Record<string, unknown>;
  credits: Record<string, unknown>;
  monthlyUsage: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  podStatus: Record<string, unknown>;
  comfyServers: Array<Record<string, unknown>>;
  // Per-path overrides: return {status, body} to force an error for one endpoint.
  overrides: Record<string, { status?: number; body?: unknown }>;
};

export function backendUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "usr_momen",
    name: "momen",
    displayName: "momen",
    email: "momen@brickvisual.com",
    role: "admin",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinnedProjectIds: [],
    ...overrides,
  };
}

export function backendProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_1",
    name: "Glass Tower",
    shortName: "TWR",
    client: "Acme",
    ownerId: "usr_momen",
    members: [{ userId: "usr_momen", role: "owner" }],
    groupMembers: [],
    folders: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

export function backendJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    projectId: "proj_1",
    userId: "usr_momen",
    modelId: "nano_banana",
    modelType: "Nano Banana",
    modelName: "Nano Banana",
    category: "image_editing",
    inputType: "single_image",
    prompt: "a glass tower at dusk",
    resolution: "2K",
    status: "completed",
    inputImages: [],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "image",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

// Mirrors BackendWorkflowModel. requiredInputs and outputType are required and
// mapModel dereferences requiredInputs directly, so omitting it rejects the whole
// boot Promise.all -- which is how a single missing fixture field can present as
// "the app renders but every panel is empty".
export function backendModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "nano_banana",
    name: "Nano Banana",
    category: "image_editing",
    workflowPath: "image_editing/Brick_Nano Banana 2.json",
    requiredInputs: ["image", "prompt"],
    outputType: "image" as const,
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    imageSlotCount: 1,
    ...overrides,
  };
}

export function defaultState(): HarnessState {
  return {
    user: backendUser(),
    users: [backendUser()],
    projects: [backendProject()],
    jobs: [backendJob()],
    models: [backendModel()],
    runtime: {
      generationBackend: "runpod",
      localComfyEnabled: false,
      runpodConfigured: true,
      runpodPollIntervalMs: 5000,
      runpodTimeoutMs: 2400000,
    },
    credits: { creditsRemaining: 1234.5 },
    monthlyUsage: { month: "2026-08", startAt: "", endAt: "", users: [] },
    snapshot: {},
    podStatus: { pods: [] },
    comfyServers: [],
    overrides: {},
  };
}

export type Harness = {
  state: HarnessState;
  calls: Recorded[];
  callsTo: (fragment: string) => Recorded[];
  unrouted: string[];
};

export function installBackend(state: HarnessState = defaultState()): Harness {
  const calls: Recorded[] = [];
  const unrouted: string[] = [];

  function route(path: string, method: string): { status?: number; body?: unknown } | undefined {
    const override = state.overrides[path] ?? state.overrides[`${method} ${path}`];
    if (override) return override;

    // Auth
    if (path === "/api/auth/me") {
      if (!state.user) return { status: 401, body: { error: "Authentication required." } };
      return { body: { user: state.user, mediaAccess: { token: "mt_test", expiresAt: futureIso() } } };
    }
    if (path === "/api/auth/login") {
      return {
        body: {
          token: "sess_test",
          user: state.user ?? backendUser(),
          mediaAccess: { token: "mt_test", expiresAt: futureIso() },
        },
      };
    }
    if (path === "/api/auth/logout") return { body: { ok: true } };
    if (path === "/api/media/access-token") return { body: { mediaAccess: { token: "mt_test", expiresAt: futureIso() } } };
    if (path === "/api/auth/change-password") return { body: { user: state.user } };
    if (path === "/api/auth/me/pinned-projects") return { body: { user: state.user } };

    // Catalogue and workspace
    if (path === "/api/models") return { body: { models: state.models } };
    if (path === "/api/runtime") return { body: state.runtime };
    if (path === "/api/users") return { body: { users: state.users } };
    if (path === "/api/credits") return { body: state.credits };
    if (path === "/api/usage/monthly") return { body: state.monthlyUsage };
    if (path === "/api/snapshot") return { body: state.snapshot };
    if (path === "/api/pods/status") return { body: state.podStatus };
    if (path === "/api/comfy/servers") return { body: { servers: state.comfyServers } };

    // Projects
    if (path === "/api/projects") return { body: { projects: state.projects } };
    if (/^\/api\/projects\/[^/]+$/.test(path)) return { body: { project: state.projects[0] } };
    if (/^\/api\/projects\/[^/]+\/folders/.test(path)) {
      return { body: { folders: [], folder: { folderId: "fld_1", name: "Shots" }, project: state.projects[0] } };
    }
    if (/^\/api\/projects\/[^/]+\/jobs\//.test(path)) return { body: { job: state.jobs[0] } };

    // Jobs
    if (path === "/api/jobs") {
      if (method === "POST") return { body: { job: backendJob({ id: "job_new", status: "queued" }) } };
      return { body: { jobs: state.jobs, total: state.jobs.length, limit: 30, offset: 0, hasMore: false } };
    }
    if (/^\/api\/jobs\/[^/]+\/(retry|cancel|archive|restore|permanent)$/.test(path)) {
      return { body: { job: state.jobs[0] } };
    }
    if (/^\/api\/jobs\/[^/]+$/.test(path)) return { body: { job: state.jobs[0] } };

    // Media
    if (path === "/api/media/upload") return { status: 201, body: { url: "/api/media?path=uploaded.png" } };

    unrouted.push(`${method} ${path}`);
    return undefined;
  }

  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost:8190");
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path: url.pathname, search: url.search, body });

    const result = route(url.pathname, method);
    if (!result) {
      return jsonResponse(404, { error: `Harness has no route for ${method} ${url.pathname}` });
    }
    return jsonResponse(result.status ?? 200, result.body ?? {});
  });

  return {
    state,
    calls,
    callsTo: (fragment: string) => calls.filter((call) => call.path.includes(fragment)),
    unrouted,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

function futureIso() {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}
