// A second offsite leg for the database snapshots, onto a filesystem path.
//
// Why this exists: until 2026-08-27 Azure was the only offsite destination, so
// "offsite" was one provider. The momiai storage account was disabled that week
// for a billing reason, which took the entire offsite copy with it -- writes
// first, then reads -- and left the local staging directory on a single C: drive
// as the only surviving copy of jobs, app-state and archived-items. Nothing was
// wrong with the backup code; the leg simply had no redundancy.
//
// So this is deliberately the least similar thing to the Azure leg that still
// counts as offsite: no SAS, no credential, no provider, no subscription. A
// directory. Point it at a network share, a second physical disk, anything whose
// failure is uncorrelated with a cloud account.
//
// SCOPE: database snapshots only, not generated media. The databases are what
// disaster recovery actually turns on -- they hold every job, project and media
// reference, they are ~40 MB in total, and they cannot be regenerated. Generated
// media is orders of magnitude larger and already has a cursor-based incremental
// mechanism built around azcopy (backupMediaViaAzcopy); re-implementing that over
// SMB is separate work, and a partial media mirror would be worse than an honest
// gap. See backend/docs/sqlite-dr-runbook.md.
//
// The mirror uses the SAME layout and filenames as the staging directory --
// `<name>-<label>.sqlite`, flat -- rather than a dated tree. That means the
// restore procedure in the runbook applies to it unchanged: point the restore at
// the mirror instead of at staging and nothing else differs. A cleverer layout
// would buy nothing and cost a second restore path to keep correct.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MIRROR_OWNER_FILE = "mirror-owner.json";

export type BackupMirrorFileResult = {
  /** The snapshot's file name, e.g. `jobs-2026-08-27T07-13-09-966Z.sqlite`. */
  file: string;
  ok: boolean;
  bytes?: number;
  error?: string;
};

export type BackupMirrorResult = {
  ok: boolean;
  destinationDir: string;
  files: BackupMirrorFileResult[];
  pruned: string[];
  /** Set when the whole leg failed before any file was attempted. */
  error?: string;
  completedAt?: string;
};

export type MirrorOwner = {
  // Canonical directories holding the source databases this mirror serves.
  sourceDirs: string[];
  // Unlike a local staging directory, a share is genuinely reachable by more
  // than one machine, so the host is part of the identity rather than incidental.
  host: string;
  claimedAt: string;
  claimedBy?: { role?: string; pid: number };
};

export type MirrorOwnershipVerdict =
  | { ok: true; claimed: boolean; owner: MirrorOwner }
  | { ok: false; reason: string; owner: MirrorOwner };

