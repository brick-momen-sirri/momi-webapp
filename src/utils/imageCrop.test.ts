import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getImageSize } from "./imageCrop";

class ControlledImage {
  static latest: ControlledImage | undefined;
  naturalWidth = 1920;
  naturalHeight = 1080;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";

  constructor() {
    ControlledImage.latest = this;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Image", ControlledImage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ControlledImage.latest = undefined;
});

describe("getImageSize", () => {
  it("bounds an image element that never loads and removes its handlers", async () => {
    const pending = getImageSize("blob:stalled", { timeoutMs: 25 });
    const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(ControlledImage.latest?.onload).toBeNull();
    expect(ControlledImage.latest?.onerror).toBeNull();
  });

  it("clears the timeout after a successful load", async () => {
    const pending = getImageSize("blob:ready", { timeoutMs: 25 });
    ControlledImage.latest?.onload?.();

    await expect(pending).resolves.toEqual({ width: 1920, height: 1080 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be aborted during component teardown", async () => {
    const controller = new AbortController();
    const pending = getImageSize("blob:aborted", { timeoutMs: 25, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
