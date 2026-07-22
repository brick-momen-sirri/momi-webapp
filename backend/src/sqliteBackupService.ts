import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { emitAlert, type AlertRule, type WebhookFormat } from "./healthWatchdog.js";

// How long a single azcopy invocation may run before it is treated as hung and
// killed. azcopy writes periodic progress lines plus a job summary to stdout;
// if that output is never drained and an OS pipe buffer fills, azcopy blocks on
// its own write() and would otherwise wedge this promise (and therefore the
// `running` guard in startScheduledBackups) forever. Generous because a full
// hourly snapshot set could legitimately take minutes on a slow link.
const AZCOPY_TIMEOUT_MS = 15 * 60 * 1000;

// SQLite disaster-recovery backups for the web/worker split. Each cycle takes a
// CONSISTENT hot snapshot of every database using SQLite's online backup API
// (better-sqlite3's db.backup()), which copies committed pages including any
// still living in the WAL — a plain file copy of the .sqlite would silently lose
// them. Every snapshot is a standalone single-file .sqlite (no -wal/-shm),
// integrity-checked before it is accepted, rotated to a retention window, and
// optionally shipped offsite with azcopy. This host has only one volume, so the
// offsite upload is what makes it real DR; local snapshots alone only guard
// against corruption/accidental deletion.

export type BackupTarget = { name: string; sourcePath: string };

// Removes a sqlite file together with its -wal/-shm sidecars, if present.
async function removeSqliteArtifacts(filePath: string): Promise<void> {
  await Promise.all([
    fs.rm(filePath, { force: true }),
    fs.rm(`${filePath}-wal`, { force: true }),
    fs.rm(`${filePath}-shm`, { force: true }),
  ]);
}

export type BackupResult = {
  name: string;
  ok: boolean;
  snapshotPath?: string;
  bytes?: number;
  integrity?: string;
  pageCount?: number;
  uploaded?: boolean;
  error?: string;
  durationMs?: number;
};

export type BackupCycleResult = {
  at: string;
  ok: boolean;
  uploaded: boolean;
  results: BackupResult[];
  statusPath: string;
};

