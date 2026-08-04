export const IMAGE_DECODE_TIMEOUT_MS = 10_000;

export type DecodedImageBlob = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

export type DecodeImageBlobOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type DecodeDeadline = {
  expiresAt: number;
  timeoutMs: number;
};

function timeoutError(timeoutMs: number) {
  const error = new Error(`Image decoding timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  return error;
}

function abortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Image decoding was aborted.", "AbortError");
  }
  const error = new Error("Image decoding was aborted.");
  error.name = "AbortError";
  return error;
}

function isControlError(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function remainingTime(deadline: DecodeDeadline) {
  return Math.max(0, deadline.expiresAt - Date.now());
}

function waitWithinDeadline<T>(
  source: PromiseLike<T>,
  deadline: DecodeDeadline,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return false;
      settled = true;
      cleanup();
      callback();
      return true;
    };
    const onAbort = () => settle(() => reject(abortError()));
    const remaining = remainingTime(deadline);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (remaining <= 0) {
      settle(() => reject(timeoutError(deadline.timeoutMs)));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => settle(() => reject(timeoutError(deadline.timeoutMs))), remaining);

    Promise.resolve(source).then(
      (value) => {
        if (!settle(() => resolve(value))) {
          onLateValue?.(value);
        }
      },
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function decodeWithImageElement(blob: Blob, deadline: DecodeDeadline, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (remainingTime(deadline) <= 0) return Promise.reject(timeoutError(deadline.timeoutMs));

  const objectUrl = URL.createObjectURL(blob);
  let element: HTMLImageElement;
  try {
    element = new Image();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  return new Promise<DecodedImageBlob>((resolve, reject) => {
    let settled = false;
    let revoked = false;

    const revoke = () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(objectUrl);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      element.onload = null;
      element.onerror = null;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      revoke();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        source: element,
        width: element.naturalWidth,
        height: element.naturalHeight,
        close: revoke,
      });
    };
    const onAbort = () => fail(abortError());

    element.decoding = "async";
    element.onload = succeed;
    element.onerror = () => fail(new Error("Could not decode uploaded image."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => fail(timeoutError(deadline.timeoutMs)), remainingTime(deadline));

    try {
      // Handlers must exist before src is assigned: cached/fast Blob loads are
      // allowed to complete synchronously in some browser implementations.
      element.src = objectUrl;
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Could not decode uploaded image."));
    }
  });
}

/**
 * Decode a local image Blob with one deadline shared by both browser decoders.
 * Ten seconds is intentionally generous for an in-memory Blob while still
 * bounding broken codecs/jsdom. Callers may shorten it for tests and may abort on
 * teardown. A rejection lets promptApi retain its existing original-Blob fallback.
 */
export async function decodeImageBlob(blob: Blob, options: DecodeImageBlobOptions = {}): Promise<DecodedImageBlob> {
  const timeoutMs = options.timeoutMs ?? IMAGE_DECODE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Image decode timeout must be a positive number of milliseconds.");
  }
  if (options.signal?.aborted) throw abortError();

  const deadline = { expiresAt: Date.now() + timeoutMs, timeoutMs };
  const bitmapDecoder = globalThis.createImageBitmap;
  if (typeof bitmapDecoder === "function") {
    try {
      const bitmap = await waitWithinDeadline(bitmapDecoder(blob), deadline, options.signal, (lateBitmap) => {
        lateBitmap.close();
      });
      let closed = false;
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => {
          if (closed) return;
          closed = true;
          bitmap.close();
        },
      };
    } catch (error) {
      if (isControlError(error)) throw error;
      // A genuine bitmap decode failure can still succeed through <img>.
    }
  }

  return decodeWithImageElement(blob, deadline, options.signal);
}
