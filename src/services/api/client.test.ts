import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiRequest } from "./client";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared API client", () => {
  it("returns a typed invalid-response error when a successful response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("HTML response")),
      } as Response),
    );

    const promise = apiRequest("/api/projects");
    await expect(promise).rejects.toMatchObject({ name: "ApiError", code: "invalid_response", status: 200 });
  });

  it("aborts a hung request at the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );

    const request = apiRequest("/api/runtime", {}, { timeoutMs: 50 });
    const assertion = expect(request).rejects.toMatchObject({ name: "ApiError", code: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("forwards a caller-owned AbortSignal without replacing it", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        observedSignal = init.signal;
        return Promise.reject(new DOMException("caller canceled", "AbortError"));
      }),
    );

    controller.abort();
    const request = apiRequest("/api/jobs", { signal: controller.signal });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    expect(observedSignal).toBe(controller.signal);
  });
});
