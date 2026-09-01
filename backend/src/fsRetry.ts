import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { RmOptions } from "node:fs";

/**
 * SMB/UNC shares report transient conditions that a local disk never produces.
 *
 * Deletes are asynchronous: the server marks an entry delete-pending and only
 * drops it once the last handle closes, so an `rmdir` issued immediately after
 * unlinking its children can see ENOTEMPTY on a directory that is empty a
 * moment later. A file still held open — by the file server's own scanner, an
 * antivirus pass, or another reader — surfaces as EBUSY or EPERM instead of
 * succeeding.
 *
 * Measured against \\10.101.41.11\ai-data$ on 2026-09-01: an 18-step suite hit
 * ENOTEMPTY on the final rmdir, and the directory listed empty on the very next
 * call. The same suite on local NVMe never produced any of these.
 *
 * EACCES is deliberately absent: that is a real permission failure and retrying
 * it only delays the error. EPERM is ambiguous on Windows — it covers both
 * sharing violations and genuine denials — so it is retried a bounded number of
 * times and then surfaced unchanged.
 *
 * This list drives `retryTransientFs`, which backs `renameWithRetry` and
 * `writeFileWithRetry`. `rmWithRetry` delegates to Node's own retry support in
 * `fs.rm` instead; that covers the same codes plus EMFILE/ENFILE.
 */
export const TRANSIENT_FS_ERROR_CODES: ReadonlySet<string> = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

export type FsRetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

// Four retries over ~25/50/100/200 ms. Long enough to outlast a delete-pending
// entry or a scanner holding a handle, short enough that a genuine EPERM still
// fails the request well inside a normal HTTP timeout.
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 200;

export function fsErrorCode(error: unknown): string {
  if (typeof error !== "object" || !error || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "");
}

export function isTransientFsError(error: unknown): boolean {
  return TRANSIENT_FS_ERROR_CODES.has(fsErrorCode(error));
}

/**
 * Runs `operation`, retrying only the transient share errors above. Any other
 * failure propagates on the first attempt, so this never masks a real bug.
 */
export async function retryTransientFs<T>(operation: () => Promise<T>, options: FsRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let waitMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      await delay(waitMs);
      waitMs = Math.min(waitMs * 2, maxDelayMs);
    }
  }
}

/**
 * `fs.rm` already retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM natively when
 * given `maxRetries`, so this delegates rather than re-implementing the loop —
 * it exists to keep one call shape across rm/rename/writeFile and to apply the
 * same budget everywhere. Node backs off linearly (retryDelay x attempt); an
 * explicit `maxRetries`/`retryDelay` in `options` still wins.
 */
export function rmWithRetry(target: string, options: RmOptions = {}, retry?: FsRetryOptions) {
  const attempts = Math.max(1, retry?.attempts ?? DEFAULT_ATTEMPTS);
  return rm(target, {
    maxRetries: attempts - 1,
    retryDelay: retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    ...options,
  });
}

export function renameWithRetry(from: string, to: string, retry?: FsRetryOptions) {
  return retryTransientFs(() => rename(from, to), retry);
}

export function writeFileWithRetry(target: string, data: Parameters<typeof writeFile>[1], retry?: FsRetryOptions) {
  return retryTransientFs(() => writeFile(target, data), retry);
}