// A filesystem-safe, lexically-sortable timestamp label (so a plain readdir sort
// is chronological for rotation).
export function backupLabel(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

export async function backupOneDatabase(target: BackupTarget, stagingDir: string, label: string): Promise<BackupResult> {
  const startedAt = Date.now();
  const destPath = path.join(stagingDir, `${target.name}-${label}.sqlite`);
  const tmpPath = `${destPath}.tmp`;

  try {
    // Setup lives inside the try too: a transient Windows FS error here (an AV
    // scanner or the search indexer holding a handle on a freshly-touched file,
    // for instance) must produce a clean ok:false result, not a thrown
    // rejection that would abort the whole cycle and skip every other target's
    // backup and rotation.
    await fs.mkdir(stagingDir, { recursive: true });
    await removeSqliteArtifacts(tmpPath);

    // Read-only source connection: in WAL mode this never blocks the live
    // writers, and the online backup copies the committed state (WAL included).
    const source = new Database(target.sourcePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(tmpPath);
    } finally {
      source.close();
    }

    // The backup API copies the source's header verbatim, so the snapshot
    // still claims WAL mode even though it's a single static file nobody else
    // will ever write to. Opening it read-only would make SQLite materialize
    // -wal/-shm sidecars next to tmpPath to service that claim; fs.rename below
    // only moves the main file, so those sidecars would orphan under the old
    // tmp-derived name forever (they don't end in .sqlite, so rotation would
    // never find or remove them -- an unbounded per-cycle disk leak). Opening
    // writable here and switching to DELETE mode checkpoints/removes any WAL
    // state and flips the header, so the shipped artifact is one self-contained
    // file with nothing left behind here or at restore time on another host.
    const snapshot = new Database(tmpPath);
    let integrity = "unknown";
    let pageCount = 0;
    try {
      snapshot.pragma("journal_mode = DELETE");
      integrity = String(snapshot.pragma("integrity_check", { simple: true }));
      pageCount = Number(snapshot.pragma("page_count", { simple: true }));
    } finally {
      snapshot.close();
    }
    // Backstop: remove any sidecar that might still exist (e.g. the pragma
    // itself failed after creating one) before treating tmpPath as final.
    await Promise.all([fs.rm(`${tmpPath}-wal`, { force: true }), fs.rm(`${tmpPath}-shm`, { force: true })]);

    if (integrity !== "ok") {
      await fs.rm(tmpPath, { force: true });
      return { name: target.name, ok: false, integrity, error: `integrity_check returned "${integrity}"`, durationMs: Date.now() - startedAt };
    }

    await fs.rm(destPath, { force: true });
    await fs.rename(tmpPath, destPath);
    const stat = await fs.stat(destPath);
    return { name: target.name, ok: true, snapshotPath: destPath, bytes: stat.size, integrity, pageCount, durationMs: Date.now() - startedAt };
  } catch (error) {
    await removeSqliteArtifacts(tmpPath).catch(() => undefined);
    return { name: target.name, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
  }
}

export async function rotateBackups(stagingDir: string, name: string, keep: number): Promise<string[]> {
  const entries = await fs.readdir(stagingDir).catch(() => [] as string[]);
  const mine = entries
    .filter((file) => file.startsWith(`${name}-`) && file.endsWith(".sqlite"))
    .sort(); // label is an ISO-ish timestamp, so lexical order == chronological
  const remove = mine.slice(0, Math.max(0, mine.length - keep));
  for (const file of remove) {
    await fs.rm(path.join(stagingDir, file), { force: true }).catch(() => undefined);
  }
  return remove;
}

// Insert a dated path segment before the SAS query string of a container URL,
// e.g. https://acct.blob.core.windows.net/backups?<sas>
//   ->  https://acct.blob.core.windows.net/backups/<prefix>/<file>?<sas>
export function buildAzcopyDest(sasUrl: string, prefix: string, fileName: string): string {
  const queryIndex = sasUrl.indexOf("?");
  const base = (queryIndex === -1 ? sasUrl : sasUrl.slice(0, queryIndex)).replace(/\/+$/, "");
  const query = queryIndex === -1 ? "" : sasUrl.slice(queryIndex);
  const segments = [prefix, fileName]
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `${base}/${segments}${query}`;
}

export function runAzcopy(azcopyPath: string, args: string[], timeoutMs = AZCOPY_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(azcopyPath, args, { windowsHide: true });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error(`azcopy timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    // azcopy writes progress lines and a job summary to stdout/stderr. Nothing
    // here needs that output, but it MUST be drained: an unconsumed pipe can
    // fill its OS buffer and make azcopy block on write(), hanging this promise
    // (and, transitively, every future scheduled cycle) forever.
    child.stdout?.resume();
    child.stderr?.resume();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`azcopy failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`azcopy exited with code ${code}`));
    });
  });
}

// Never logs the SAS URL (it is a credential). Uploads each file under a dated
// prefix and requests server-side overwrite so a re-run is idempotent.
export async function uploadViaAzcopy(files: string[], sasUrl: string, prefix: string, azcopyPath: string): Promise<void> {
  const dateFolder = backupLabel(Date.now()).slice(0, 10); // YYYY-MM-DD
  for (const file of files) {
    const dest = buildAzcopyDest(sasUrl, `${prefix}/${dateFolder}`, path.basename(file));
    await runAzcopy(azcopyPath, ["copy", file, dest, "--overwrite=true", "--log-level=ERROR"]);
  }
}

type AlertOpts = { role?: string; webhookUrl?: string; webhookFormat?: WebhookFormat };

