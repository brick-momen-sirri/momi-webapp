import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendCreditDashboard } from "../../services/backendApi";

const { fetchDashboard } = vi.hoisted(() => ({ fetchDashboard: vi.fn() }));

vi.mock("../../services/backendApi", () => ({
  fetchBackendCreditDashboard: (...args: unknown[]) => fetchDashboard(...args),
}));

const { useCreditDashboard } = await import("./useCreditDashboard");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function payload(generatedAt: string) {
  return { generatedAt } as BackendCreditDashboard;
}

beforeEach(() => fetchDashboard.mockReset());

describe("useCreditDashboard", () => {
  it("does not request data while the dashboard is closed", () => {
    renderHook(() => useCreditDashboard(false, "last30", "2026-07-01", "2026-07-31"));
    expect(fetchDashboard).not.toHaveBeenCalled();
  });

  it("ignores a stale response after the selected range changes", async () => {
    const first = deferred<BackendCreditDashboard>();
    const second = deferred<BackendCreditDashboard>();
    fetchDashboard.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ range }: { range: "last30" | "today" }) => useCreditDashboard(true, range, "2026-07-01", "2026-07-31"),
      { initialProps: { range: "last30" as "last30" | "today" } },
    );
    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));

    rerender({ range: "today" });
    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(payload("new-range")));
    await waitFor(() => expect(result.current.dashboard?.generatedAt).toBe("new-range"));

    await act(async () => first.resolve(payload("stale-range")));
    expect(result.current.dashboard?.generatedAt).toBe("new-range");
    expect(result.current.loading).toBe(false);
  });

  it("keeps errors from an obsolete request out of the current view", async () => {
    const first = deferred<BackendCreditDashboard>();
    fetchDashboard.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(({ open }) => useCreditDashboard(open, "last30", "2026-07-01", "2026-07-31"), {
      initialProps: { open: true },
    });
    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    rerender({ open: false });
    await act(async () => first.reject(new Error("obsolete failure")));
    expect(result.current.error).toBe("");
  });
});
