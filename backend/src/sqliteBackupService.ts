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
// Keep enough console output to retain Azure's response/error code without
// allowing a chatty child to grow this process indefinitely. The formatted
// detail is bounded again before it is included in an alert.
const AZCOPY_OUTPUT_TAIL_BYTES = 32 * 1024;
const AZCOPY_OUTPUT_DETAIL_CHARS = 6 * 1024;
const AZCOPY_OUTPUT_DETAIL_LINES = 12;
// The first generated-media baseline is currently several GiB and may run on a
// much slower link than the small SQLite snapshots. Later cycles are deltas,
// but the initial seed still needs a bounded, realistic window.
const MEDIA_AZCOPY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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

// A staging directory belongs to exactly one set of source databases. The name
// of the file is deliberately not `.sqlite`, so rotation never sees it.
const STAGING_OWNER_FILE = "staging-owner.json";
const MEDIA_OWNER_FILE = "media-backup-owner.json";
const MEDIA_CURSOR_FILE = "media-backup-cursor.json";
const MEDIA_HISTORY_FILE = "media-backup-history.json";

// A snapshot smaller than this fraction of the previous one for the same target
// is reported as suspect. Real databases grow; an order-of-magnitude collapse is
// either a genuine mass deletion (worth a human look) or the wrong source.
const SHRINK_SUSPECT_RATIO = 0.5;

export type StagingOwner = {
  // Canonical directories holding the source databases this staging dir serves.
  sourceDirs: string[];
  claimedAt: string;
  claimedBy?: { role?: string; pid: number };
};

export type StagingOwnershipVerdict =
  { ok: true; claimed: boolean; owner: StagingOwner } | { ok: false; reason: string; owner: StagingOwner; conflicting: string[] };

