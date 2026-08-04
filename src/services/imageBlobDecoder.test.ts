import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeImageBlob } from "./imageBlobDecoder";

type ImageHandler = ((event?: Event) => void) | null;

class ControlledImage {
  decoding = "auto";
  naturalHeight = 180;
  naturalWidth = 320;
  onerror: ImageHandler = null;
  onload: ImageHandler = null;
  src = "";
}

let images: ControlledImage[];
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

function fallbackImage() {
  expect(images).toHaveLength(1);
  return images[0];
}

async function startFallbackDecode(timeoutMs = 100) {
  const promise = decodeImageBlob(new Blob(["image"], { type: "image/png" }), { timeoutMs });
  await vi.advanceTimersByTimeAsync(0);
  return { promise };
}

beforeEach(() => {
  vi.useFakeTimers();
  images = [];
  createObjectURL = vi.fn(() => "blob:decoded-image");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  vi.stubGlobal(
    "Image",
    class extends ControlledImage {
      constructor() {
        super();
        images.push(this);
      }
    },
  );
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bitmap decoder unavailable")));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("decodeImageBlob", () => {
  it("preserves successful HTML image decoding and releases the URL on close", async () => {
    const { promise } = await startFallbackDecode();
    const element = fallbackImage();
    expect(element.src).toBe("blob:decoded-image");
    expect(element.decoding).toBe("async");

    element.onload?.();
    const decoded = await promise;

    expect(decoded.source).toBe(element);
    expect(decoded.width).toBe(320);
    expect(decoded.height).toBe(180);
    expect(element.onload).toBeNull();
    expect(element.onerror).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    decoded.close();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("rejects onerror and revokes the object URL", async () => {
    const { promise } = await startFallbackDecode();
    fallbackImage().onerror?.();

    await expect(promise).rejects.toThrow("Could not decode uploaded image");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:decoded-image");
  });

  it("stops waiting when neither event fires", async () => {
    const { promise } = await startFallbackDecode(75);
    const rejection = expect(promise).rejects.toThrow(/timed out after 75ms/i);
    await vi.advanceTimersByTimeAsync(75);

    await rejection;
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(fallbackImage().onload).toBeNull();
  });

  it("accepts an event immediately before the deadline", async () => {
    const { promise } = await startFallbackDecode(100);
    await vi.advanceTimersByTimeAsync(99);
    fallbackImage().onload?.();
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toMatchObject({ width: 320, height: 180 });
  });

  it("ignores an event that arrives after the deadline", async () => {
    const { promise } = await startFallbackDecode(100);
    const lateOnload = fallbackImage().onload;
    const rejection = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;

    lateOnload?.();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("settles once when multiple callbacks race", async () => {
    const { promise } = await startFallbackDecode();
    const element = fallbackImage();
    const onload = element.onload;
    const onerror = element.onerror;

    onload?.();
    onerror?.();
    onload?.();
    const decoded = await promise;
    decoded.close();
    decoded.close();

    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("aborts pending HTML decoding and cleans up", async () => {
    const controller = new AbortController();
    const promise = decodeImageBlob(new Blob(["image"]), { timeoutMs: 100, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(fallbackImage().onerror).toBeNull();
  });

  it("uses createImageBitmap when available and closes it deterministically", async () => {
    const bitmap = { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));

    const decoded = await decodeImageBlob(new Blob(["image"]), { timeoutMs: 100 });
    expect(decoded).toMatchObject({ source: bitmap, width: 640, height: 360 });
    expect(createObjectURL).not.toHaveBeenCalled();
    decoded.close();
    decoded.close();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("bounds a stalled bitmap decoder and closes a bitmap that resolves late", async () => {
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    const bitmapPromise = new Promise<ImageBitmap>((resolve) => {
      resolveBitmap = resolve;
    });
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => bitmapPromise),
    );

    const promise = decodeImageBlob(new Blob(["image"]), { timeoutMs: 50 });
    const rejection = expect(promise).rejects.toThrow(/timed out after 50ms/i);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(createObjectURL).not.toHaveBeenCalled();

    resolveBitmap(bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
