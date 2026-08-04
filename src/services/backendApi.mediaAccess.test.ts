// The media access token lifecycle.
//
// This is the highest-value thing to test in this file: media URLs are built
// synchronously during render from a token that is refreshed on a timer, so a
// mistake here does not throw -- it silently produces broken <img> tags some
// minutes after a tab was opened, which is exactly the failure a test suite
// should catch and a human never will.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = { url: string; init?: RequestInit };

let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => unknown;

// Re-imported per test so the module-level token cache starts empty each time.
async function loadModule() {
  vi.resetModules();
  return import("./backendApi.js");
}

function authUser(overrides: Record<string, unknown> = {}) {
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

function mediaAccess(token: string, ttlMs: number) {
  return { token, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

beforeEach(() => {
  calls = [];
  handler = () => ({});
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = handler(String(url), init);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    } as Response);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token issuance", () => {
  it("uses the media token from the login response on media URLs, not the session token", async () => {
    const api = await loadModule();
    handler = () => ({ token: "sess_SECRET", user: authUser(), mediaAccess: mediaAccess("mt_abc", 30 * 60_000) });

    await api.signInBackend("momen@brickvisual.com", "pw");

    const url = api.backendResultFileUrl("job_1");
    expect(url).toContain("access_token=mt_abc");
    // The regression this file exists for.
    expect(url).not.toContain("sess_SECRET");
  });

  it("picks up a token from session restore on a page reload", async () => {
    const api = await loadModule();
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_restored", 30 * 60_000) });

    await api.fetchCurrentAccount();

    expect(api.backendResultMediaUrl("job_1")).toContain("access_token=mt_restored");
  });

  it("appends the token with & when the URL already has a query string", async () => {
    const api = await loadModule();
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_abc", 30 * 60_000) });
    await api.fetchCurrentAccount();

    // result-media always carries ?index=
    const url = api.backendResultMediaUrl("job_1", 2);
    expect(url).toContain("index=2");
    expect(url).toContain("&access_token=mt_abc");
    expect(url.match(/\?/g)).toHaveLength(1);
  });

  it("leaves media URLs unauthenticated when no token has been issued", async () => {
    const api = await loadModule();
    // No sign-in: same-origin requests still carry the momi_session cookie, so an
    // un-suffixed URL is the correct fallback rather than a broken one.
    expect(api.backendResultFileUrl("job_1")).not.toContain("access_token");
  });
});

describe("refresh", () => {
  it("refreshes ahead of expiry, and the new token is used immediately", async () => {
    vi.useFakeTimers();
    const api = await loadModule();
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_first", 30 * 60_000) });
    await api.fetchCurrentAccount();
    api.setStoredAuthToken("sess_SECRET");

    expect(api.backendResultFileUrl("job_1")).toContain("access_token=mt_first");

    handler = () => ({ mediaAccess: mediaAccess("mt_second", 30 * 60_000) });
    // Refresh is scheduled at 60% of the 30 minute lifetime = 18 minutes.
    await vi.advanceTimersByTimeAsync(18 * 60_000 + 100);

    expect(calls.some((c) => c.url.includes("/api/media/access-token"))).toBe(true);
    expect(api.backendResultFileUrl("job_1")).toContain("access_token=mt_second");
  });

  it("does not refresh before 60% of the lifetime has elapsed", async () => {
    vi.useFakeTimers();
    const api = await loadModule();
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_first", 30 * 60_000) });
    await api.fetchCurrentAccount();
    api.setStoredAuthToken("sess_SECRET");

    await vi.advanceTimersByTimeAsync(17 * 60_000);
    expect(calls.filter((c) => c.url.includes("/api/media/access-token"))).toHaveLength(0);
  });

  it("keeps the old token when a refresh fails, rather than dropping the credential", async () => {
    vi.useFakeTimers();
    const api = await loadModule();
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_first", 30 * 60_000) });
    await api.fetchCurrentAccount();
    api.setStoredAuthToken("sess_SECRET");

    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    await vi.advanceTimersByTimeAsync(18 * 60_000 + 100);

    // Still valid for the remaining 40% of its life; dropping it would break
    // every image on the page for no reason.
    expect(api.backendResultFileUrl("job_1")).toContain("access_token=mt_first");
  });

  it("does not ask for a refresh when there is no session to refresh against", async () => {
    vi.useFakeTimers();
    const api = await loadModule();
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_first", 30 * 60_000) });
    await api.fetchCurrentAccount();
    // Deliberately no setStoredAuthToken: a signed-out page must not poll.

    await vi.advanceTimersByTimeAsync(18 * 60_000 + 100);
    expect(calls.filter((c) => c.url.includes("/api/media/access-token"))).toHaveLength(0);
  });

  it("floors the refresh delay so a very short TTL cannot spin", async () => {
    vi.useFakeTimers();
    const api = await loadModule();
    // 60% of 1s would be 600ms; the floor is 30s.
    handler = () => ({ user: authUser(), mediaAccess: mediaAccess("mt_short", 1_000) });
    await api.fetchCurrentAccount();
    api.setStoredAuthToken("sess_SECRET");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c.url.includes("/api/media/access-token"))).toHaveLength(0);

    handler = () => ({ mediaAccess: mediaAccess("mt_next", 1_000) });
    await vi.advanceTimersByTimeAsync(26_000);
    expect(calls.filter((c) => c.url.includes("/api/media/access-token"))).toHaveLength(1);
  });
});

describe("teardown", () => {
  it("drops the token on logout and stops refreshing", async () => {
    vi.useFakeTimers();
    const api = await loadModule();
    handler = () => ({ token: "sess_SECRET", user: authUser(), mediaAccess: mediaAccess("mt_abc", 30 * 60_000) });
    await api.signInBackend("momen@brickvisual.com", "pw");
    expect(api.backendResultFileUrl("job_1")).toContain("access_token=mt_abc");

    handler = () => ({ ok: true });
    await api.logoutBackend();

    expect(api.backendResultFileUrl("job_1")).not.toContain("access_token");

    // The scheduled refresh must be cancelled, not merely ignored.
    calls = [];
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls.filter((c) => c.url.includes("/api/media/access-token"))).toHaveLength(0);
  });

  it("tolerates a backend that returns no mediaAccess field", async () => {
    const api = await loadModule();
    // An older backend, or a rollback: the app must still work off the cookie.
    handler = () => ({ user: authUser() });
    await expect(api.fetchCurrentAccount()).resolves.toMatchObject({ id: "usr_momen" });
    expect(api.backendResultFileUrl("job_1")).not.toContain("access_token");
  });
});
