// Proves the render-output share is actually writable, on a timer.
//
// Since output and uploads moved to \\10.101.41.11\ai-data$, storage is a
// network dependency: if the share goes away, or the svc_momi_storage
// credential is rotated out from under Credential Manager, Momi loses all
// reads and writes. That exact outage already happened once, from 2026-08-28
// until 2026-08-31, and the way it surfaced was a person noticing.
//
// A read-only check is not enough. The failure modes worth catching are a
// dropped session, an expired credential and a full volume, and only a write
// exercises all three. So this writes a small file, reads it back, and deletes
// it -- the same round trip a render does, minus the bytes.
//
// Fires `storage_unreachable` on the first failure and resolves when a later
// probe succeeds, so a blip does not need manual acknowledgement.

import fs from "node:fs/promises";
import path from "node:path";

import { emitAlert } from "./healthWatchdog.js";
import { rmWithRetry } from "./fsRetry.js";

export type StorageCanaryOptions = {
  root: string;
  intervalMs: number;
  webhookUrl?: string;
  webhookFormat?: "json" | "slack";
  role?: string;
};

export type StorageCanaryResult = {
  ok: boolean;
  durationMs: number;
  error?: string;
};

let timer: NodeJS.Timeout | undefined;
let failing = false;

/** One write/read/delete round trip against the storage root. */
export async function probeStorage(root: string): Promise<StorageCanaryResult> {
  const startedAt = Date.now();
  // pid keeps two roles (api + dispatcher) from colliding on the same probe file.
  const probePath = path.join(root, `.momi-storage-canary-${process.pid}`);
  const payload = `momi storage canary ${new Date().toISOString()}`;

  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(probePath, payload, "utf8");
    const readBack = await fs.readFile(probePath, "utf8");
    if (readBack !== payload) {
      throw new Error(`read-back mismatch: wrote ${payload.length} bytes, read ${readBack.length}`);
    }
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`.trim() : String(error),
    };
  } finally {
    // Never let cleanup failure mask the probe result: a leftover probe file is
    // harmless and the next run overwrites it.
    await rmWithRetry(probePath, { force: true }).catch(() => undefined);
  }
}

export async function runStorageCanaryOnce(opts: StorageCanaryOptions): Promise<StorageCanaryResult> {
  const result = await probeStorage(opts.root);

  if (!result.ok && !failing) {
    failing = true;
    emitAlert(
      {
        rule: "storage_unreachable",
        phase: "firing",
        severity: "critical",
        detail: `storage root ${opts.root} failed a write/read/delete probe after ${result.durationMs} ms: ${result.error}`,
        role: opts.role ?? "storage",
        pid: process.pid,
        atMs: Date.now(),
      },
      { webhookUrl: opts.webhookUrl, webhookFormat: opts.webhookFormat },
    );
  } else if (result.ok && failing) {
    failing = false;
    emitAlert(
      {
        rule: "storage_unreachable",
        phase: "resolved",
        severity: "critical",
        detail: `storage root ${opts.root} is writable again (${result.durationMs} ms)`,
        role: opts.role ?? "storage",
        pid: process.pid,
        atMs: Date.now(),
      },
      { webhookUrl: opts.webhookUrl, webhookFormat: opts.webhookFormat },
    );
  }

  return result;
}

export function startStorageCanary(opts: StorageCanaryOptions) {
  stopStorageCanary();
  // Probe once at boot so a share that is already down is reported immediately
  // rather than one interval later.
  void runStorageCanaryOnce(opts).catch(() => undefined);
  timer = setInterval(() => {
    void runStorageCanaryOnce(opts).catch(() => undefined);
  }, Math.max(10_000, opts.intervalMs));
  timer.unref?.();
  return timer;
}

export function stopStorageCanary() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export function _resetStorageCanaryStateForTests() {
  stopStorageCanary();
  failing = false;
}
