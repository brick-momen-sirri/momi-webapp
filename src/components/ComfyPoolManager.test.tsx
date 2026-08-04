import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComfyPoolManager } from "./ComfyPoolManager";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ComfyPoolManager delayed refresh lifecycle", () => {
  it("cancels follow-up refreshes when the manager unmounts", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onAction = vi.fn().mockResolvedValue({
      ok: true,
      action: "start",
      port: 8188,
      message: "Starting",
      startedAt: "2026-08-04T12:00:00.000Z",
    });
    const view = render(
      <ComfyPoolManager
        servers={[{ url: "http://127.0.0.1:8188", port: 8188, status: "offline" }]}
        canManage
        onRefresh={onRefresh}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByTitle("Comfy pool settings"));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Start"));
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith("start", 8188);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();
    await act(async () => vi.runAllTimersAsync());

    expect(vi.getTimerCount()).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