// Routes backup alerts through the same emitAlert/webhook path the health
// watchdog uses (rather than a bare console.warn), so a broken offsite upload
// or a stuck azcopy is actually visible to whatever is watching ALERT_WEBHOOK_URL
// -- not only to someone tailing pm2 log files.
function raiseAlert(rule: AlertRule, detail: string, opts: AlertOpts) {
  emitAlert(
    { rule, phase: "firing", severity: "critical", detail, role: opts.role ?? "backup", pid: process.pid, atMs: Date.now() },
    { webhookUrl: opts.webhookUrl, webhookFormat: opts.webhookFormat },
  );
}

export async function runBackupCycle(opts: {
  targets: BackupTarget[];
  stagingDir: string;
  retention: number;
  label?: string;
  uploader?: (files: string[]) => Promise<void>;
  now?: () => number;
  role?: string;
  webhookUrl?: string;
  webhookFormat?: WebhookFormat;
}): Promise<BackupCycleResult> {
  const at = opts.label ?? backupLabel(opts.now ? opts.now() : Date.now());
  const results: BackupResult[] = [];
  const uploadable: string[] = [];

  for (const target of opts.targets) {
    // backupOneDatabase already catches everything internally and returns
    // ok:false rather than throwing, but this loop must never let one target
    // abort the whole cycle -- every target gets attempted and rotation still
    // runs for all of them regardless of what happens to any single one.
    let result: BackupResult;
    try {
      result = await backupOneDatabase(target, opts.stagingDir, at);
    } catch (error) {
      // The error-handling path itself must never throw, even if `target` is
      // the very thing that's malformed.
      const name = target && typeof target === "object" && "name" in target ? String((target as { name: unknown }).name) : "unknown";
      result = { name, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    if (result.ok && result.snapshotPath) uploadable.push(result.snapshotPath);
  }

  // Rotate by the names actually recorded in `results`, not by re-reading
  // `opts.targets` -- a target malformed enough to have failed above (see the
  // defensive fallback name extraction just above) could crash this loop too
  // if it dereferenced `target.name` directly a second time.
  for (const result of results) {
    await rotateBackups(opts.stagingDir, result.name, opts.retention);
  }

  let uploaded = false;
  if (opts.uploader && uploadable.length) {
    try {
      await opts.uploader(uploadable);
      uploaded = true;
      for (const result of results) if (result.ok) result.uploaded = true;
    } catch (error) {
      raiseAlert("backup_upload_failed", error instanceof Error ? error.message : String(error), opts);
    }
  }

  const snapshotsOk = results.length > 0 && results.every((result) => result.ok);
  const ok = snapshotsOk && (!opts.uploader || uploaded);
  const statusPath = path.join(opts.stagingDir, "backup-status.json");
  await fs.mkdir(opts.stagingDir, { recursive: true });
  await fs.writeFile(
    statusPath,
    `${JSON.stringify(
      {
        at,
        ok,
        uploaded,
        results: results.map((result) => ({
          name: result.name,
          ok: result.ok,
          bytes: result.bytes ?? null,
          integrity: result.integrity ?? null,
          error: result.error ?? null,
          uploaded: result.uploaded ?? false,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (!ok) {
    raiseAlert("backup_failed", `backup cycle ${at} had failures: ${results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`).join("; ") || "upload did not complete"}`, opts);
  } else {
    console.info("[backup]", { at, uploaded, dbs: results.map((r) => `${r.name}:${r.bytes ?? 0}b`).join(",") });
  }

  return { at, ok, uploaded, results, statusPath };
}

export function startScheduledBackups(opts: {
  targets: BackupTarget[];
  stagingDir: string;
  retention: number;
  intervalMs: number;
  uploader?: (files: string[]) => Promise<void>;
  role?: string;
  webhookUrl?: string;
  webhookFormat?: WebhookFormat;
}): { stop: () => void } {
  let running = false;
  const runCycle = async () => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      await runBackupCycle(opts);
    } catch (error) {
      raiseAlert("backup_failed", error instanceof Error ? error.message : String(error), opts);
    } finally {
      running = false;
    }
  };
  void runCycle(); // one shortly after boot, then on the interval
  const timer = setInterval(() => void runCycle(), opts.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
