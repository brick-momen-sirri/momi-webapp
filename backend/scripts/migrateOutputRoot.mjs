// Rewrites the persisted output root after render output moves to the SMB share.
//
// Absolute paths are embedded in three encodings across four tables, so this
// operates on each row's raw JSON text rather than walking the parsed object -
// a textual swap preserves every other field byte-for-byte and cannot silently
// drop a key it did not know about.
//
//   raw backslash   C:\ComfyUI...\output\projects   (stored JSON-escaped, \\)
//   raw forward     C:/ComfyUI.../output/projects
//   URL-encoded     C%3A%5CComfyUI...%5Coutput%5Cprojects   (inside /api/media?path=)
//
// Default is a dry run. Pass --apply to write, which requires the PM2 apps to
// be stopped first: these DBs are WAL and a concurrent writer would race.
//
//   node scripts/migrateOutputRoot.mjs            # dry run, prints counts
//   node scripts/migrateOutputRoot.mjs --apply    # rewrites in place

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Each root that has moved onto the share. Both are listed permanently so the
// script stays idempotent: a root already migrated simply reports 0.
const ROOT_MOVES = [
  {
    label: "render output",
    old: "C:\\ComfyUI_windows_portable_nvidia_cu128\\ComfyUI_windows_portable\\ComfyUI\\output\\projects",
    new: "\\\\10.101.41.11\\ai-data$\\Momi\\projects",
  },
  {
    label: "uploads",
    old: "C:\\Momi-Animation\\backend\\data\\projects\\_uploads",
    new: "\\\\10.101.41.11\\ai-data$\\Momi\\_uploads",
  },
];

// How each form appears inside the raw JSON text held in the `data` column.
const jsonEscape = (value) => value.replaceAll("\\", "\\\\");
const forward = (value) => value.replaceAll("\\", "/");

function formsFor(oldRoot, newRoot) {
  return [
    { from: jsonEscape(oldRoot), to: jsonEscape(newRoot) },
    { from: forward(oldRoot), to: forward(newRoot) },
    { from: encodeURIComponent(oldRoot), to: encodeURIComponent(newRoot) },
    { from: encodeURIComponent(oldRoot).toLowerCase(), to: encodeURIComponent(newRoot) },
    // app_projects.folder_path_norm is normalizeProjectPath(): forward slashes,
    // lowercased, no trailing slash. It is UNIQUE and drives identity lookups,
    // so missing it would leave every project unmatchable after the move.
    { from: forward(oldRoot).toLowerCase(), to: forward(newRoot).toLowerCase() },
  ];
}

// Longest `from` first: the uploads root is not a prefix of the output root, but
// ordering by length keeps that true if a nested root is ever added.
const FORMS = ROOT_MOVES.flatMap((move) => formsFor(move.old, move.new)).sort((a, b) => b.from.length - a.from.length);

const TARGETS = [
  { db: "data/app-state.sqlite", table: "app_projects", key: "id", extraTextColumns: ["folder_path_norm"] },
  { db: "data/app-state.sqlite", table: "media_index_state", key: "rowid" },
  { db: "data/jobs.sqlite", table: "jobs", key: "id" },
  { db: "data/archived-items.sqlite", table: "archived_jobs", key: "id" },
];

function rewrite(text) {
  let out = text;
  let hits = 0;
  for (const form of FORMS) {
    if (!form.from) continue;
    let index = out.indexOf(form.from);
    while (index !== -1) {
      hits += 1;
      index = out.indexOf(form.from, index + form.from.length);
    }
    out = out.replaceAll(form.from, form.to);
  }
  return { out, hits };
}

let grandRows = 0;
let grandHits = 0;

for (const target of TARGETS) {
  const dbPath = path.join(backendRoot, target.db);
  const db = new Database(dbPath, { readonly: !APPLY });
  const cols = db.prepare(`PRAGMA table_info(${target.table})`).all().map((c) => c.name);
  const keyCol = cols.includes(target.key) ? target.key : "rowid";

  const rows = db.prepare(`SELECT ${keyCol} AS k, data FROM ${target.table}`).all();
  let changedRows = 0;
  let hits = 0;
  const updates = [];

  for (const row of rows) {
    if (typeof row.data !== "string") continue;
    const { out, hits: n } = rewrite(row.data);
    if (n > 0) {
      changedRows += 1;
      hits += n;
      updates.push({ k: row.k, data: out });
    }
  }

  // app_projects also keeps a normalized path in its own UNIQUE column.
  const extraUpdates = [];
  for (const col of target.extraTextColumns ?? []) {
    const extraRows = db.prepare(`SELECT ${keyCol} AS k, ${col} AS v FROM ${target.table}`).all();
    for (const row of extraRows) {
      if (typeof row.v !== "string") continue;
      const { out, hits: n } = rewrite(row.v);
      if (n > 0) extraUpdates.push({ col, k: row.k, v: out });
    }
  }

  console.log(
    `${target.db.padEnd(28)} ${target.table.padEnd(20)} rows=${String(rows.length).padStart(6)}  ` +
      `rowsWithPath=${String(changedRows).padStart(6)}  occurrences=${String(hits).padStart(6)}` +
      (extraUpdates.length ? `  +${extraUpdates.length} in ${target.extraTextColumns.join(",")}` : ""),
  );

  if (APPLY && (updates.length || extraUpdates.length)) {
    const setData = db.prepare(`UPDATE ${target.table} SET data = ? WHERE ${keyCol} = ?`);
    const tx = db.transaction(() => {
      for (const u of updates) setData.run(u.data, u.k);
      for (const u of extraUpdates) {
        db.prepare(`UPDATE ${target.table} SET ${u.col} = ? WHERE ${keyCol} = ?`).run(u.v, u.k);
      }
    });
    tx();
    console.log(`  applied ${updates.length} data rows, ${extraUpdates.length} column values`);
  }

  grandRows += changedRows;
  grandHits += hits;
  db.close();
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${grandHits} occurrences across ${grandRows} rows`);
if (!APPLY) console.log("Re-run with --apply (PM2 stopped, DBs backed up) to write.");