// Windows path semantics on Windows; POSIX elsewhere. Mirrors pathContainment's
// approach rather than inventing a second set of rules.
function canonicalDir(filePath: string): string {
  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const resolved = pathApi.dirname(pathApi.resolve(filePath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalPath(filePath: string): string {
  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const resolved = pathApi.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Malformed targets are skipped rather than thrown on: the cycle's contract is
// that one bad target never aborts the others (see runBackupCycle), and such a
// target fails on its own merits a few lines later anyway.
function uniqueSourceDirs(targets: BackupTarget[]): string[] {
  const dirs = targets
    .filter(
      (target): target is BackupTarget =>
        Boolean(target) && typeof target?.sourcePath === "string" && target.sourcePath.length > 0,
    )
    .map((target) => canonicalDir(target.sourcePath));
  return [...new Set(dirs)].sort();
}

export async function readStagingOwner(stagingDir: string): Promise<StagingOwner | null> {
  try {
    const raw = await fs.readFile(path.join(stagingDir, STAGING_OWNER_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const dirs = (parsed as { sourceDirs?: unknown }).sourceDirs;
    if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === "string")) return null;
    return parsed as StagingOwner;
  } catch {
    // Missing or unreadable: treat as unclaimed. A corrupt marker must not be
    // able to wedge backups permanently -- the claim below simply rewrites it.
    return null;
  }
}

/**
 * A staging directory serves one set of source databases, and this is the gate
 * that enforces it.
 *
 * Without it, any process started from this repo inherits the repo-anchored
 * default staging directory (config.ts `backupStagingDir`) while pointing
 * JOBS_SQLITE_PATH/APP_STATE_SQLITE_PATH somewhere else -- which is exactly what
 * the topology load test does. Such a process deposits snapshots of its own
 * throwaway databases into production backup history, where they pass
 * integrity_check, look identical to real snapshots, and evict genuine ones to
 * honour the retention count. That happened on 2026-08-05.
 *
 * First use claims the directory; afterwards every target's source directory
 * must already be recorded. A newly added target in the same data directory
 * passes; a different data directory is refused. The remedy for a deliberate
 * move is documented in backend/docs/sqlite-dr-runbook.md: delete the marker, or
 * point SQLITE_BACKUP_STAGING_DIR at a directory of your own.
 */
export async function ensureStagingOwnership(
  stagingDir: string,
  targets: BackupTarget[],
  opts: { role?: string; now?: () => number } = {},
): Promise<StagingOwnershipVerdict> {
  const sourceDirs = uniqueSourceDirs(targets);
  const existing = await readStagingOwner(stagingDir);

  if (!existing) {
    const owner: StagingOwner = {
      sourceDirs,
      claimedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
      claimedBy: { role: opts.role, pid: process.pid },
    };
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(path.join(stagingDir, STAGING_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    return { ok: true, claimed: true, owner };
  }

  const conflicting = sourceDirs.filter((dir) => !existing.sourceDirs.includes(dir));
  if (conflicting.length) {
    return {
      ok: false,
      reason: `staging directory is owned by [${existing.sourceDirs.join(", ")}] but this process backs up [${conflicting.join(", ")}]`,
      owner: existing,
      conflicting,
    };
  }
  return { ok: true, claimed: false, owner: existing };
}

// Size of the newest existing snapshot for a target, or null if this is the
// first. Must be read BEFORE the new snapshot lands.
export async function newestSnapshotBytes(stagingDir: string, name: string): Promise<number | null> {
  const entries = await fs.readdir(stagingDir).catch(() => [] as string[]);
  const mine = entries.filter((file) => file.startsWith(`${name}-`) && file.endsWith(".sqlite")).sort();
  const newest = mine.at(-1);
  if (!newest) return null;
  const stat = await fs.stat(path.join(stagingDir, newest)).catch(() => null);
  return stat ? stat.size : null;
}

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
  // Set when the snapshot is valid but collapsed in size against the previous
  // one for the same target. Never blocks the cycle; a genuine mass deletion
  // still has to be backed up.
  shrinkSuspect?: boolean;
  previousBytes?: number | null;
};

export type BackupCycleResult = {
  at: string;
  ok: boolean;
  uploaded: boolean;
  results: BackupResult[];
  media?: MediaBackupResult;
  statusPath: string;
};

export type MediaBackupResult = {
  ok: boolean;
  uploaded: boolean;
  sourceDir: string;
  cycleLabel?: string;
  baseline?: boolean;
  incrementalSince?: string | null;
  files?: number;
  bytes?: number;
  completedAt?: string;
  error?: string;
};

type MediaBackupOwner = {
  sourceDir: string;
  claimedAt: string;
  claimedBy?: { role?: string; pid: number };
};

type MediaBackupCursor = {
  sourceDir: string;
  lastSuccessfulStartedAt: string;
  completedAt: string;
  cycleLabel: string;
};

type MediaBackupHistory = {
  version: 1;
  sourceDir: string;
  cycles: Array<{
    cycleLabel: string;
    baseline: boolean;
    incrementalSince: string | null;
    startedAt: string;
    completedAt: string;
    inventory: { files: number; bytes: number };
  }>;
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
      return {
        name: target.name,
        ok: false,
        integrity,
        error: `integrity_check returned "${integrity}"`,
        durationMs: Date.now() - startedAt,
      };
    }

    await fs.rm(destPath, { force: true });
    await fs.rename(tmpPath, destPath);
    const stat = await fs.stat(destPath);
    return {
      name: target.name,
      ok: true,
      snapshotPath: destPath,
      bytes: stat.size,
      integrity,
      pageCount,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    await removeSqliteArtifacts(tmpPath).catch(() => undefined);
    return {
      name: target.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function rotateBackups(stagingDir: string, name: string, keep: number): Promise<string[]> {
  const entries = await fs.readdir(stagingDir).catch(() => [] as string[]);
  const mine = entries.filter((file) => file.startsWith(`${name}-`) && file.endsWith(".sqlite")).sort(); // label is an ISO-ish timestamp, so lexical order == chronological
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

function appendOutputTail(tail: Buffer, chunk: Buffer | string): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (incoming.length >= AZCOPY_OUTPUT_TAIL_BYTES) return incoming.subarray(incoming.length - AZCOPY_OUTPUT_TAIL_BYTES);
  const keep = Math.min(tail.length, AZCOPY_OUTPUT_TAIL_BYTES - incoming.length);
  return Buffer.concat([tail.subarray(tail.length - keep), incoming]);
}

function formatAzcopyOutput(tail: Buffer): string {
  const sasKeys = "sig|sv|sp|st|se|sr|srt|ss|spr|sip|skoid|sktid|skt|ske|sks|skv";
  const redacted = tail
    .toString("utf8")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:\/\/[^\s\"'<>]+/gi, (candidate) => {
      const queryIndex = candidate.indexOf("?");
      if (queryIndex === -1) return candidate;
      const query = candidate.slice(queryIndex + 1);
      return new RegExp(`(?:^|&)(?:${sasKeys})=`, "i").test(query)
        ? `${candidate.slice(0, queryIndex)}?[redacted-sas]`
        : candidate;
    })
    // Also cover AzCopy output that prints a bare query fragment rather than a
    // complete URL. In particular, never put the SAS signature in an alert.
    .replace(new RegExp(`\\b(${sasKeys})=([^&\\s\"']+)`, "gi"), "$1=[redacted]");
  const lines = redacted
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-AZCOPY_OUTPUT_DETAIL_LINES);
  const detail = lines.join("\n");
  return detail.length > AZCOPY_OUTPUT_DETAIL_CHARS ? `...${detail.slice(-AZCOPY_OUTPUT_DETAIL_CHARS)}` : detail;
}

export function runAzcopy(azcopyPath: string, args: string[], timeoutMs = AZCOPY_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(azcopyPath, args, { windowsHide: true });
    let settled = false;
    let outputTail: Buffer = Buffer.alloc(0);

    const errorWithOutput = (message: string) => {
      const detail = formatAzcopyOutput(outputTail);
      return new Error(detail ? `${message}\nAzCopy output (tail):\n${detail}` : message);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      reject(errorWithOutput(`azcopy timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    // azcopy writes progress lines and a job summary to stdout/stderr. Nothing
    // here needs the full output, but it MUST be drained: an unconsumed pipe can
    // fill its OS buffer and make azcopy block on write(), hanging this promise
    // (and, transitively, every future scheduled cycle) forever. Retain only a
    // bounded tail so a failure includes Azure's useful response/error code.
    const captureOutput = (chunk: Buffer | string) => {
      outputTail = appendOutputTail(outputTail, chunk);
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`azcopy failed to start: ${error.message}`));
    });
    // `close` waits for stdout/stderr to close, unlike `exit`, so the final
    // Azure error lines are guaranteed to have reached captureOutput first.
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const signalDetail = signal ? ` (signal ${signal})` : "";
        reject(errorWithOutput(`azcopy exited with code ${code ?? "unknown"}${signalDetail}`));
      }
    });
  });
}

// Never logs the SAS URL (it is a credential). Uploads each file under a dated
// prefix and requests server-side overwrite so a re-run is idempotent.
export async function uploadViaAzcopy(
  files: string[],
  sasUrl: string,
  prefix: string,
  azcopyPath: string,
  runner: typeof runAzcopy = runAzcopy,
): Promise<void> {
  const dateFolder = backupLabel(Date.now()).slice(0, 10); // YYYY-MM-DD
  const failures: Array<{ file: string; error: Error }> = [];
  for (const file of files) {
    const dest = buildAzcopyDest(sasUrl, `${prefix}/${dateFolder}`, path.basename(file));
    try {
      await runner(azcopyPath, ["copy", file, dest, "--overwrite=true", "--log-level=ERROR"]);
    } catch (error) {
      failures.push({ file, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  if (failures.length) {
    const detail = failures.map(({ file, error }) => `${path.basename(file)}: ${error.message}`).join("\n\n");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${failures.length} of ${files.length} database uploads failed:\n${detail}`,
    );
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path.basename(filePath)} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Windows rename does not consistently replace an existing destination.
    // The completed temp file is already durable, so replace only after it is
    // ready and make one final rename attempt.
    if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

export async function ensureMediaBackupOwnership(
  stagingDir: string,
  sourceDir: string,
  opts: { role?: string; now?: () => number } = {},
): Promise<{ claimed: boolean; owner: MediaBackupOwner }> {
  const markerPath = path.join(stagingDir, MEDIA_OWNER_FILE);
  const canonicalSource = canonicalPath(sourceDir);
  const existing = await readJsonFile<MediaBackupOwner>(markerPath);
  if (existing) {
    if (typeof existing.sourceDir !== "string" || canonicalPath(existing.sourceDir) !== canonicalSource) {
      throw new Error(`media backup staging is owned by ${String(existing.sourceDir)} but this process uses ${canonicalSource}`);
    }
    return { claimed: false, owner: existing };
  }

  const owner: MediaBackupOwner = {
    sourceDir: canonicalSource,
    claimedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    claimedBy: { role: opts.role, pid: process.pid },
  };
  await writeJsonAtomically(markerPath, owner);
  return { claimed: true, owner };
}

async function mediaInventory(rootDir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  const visit = async (directory: string): Promise<void> => {
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory !== rootDir) return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          files += 1;
          bytes += stat.size;
        } catch (error) {
          // A temporary upload can disappear while the live tree is scanned.
          // AzCopy handles the same race; do not fail the whole DR cycle for an
          // entry that no longer exists by the time it is inspected.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      // Deliberately do not follow symlinks out of the owned media root.
    }
  };

  await visit(rootDir);
  return { files, bytes };
}

/**
 * Uploads one append-only generated-media cycle.
 *
 * The first successful cycle is a full baseline. Later cycles use AzCopy's
 * local --include-after filter and land in new timestamped prefixes, so no
 * backup blob is ever deleted or overwritten. A manifest is uploaded last as
 * the commit marker; a partially uploaded cycle has no manifest and is ignored
 * during restore. The local cursor advances only after that marker succeeds.
 */
export async function backupMediaViaAzcopy(opts: {
  sourceDir: string;
  stagingDir: string;
  sasUrl: string;
  prefix: string;
  azcopyPath: string;
  role?: string;
  now?: () => number;
  runner?: (azcopyPath: string, args: string[], timeoutMs?: number) => Promise<void>;
}): Promise<MediaBackupResult> {
  const startedMs = opts.now ? opts.now() : Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const cycleLabel = backupLabel(startedMs);
  const sourceDir = canonicalPath(opts.sourceDir);
  const stat = await fs.stat(sourceDir);
  if (!stat.isDirectory()) throw new Error(`media backup source is not a directory: ${sourceDir}`);

  await ensureMediaBackupOwnership(opts.stagingDir, sourceDir, { role: opts.role, now: opts.now });
  const cursorPath = path.join(opts.stagingDir, MEDIA_CURSOR_FILE);
  const cursor = await readJsonFile<MediaBackupCursor>(cursorPath);
  if (cursor && (typeof cursor.sourceDir !== "string" || canonicalPath(cursor.sourceDir) !== sourceDir)) {
    throw new Error(`media backup cursor belongs to ${String(cursor.sourceDir)} but this process uses ${sourceDir}`);
  }
  const historyPath = path.join(opts.stagingDir, MEDIA_HISTORY_FILE);
  const history = await readJsonFile<MediaBackupHistory>(historyPath);
  if (
    history &&
    (history.version !== 1 ||
      typeof history.sourceDir !== "string" ||
      canonicalPath(history.sourceDir) !== sourceDir ||
      !Array.isArray(history.cycles))
  ) {
    throw new Error(`media backup history does not belong to ${sourceDir} or has an unsupported format`);
  }
  if (cursor && !history) {
    throw new Error("media backup cursor exists without media-backup-history.json; refusing to lose the restore chain");
  }

  const incrementalSince = cursor?.lastSuccessfulStartedAt ?? null;
  const inventory = await mediaInventory(sourceDir);
  const destinationPrefix = `${opts.prefix}/media/cycles/${cycleLabel}`;
  const destination = buildAzcopyDest(opts.sasUrl, destinationPrefix, "");
  const args = [
    "copy",
    path.join(sourceDir, "*"),
    destination,
    "--recursive=true",
    "--overwrite=true",
    "--put-md5=true",
    "--log-level=ERROR",
  ];
  if (incrementalSince) args.push(`--include-after=${incrementalSince}`);

  const runner = opts.runner ?? runAzcopy;
  await runner(opts.azcopyPath, args, MEDIA_AZCOPY_TIMEOUT_MS);

  // Upload the manifest last. Its presence is the offsite proof that AzCopy
  // completed this cycle; failed/partial prefixes never get a commit marker.
  const manifestPath = path.join(opts.stagingDir, `.media-backup-${cycleLabel}.json`);
  const completedAt = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const manifest = {
    version: 1,
    cycleLabel,
    sourceDir,
    baseline: !cursor,
    incrementalSince,
    startedAt,
    completedAt,
    inventory,
    restore:
      "Apply every manifested cycle in cycleLabel order; later files overwrite earlier ones. Deletions are intentionally not propagated.",
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  try {
    const manifestDestination = buildAzcopyDest(opts.sasUrl, destinationPrefix, "backup-manifest.json");
    await runner(opts.azcopyPath, ["copy", manifestPath, manifestDestination, "--overwrite=true", "--log-level=ERROR"]);
  } finally {
    await fs.rm(manifestPath, { force: true }).catch(() => undefined);
  }

  // Keep a fixed, downloadable index of the append-only chain. The production
  // SAS does not need List permission: after host loss an operator can generate
  // a temporary Read SAS and fetch this known path to discover every complete
  // baseline/delta in restore order. Write the local history first; if the
  // index upload fails, the next retry republishes the already-valid manifested
  // cycle instead of forgetting it.
  const nextHistory: MediaBackupHistory = {
    version: 1,
    sourceDir,
    cycles: [
      ...(history?.cycles ?? []),
      {
        cycleLabel,
        baseline: !cursor,
        incrementalSince,
        startedAt,
        completedAt,
        inventory,
      },
    ],
  };
  await writeJsonAtomically(historyPath, nextHistory);
  const restoreIndexDestination = buildAzcopyDest(opts.sasUrl, `${opts.prefix}/media`, "restore-index.json");
  await runner(opts.azcopyPath, ["copy", historyPath, restoreIndexDestination, "--overwrite=true", "--log-level=ERROR"]);

  await writeJsonAtomically(cursorPath, {
    sourceDir,
    lastSuccessfulStartedAt: startedAt,
    completedAt,
    cycleLabel,
  } satisfies MediaBackupCursor);

  return {
    ok: true,
    uploaded: true,
    sourceDir,
    cycleLabel,
    baseline: !cursor,
    incrementalSince,
    files: inventory.files,
    bytes: inventory.bytes,
    completedAt,
  };
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
  mediaUploader?: () => Promise<MediaBackupResult>;
  mediaSourceDir?: string;
  now?: () => number;
  role?: string;
  webhookUrl?: string;
  webhookFormat?: WebhookFormat;
}): Promise<BackupCycleResult> {
  const at = opts.label ?? backupLabel(opts.now ? opts.now() : Date.now());
  const results: BackupResult[] = [];
  const uploadable: string[] = [];

  // Ownership is checked before anything is written, and a conflicted cycle
  // writes NOTHING into the directory -- not a snapshot, and not
  // backup-status.json either. Overwriting another deployment's status file
  // would itself destroy evidence and make a healthy backup set look like it
  // belonged to this process.
  const ownership = await ensureStagingOwnership(opts.stagingDir, opts.targets, { role: opts.role, now: opts.now });
  if (!ownership.ok) {
    raiseAlert("backup_staging_conflict", `refusing to write backups: ${ownership.reason}`, opts);
    console.error("[backup] staging conflict, no snapshot written", {
      at,
      stagingDir: opts.stagingDir,
      ownedBy: ownership.owner.sourceDirs,
      conflicting: ownership.conflicting,
    });
    return {
      at,
      ok: false,
      uploaded: false,
      results: opts.targets.map((target) => ({
        name: target?.name ?? "unknown",
        ok: false,
        error: `staging directory conflict: ${ownership.reason}`,
      })),
      statusPath: path.join(opts.stagingDir, "backup-status.json"),
    };
  }

  // Captured before the new snapshots land, so each target can be compared
  // against its own immediate predecessor.
  const previousBytes = new Map<string, number | null>();
  for (const target of opts.targets) {
    if (target && typeof target === "object" && "name" in target) {
      previousBytes.set(String(target.name), await newestSnapshotBytes(opts.stagingDir, String(target.name)));
    }
  }

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
      const name =
        target && typeof target === "object" && "name" in target ? String((target as { name: unknown }).name) : "unknown";
      result = { name, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // integrity_check cannot tell a good backup of the right database from a
    // good backup of the wrong one -- an empty database is perfectly intact. A
    // size collapse against the previous snapshot is the cheap, stateless signal
    // that something changed identity, so it is reported rather than swallowed.
    const prior = previousBytes.get(result.name) ?? null;
    result.previousBytes = prior;
    if (result.ok && prior !== null && prior > 0 && (result.bytes ?? 0) < prior * SHRINK_SUSPECT_RATIO) {
      result.shrinkSuspect = true;
      raiseAlert(
        "backup_shrink_suspect",
        `${result.name} snapshot ${at} is ${result.bytes ?? 0} bytes, down from ${prior} -- verify the source database before relying on this snapshot`,
        opts,
      );
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

  let databaseUploaded = false;
  if (opts.uploader && uploadable.length) {
    try {
      await opts.uploader(uploadable);
      databaseUploaded = true;
      for (const result of results) if (result.ok) result.uploaded = true;
    } catch (error) {
      raiseAlert("backup_upload_failed", error instanceof Error ? error.message : String(error), opts);
    }
  }

  let media: MediaBackupResult | undefined;
  if (opts.mediaUploader) {
    try {
      media = await opts.mediaUploader();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      media = {
        ok: false,
        uploaded: false,
        sourceDir: opts.mediaSourceDir ?? "unknown",
        error: detail,
      };
      raiseAlert("backup_upload_failed", `generated media: ${detail}`, opts);
    }
  }

  const snapshotsOk = results.length > 0 && results.every((result) => result.ok);
  const uploaded = databaseUploaded && (!opts.mediaUploader || media?.uploaded === true);
  const ok = snapshotsOk && (!opts.uploader || databaseUploaded) && (!opts.mediaUploader || media?.ok === true);
  const statusPath = path.join(opts.stagingDir, "backup-status.json");
  await fs.mkdir(opts.stagingDir, { recursive: true });
  await fs.writeFile(
    statusPath,
    `${JSON.stringify(
      {
        at,
        ok,
        uploaded,
        media: media
          ? {
              ok: media.ok,
              uploaded: media.uploaded,
              sourceDir: media.sourceDir,
              cycleLabel: media.cycleLabel ?? null,
              baseline: media.baseline ?? null,
              incrementalSince: media.incrementalSince ?? null,
              files: media.files ?? null,
              bytes: media.bytes ?? null,
              completedAt: media.completedAt ?? null,
              error: media.error ?? null,
            }
          : null,
        results: results.map((result) => ({
          name: result.name,
          ok: result.ok,
          bytes: result.bytes ?? null,
          previousBytes: result.previousBytes ?? null,
          pageCount: result.pageCount ?? null,
          integrity: result.integrity ?? null,
          shrinkSuspect: result.shrinkSuspect ?? false,
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
    raiseAlert(
      "backup_failed",
      `backup cycle ${at} had failures: ${
        [
          ...results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`),
          ...(media && !media.ok ? [`generated media: ${media.error ?? "upload did not complete"}`] : []),
        ].join("; ") || "upload did not complete"
      }`,
      opts,
    );
  } else {
    console.info("[backup]", {
      at,
      uploaded,
      dbs: results.map((r) => `${r.name}:${r.bytes ?? 0}b`).join(","),
      media: media ? `${media.files ?? 0} files/${media.bytes ?? 0}b/${media.baseline ? "baseline" : "delta"}` : "disabled",
    });
  }

  return { at, ok, uploaded, results, media, statusPath };
}

export function startScheduledBackups(opts: {
  targets: BackupTarget[];
  stagingDir: string;
  retention: number;
  intervalMs: number;
  uploader?: (files: string[]) => Promise<void>;
  mediaUploader?: () => Promise<MediaBackupResult>;
  mediaSourceDir?: string;
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
