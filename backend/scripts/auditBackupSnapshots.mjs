// Audit the snapshots in a backup staging directory and, optionally, quarantine
// the ones that cannot plausibly be backups of the databases this directory
// serves.
//
// Why this exists: `PRAGMA integrity_check` answers "is this file a well-formed
// SQLite database", NOT "is this a backup of the right database". An empty
// database is perfectly intact. On 2026-08-05 twelve cycles of a test harness
// wrote snapshots of its own throwaway databases into the production staging
// directory; all of them reported integrity ok, all of them looked like real
// snapshots, and rotation evicted twelve hours of genuine history to keep the
// retention count. `ensureStagingOwnership` in sqliteBackupService.ts now stops
// that at the source; this script is for auditing what is already on disk, and
// for the pre-restore check in backend/docs/sqlite-dr-runbook.md.
//
// Read-only unless --apply is passed. Nothing is ever deleted: --apply MOVES
// flagged snapshots into a quarantine directory, so the action is reversible.
//
//   node scripts/auditBackupSnapshots.mjs
//   node scripts/auditBackupSnapshots.mjs --staging D:\somewhere\backups
//   node scripts/auditBackupSnapshots.mjs --apply

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A snapshot holding less than this fraction of its cohort's median population
// is not a plausible backup of the same database.
const IMPLAUSIBLE_RATIO = 0.1;

function parseArgs(argv) {
  const args = { staging: null, quarantine: null, apply: false, cycles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--staging") args.staging = argv[++i];
    else if (argv[i] === "--quarantine") args.quarantine = argv[++i];
    else if (argv[i] === "--cycle") args.cycles.push(argv[++i]);
  }
  args.staging ??= process.env.SQLITE_BACKUP_STAGING_DIR?.trim() || path.join(backendRoot, "data", "backups");
  args.quarantine ??= path.join(args.staging, "..", "backups-quarantine");
  return args;
}

/** Total rows across every application table, i.e. "how populated is this database". */
function populationOf(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"));
    let rows = 0;
    for (const table of tables) rows += db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
    return { integrity, tables: tables.length, rows };
  } finally {
    db.close();
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const args = parseArgs(process.argv.slice(2));
const entries = await fs.readdir(args.staging).catch(() => {
  console.error(`staging directory not found: ${args.staging}`);
  process.exit(1);
});

const snapshots = entries.filter((file) => file.endsWith(".sqlite"));
if (!snapshots.length) {
  console.log(`no snapshots in ${args.staging}`);
  process.exit(0);
}

// Group by target name: "<target>-<ISO-ish label>.sqlite".
const byTarget = new Map();
for (const file of snapshots) {
  const match = /^(.*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.sqlite$/.exec(file);
  if (!match) continue;
  const [, target] = match;
  if (!byTarget.has(target)) byTarget.set(target, []);
  byTarget.get(target).push(file);
}

console.log(`staging directory: ${args.staging}`);
const flagged = [];

for (const [target, files] of [...byTarget.entries()].sort()) {
  const measured = [];
  for (const file of files.sort()) {
    const full = path.join(args.staging, file);
    const { size } = await fs.stat(full);
    try {
      measured.push({ file, size, ...populationOf(full) });
    } catch (error) {
      measured.push({ file, size, integrity: `unreadable: ${error.message}`, tables: 0, rows: 0 });
    }
  }

  const cohortMedian = median(measured.map((m) => m.rows));
  const threshold = cohortMedian * IMPLAUSIBLE_RATIO;
  console.log(`\n=== ${target}  (${measured.length} snapshots, median population ${cohortMedian} rows)`);
  for (const m of measured) {
    const implausible = cohortMedian > 0 && m.rows < threshold;
    if (implausible) flagged.push({ target, ...m });
    console.log(
      `  ${implausible ? "FOREIGN?" : "ok      "} ${m.file}  ${String(m.rows).padStart(7)} rows  ` +
        `${String(Math.round(m.size / 1024)).padStart(7)} KiB  integrity=${m.integrity}`,
    );
  }
}

// Explicit cycle labels always win over the heuristic.
//
// The heuristic under-detects by design, and the 2026-08-05 incident shows how:
// six of that day's foreign `jobs` snapshots held 66 rows against a cohort
// median of 551 -- 12%, just above the implausibility threshold -- because the
// load-test harness submits real jobs into its own database. A busier harness
// would be indistinguishable by population alone. Population ratio can flag
// candidates; it cannot establish identity. That is what the staging-ownership
// marker is for, and why cleanup of existing files is selected by cycle label
// (a backup cycle writes every target under one shared label, so an off-cadence
// label identifies the whole intruding cycle) rather than by row count.
if (args.cycles.length) {
  const targeted = snapshots.filter((file) => args.cycles.some((label) => file.endsWith(`-${label}.sqlite`)));
  if (!targeted.length) {
    console.log(`\nNo snapshots match the requested cycle label(s): ${args.cycles.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nExplicitly selected ${targeted.length} snapshot(s) across ${args.cycles.length} cycle label(s):`);
  for (const file of targeted.sort()) console.log(`  ${file}`);
  flagged.length = 0;
  for (const file of targeted) flagged.push({ file });
} else if (!flagged.length) {
  console.log("\nEvery snapshot is consistent with its cohort. Nothing to quarantine.");
  process.exit(0);
} else {
  console.log(`\n${flagged.length} snapshot(s) hold implausibly little data for their cohort.`);
  console.log("These are likely backups of a DIFFERENT database that shared this staging directory.");
  console.log("Note: this check UNDER-detects. Confirm against the cycle labels before trusting it.");
}

if (!args.apply) {
  console.log("\nDry run. Re-run with --apply to MOVE them to:");
  console.log(`  ${path.resolve(args.quarantine)}`);
  process.exit(0);
}

const quarantineDir = path.resolve(args.quarantine);
await fs.mkdir(quarantineDir, { recursive: true });
for (const item of flagged) {
  await fs.rename(path.join(args.staging, item.file), path.join(quarantineDir, item.file));
  console.log(`  moved ${item.file}`);
}
await fs.writeFile(
  path.join(quarantineDir, "README.txt"),
  [
    "Snapshots quarantined by backend/scripts/auditBackupSnapshots.mjs.",
    "",
    "Each file here is a well-formed SQLite database that passed integrity_check but",
    "holds implausibly little data compared with the other snapshots of the same",
    "target -- i.e. it is a backup of a DIFFERENT database that shared the staging",
    "directory. Restoring one would look successful and silently lose almost",
    "everything.",
    "",
    "Nothing was deleted. To undo, move these files back into the staging directory.",
    `Quarantined from: ${path.resolve(args.staging)}`,
    "",
    ...flagged.map((item) => `  ${item.file}${item.rows === undefined ? "" : `  ${item.rows} rows`}`),
    "",
  ].join("\n"),
  "utf8",
);
console.log(`\nMoved ${flagged.length} snapshot(s) to ${quarantineDir} (nothing deleted).`);