function canonicalPath(filePath: string): string {
  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const resolved = pathApi.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Is `candidate` the same directory as `other`, or inside it?
 *
 * Used to refuse a mirror pointed at the staging directory. That would not be a
 * mirror at all: both would rotate the same files, each leg's prune would evict
 * the other's history, and the "second copy" would be the first copy under
 * another name -- while every status field claimed two.
 */
export function isSameOrInside(candidate: string, other: string): boolean {
  const a = canonicalPath(candidate);
  const b = canonicalPath(other);
  if (a === b) return true;
  const sep = process.platform === "win32" ? path.win32.sep : path.posix.sep;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export async function readMirrorOwner(destinationDir: string): Promise<MirrorOwner | null> {
  try {
    const raw = await fs.readFile(path.join(destinationDir, MIRROR_OWNER_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const dirs = (parsed as { sourceDirs?: unknown }).sourceDirs;
    if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === "string")) return null;
    return parsed as MirrorOwner;
  } catch {
    // Missing or unreadable: unclaimed. A corrupt marker must not wedge the leg
    // permanently -- the claim below rewrites it.
    return null;
  }
}

/**
 * One mirror directory serves one host's databases.
 *
 * The staging-directory equivalent (ensureStagingOwnership) exists because a
 * process started from this repo inherits the default staging path and can
 * deposit snapshots of throwaway databases into production history, which
 * happened on 2026-08-05. A share widens that failure mode rather than removing
 * it: two hosts can now reach the same directory, both writing `jobs-*.sqlite`,
 * each pruning to its own retention count and evicting the other's snapshots.
 * Both sets pass integrity_check. Nothing in the filenames would reveal it.
 *
 * So the marker records the host as well as the source directories, and a
 * mismatch on either refuses the leg instead of interleaving. Give each host its
 * own subdirectory -- that is the fix, not a shared one with a bigger retention.
 */
export async function ensureMirrorOwnership(
  destinationDir: string,
  sourceDirs: string[],
  opts: { role?: string; now?: () => number; host?: string } = {},
): Promise<MirrorOwnershipVerdict> {
  const host = opts.host ?? os.hostname();
  const existing = await readMirrorOwner(destinationDir);

  if (!existing) {
    const owner: MirrorOwner = {
      sourceDirs,
      host,
      claimedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
      claimedBy: { role: opts.role, pid: process.pid },
    };
    await fs.writeFile(path.join(destinationDir, MIRROR_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    return { ok: true, claimed: true, owner };
  }

  if (existing.host && existing.host !== host) {
    return {
      ok: false,
      reason: `mirror directory is claimed by host "${existing.host}" but this process runs on "${host}" -- give each host its own mirror directory`,
      owner: existing,
    };
  }

  const conflicting = sourceDirs.filter((dir) => !existing.sourceDirs.includes(dir));
  if (conflicting.length) {
    return {
      ok: false,
      reason: `mirror directory is owned by [${existing.sourceDirs.join(", ")}] but this process backs up [${conflicting.join(", ")}]`,
      owner: existing,
    };
  }
  return { ok: true, claimed: false, owner: existing };
}

/**
 * The database name out of a snapshot file name, or null if it is not one.
 *
 * `jobs-2026-08-27T07-13-09-966Z.sqlite` -> `jobs`. The label from backupLabel()
 * is an ISO timestamp with `:` and `.` swapped for `-`, so it contains dashes of
 * its own and the split has to be anchored on the date rather than on the last
 * dash. Names may contain dashes too (`archived-items`), which rules out taking
 * the first one. Returning null for anything unrecognised is what keeps pruning
 * away from files this process did not write.
 */
export function databaseNameFromSnapshot(fileName: string): string | null {
  const match = /^(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.sqlite$/.exec(fileName);
  return match ? match[1] : null;
}

/**
 * Keep the newest `keep` snapshots per database name, and touch nothing else.
 *
 * Same lexical-order-is-chronological trick as rotateBackups, and the same
 * filename shape. The filter is deliberately narrow: this can be pointed at a
 * shared network directory, so anything that is not recognisably one of our own
 * snapshots is left strictly alone rather than assumed to be ours.
 */
export async function pruneMirror(destinationDir: string, name: string, keep: number): Promise<string[]> {
  const entries = await fs.readdir(destinationDir).catch(() => [] as string[]);
  const mine = entries.filter((file) => file.startsWith(`${name}-`) && file.endsWith(".sqlite")).sort();
  const remove = mine.slice(0, Math.max(0, mine.length - keep));
  const removed: string[] = [];
  for (const file of remove) {
    // A failed delete is not a failed mirror. The copy is what matters; an
    // undeletable old snapshot costs space and is reported, not raised.
    const ok = await fs
      .rm(path.join(destinationDir, file), { force: true })
      .then(() => true)
      .catch(() => false);
    if (ok) removed.push(file);
  }
  return removed;
}

/**
 * Copy this cycle's snapshots to the mirror, then prune it.
 *
 * Every file is attempted even when an earlier one fails. The Azure leg used to
 * `await` in a bare loop with nothing catching, and because `jobs` is first in
 * the list, the day it started failing was the day `archived-items` and
 * `app-state` stopped being uploaded at all -- not failing, never attempted, for
 * five days. Same list, same order, same trap; not repeating it.
 */
export async function mirrorSnapshots(opts: {
  /** Local snapshot paths produced by this cycle. */
  files: string[];
  destinationDir: string;
  /** Canonical source directories, for the ownership marker. */
  sourceDirs: string[];
  /**
   * Database names to prune, when the caller knows them.
   *
   * runBackupCycle does, so it passes them rather than letting this module infer
   * them from filenames. Inference still works as a fallback for standalone use,
   * but relying on it would couple pruning to the label format: a change to
   * backupLabel() that databaseNameFromSnapshot did not anticipate would stop
   * pruning silently, and the mirror would grow without bound while every status
   * field said it was healthy.
   */
  names?: string[];
  retention: number;
  /** Refused if the mirror is this directory or inside it. */
  stagingDir?: string;
  role?: string;
  now?: () => number;
  host?: string;
}): Promise<BackupMirrorResult> {
  const destinationDir = opts.destinationDir;
  const base: BackupMirrorResult = { ok: false, destinationDir, files: [], pruned: [] };

  if (opts.stagingDir && isSameOrInside(destinationDir, opts.stagingDir)) {
    return {
      ...base,
      error: `mirror directory ${destinationDir} is the staging directory (or inside it), so it would not be a second copy`,
    };
  }

  // Reachability is the failure this leg is most likely to have, because a share
  // that was mapped at boot can be gone by the time a cycle runs. It has to read
  // as a leg failure with a usable message, not as a thrown cycle.
  try {
    await fs.mkdir(destinationDir, { recursive: true });
  } catch (error) {
    return {
      ...base,
      error: `mirror directory ${destinationDir} is not reachable or writable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const ownership = await ensureMirrorOwnership(destinationDir, opts.sourceDirs, {
    role: opts.role,
    now: opts.now,
    host: opts.host,
  }).catch((error: unknown) => ({
    ok: false as const,
    reason: `could not claim the mirror directory: ${error instanceof Error ? error.message : String(error)}`,
    owner: { sourceDirs: [], host: "", claimedAt: "" } satisfies MirrorOwner,
  }));
  if (!ownership.ok) return { ...base, error: ownership.reason };

  const files: BackupMirrorFileResult[] = [];
  const names = new Set<string>();

  for (const sourcePath of opts.files) {
    const file = path.basename(sourcePath);
    const destPath = path.join(destinationDir, file);
    // Written aside and renamed into place, so a copy interrupted mid-flight --
    // a dropped share is the obvious way -- never leaves a truncated file
    // sitting under a name the restore procedure would trust.
    const partPath = `${destPath}.part`;
    try {
      const sourceStat = await fs.stat(sourcePath);
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      await fs.copyFile(sourcePath, partPath);
      const copiedStat = await fs.stat(partPath);
      if (copiedStat.size !== sourceStat.size) {
        // Integrity was already established locally by backupOneDatabase, so
        // what is being checked here is the transfer, and a short write is what
        // a network copy actually gets wrong. Re-running integrity_check across
        // the wire would re-read every byte for a much rarer failure.
        throw new Error(`copied ${copiedStat.size} bytes but the source is ${sourceStat.size}`);
      }
      await fs.rename(partPath, destPath);
      files.push({ file, ok: true, bytes: copiedStat.size });
      if (!opts.names?.length) {
        const inferred = databaseNameFromSnapshot(file);
        if (inferred) names.add(inferred);
      }
    } catch (error) {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      files.push({ file, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const pruned: string[] = [];
  for (const name of opts.names?.length ? new Set(opts.names) : names) {
    pruned.push(...(await pruneMirror(destinationDir, name, opts.retention)));
  }

  const ok = files.length > 0 && files.every((entry) => entry.ok);
  return {
    ok,
    destinationDir,
    files,
    pruned,
    completedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    error: ok
      ? undefined
      : files.length === 0
        ? "no snapshots were available to mirror"
        : files
            .filter((entry) => !entry.ok)
            .map((entry) => `${entry.file}: ${entry.error}`)
            .join("; "),
  };
}
