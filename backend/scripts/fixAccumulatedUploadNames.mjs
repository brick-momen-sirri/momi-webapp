/**
 * One-off migration: rename uploaded media whose filenames accumulated repeated
 * "<epoch ms>-<12 hex>-" prefixes, and update every reference to them.
 *
 * Background: uploads are stored as "<uploadId>-<fileName>". Until the fix in
 * uploadedMediaName.ts, a re-upload (crop, or reuse-as-input) echoed back a
 * stored basename and got another prefix prepended, so names grew 26 characters
 * per round trip. The longest stored path reached 284 characters, past the
 * Windows 260-char limit that native tools (ffmpeg, libvips) are subject to.
 *
 * This keeps the OUTERMOST prefix (the file's real upload identity) and strips
 * the accumulated inner ones.
 *
 * REQUIRES THE BACKEND TO BE STOPPED. The job store holds an authoritative
 * in-memory list and syncs it down to SQLite, so a live process could overwrite
 * rows edited here with its cached copy.
 *
 * Usage (from backend/):
 *   node scripts/fixAccumulatedUploadNames.mjs            # dry run, default
 *   node scripts/fixAccumulatedUploadNames.mjs --execute
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");

const EXECUTE = process.argv.includes("--execute");
const backendRoot = path.resolve(import.meta.dirname, "..");
const uploadsRoot = path.join(backendRoot, "data", "projects", "_uploads");
const jobsDbPath = path.join(backendRoot, "data", "jobs.sqlite");
const projectRoots = [
  path.join(backendRoot, "data", "projects"),
  process.env.BRICK_PROJECTS_ROOT
    ?? String.raw`C:\ComfyUI_windows_portable_nvidia_cu128\ComfyUI_windows_portable\ComfyUI\output\projects`,
];

const UPLOAD_ID_PREFIX = /^(\d{13}-[0-9a-f]{12}-)/i;
const log = (line) => console.log(line);

// --- Safety: refuse to touch anything while the backend is listening ---------
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

// --- Build the rename plan ---------------------------------------------------
function buildPlan() {
  const plan = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const chains = (entry.name.match(/\d{13}-[0-9a-f]{12}-/gi) ?? []).length;
      if (chains < 2) continue;
      const outermost = entry.name.match(UPLOAD_ID_PREFIX)[1];
      let rest = entry.name.slice(outermost.length);
      while (UPLOAD_ID_PREFIX.test(rest)) rest = rest.replace(UPLOAD_ID_PREFIX, "");
      const newName = `${outermost}${rest}`;
      plan.push({ dir, oldName: entry.name, newName, chains, oldPath: full, newPath: path.join(dir, newName) });
    }
  };
  walk(uploadsRoot);
  // Longest old name first: a 2-prefix name is a literal suffix of a 4-prefix
  // one, so replacing the short one first would corrupt the longer string.
  return plan.sort((a, b) => b.oldName.length - a.oldName.length);
}

function applyRenames(text, plan) {
  let out = text;
  let replacements = 0;
  for (const item of plan) {
    if (!out.includes(item.oldName)) continue;
    replacements += out.split(item.oldName).length - 1;
    out = out.replaceAll(item.oldName, item.newName);
  }
  return { out, replacements };
}

function collectReferenceFiles() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|jsonl)$/i.test(entry.name)) files.push(full);
    }
  };
  for (const root of projectRoots) walk(root);
  return files;
}

// --- Main -------------------------------------------------------------------
const plan = buildPlan();
log(`mode                : ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
log(`uploads root        : ${uploadsRoot}`);
log(`files to rename     : ${plan.length}`);
if (plan.length === 0) { log("nothing to do."); process.exit(0); }

const oldMax = Math.max(...plan.map((p) => p.oldPath.length));
const newMax = Math.max(...plan.map((p) => p.newPath.length));
log(`longest path        : ${oldMax} -> ${newMax} chars (Windows limit 260)`);
const dist = new Map();
for (const p of plan) dist.set(p.chains, (dist.get(p.chains) ?? 0) + 1);
log(`chain depths        : ${[...dist].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}x:${n}`).join("  ")}`);

// Pre-flight checks.
const problems = [];
const targets = new Map();
for (const p of plan) {
  if (p.oldName === p.newName) problems.push(`no-op rename: ${p.oldName}`);
  if (!fs.existsSync(p.oldPath)) problems.push(`source missing: ${p.oldPath}`);
  if (fs.existsSync(p.newPath)) problems.push(`target already exists: ${p.newPath}`);
  if (p.newPath.length >= 260) problems.push(`target still over limit (${p.newPath.length}): ${p.newPath}`);
  targets.set(p.newPath, [...(targets.get(p.newPath) ?? []), p.oldPath]);
}
for (const [target, sources] of targets) {
  if (sources.length > 1) problems.push(`collision: ${sources.length} sources -> ${target}`);
}
if (problems.length) {
  log(`\nPRE-FLIGHT FAILED (${problems.length} problems):`);
  for (const p of problems.slice(0, 20)) log(`  ${p}`);
  process.exit(1);
}
log(`pre-flight          : OK (no collisions, no missing sources, all targets under 260)`);

if (EXECUTE) {
  for (const port of [3333, 3334]) {
    if (await portInUse(port)) {
      log(`\nREFUSING TO RUN: something is listening on ${port}. Stop the backend first:`);
      log(`  pm2 stop momi-api momi-dispatcher`);
      process.exit(1);
    }
  }
  log(`backend            : confirmed stopped (3333 and 3334 closed)`);
}

// Reference scan.
const referenceFiles = collectReferenceFiles();
let refFileHits = 0;
let refFileReplacements = 0;
const refEdits = [];
for (const file of referenceFiles) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  const { out, replacements } = applyRenames(text, plan);
  if (replacements > 0) { refFileHits += 1; refFileReplacements += replacements; refEdits.push({ file, out }); }
}
log(`reference files     : ${refFileHits} of ${referenceFiles.length} json/jsonl need edits (${refFileReplacements} replacements)`);

// Jobs DB scan.
const db = new Database(jobsDbPath, { readonly: !EXECUTE, fileMustExist: true });
const rows = db.prepare("SELECT id, data FROM jobs").all();
const rowEdits = [];
let rowReplacements = 0;
for (const row of rows) {
  if (typeof row.data !== "string") continue;
  const { out, replacements } = applyRenames(row.data, plan);
  if (replacements > 0) {
    JSON.parse(out); // Fail loudly rather than write malformed JSON.
    rowEdits.push({ id: row.id, data: out });
    rowReplacements += replacements;
  }
}
log(`jobs rows           : ${rowEdits.length} of ${rows.length} need edits (${rowReplacements} replacements)`);

if (!EXECUTE) {
  log(`\nSample of planned renames:`);
  for (const p of plan.slice(0, 3)) log(`  ${p.oldName}\n    -> ${p.newName}`);
  log(`\nDry run only. Re-run with --execute (backend stopped) to apply.`);
  db.close();
  process.exit(0);
}

// --- Execute ----------------------------------------------------------------
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const backupPath = path.join(backendRoot, "data", "backups", `jobs-premigration-${stamp}.sqlite`);
fs.mkdirSync(path.dirname(backupPath), { recursive: true });
// Single quotes: SQLite reads a double-quoted value as an identifier.
db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
log(`\njobs.sqlite backed up to ${backupPath}`);

// 1. Copy each file to its new name. Copy, not move: until every reference is
//    updated the old path must stay valid, so a failure part-way leaves a
//    consistent system either way.
let copied = 0;
for (const p of plan) { fs.copyFileSync(p.oldPath, p.newPath); copied += 1; }
log(`copied to new names : ${copied}`);

// 2. Update the DB in one transaction.
const update = db.prepare("UPDATE jobs SET data = ? WHERE id = ?");
db.transaction(() => { for (const edit of rowEdits) update.run(edit.data, edit.id); })();
log(`jobs rows updated   : ${rowEdits.length}`);

// 3. Update on-disk references atomically.
for (const edit of refEdits) {
  const temp = `${edit.file}.${process.pid}.migrating.tmp`;
  fs.writeFileSync(temp, edit.out, "utf8");
  fs.renameSync(temp, edit.file);
}
log(`reference files      : ${refEdits.length} updated`);

// 4. Verify before deleting anything.
const verification = [];
const remaining = [];
for (const file of collectReferenceFiles()) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  for (const p of plan) if (text.includes(p.oldName)) { remaining.push(`${file} still references ${p.oldName}`); break; }
}
for (const row of db.prepare("SELECT id, data FROM jobs").all()) {
  if (typeof row.data !== "string") continue;
  for (const p of plan) if (row.data.includes(p.oldName)) { remaining.push(`job ${row.id} still references ${p.oldName}`); break; }
}
if (remaining.length) verification.push(`${remaining.length} stale references remain`);

// Every media path referenced by a job must resolve on disk.
let brokenPaths = 0;
for (const row of db.prepare("SELECT id, data FROM jobs").all()) {
  if (typeof row.data !== "string") continue;
  for (const match of row.data.matchAll(/\/api\/media\?path=([^"\\]+)/g)) {
    const filePath = decodeURIComponent(match[1]);
    if (filePath.includes("_uploads") && !fs.existsSync(filePath)) brokenPaths += 1;
  }
}
if (brokenPaths > 0) verification.push(`${brokenPaths} referenced upload paths do not resolve`);

const missingNew = plan.filter((p) => !fs.existsSync(p.newPath)).length;
if (missingNew > 0) verification.push(`${missingNew} new files missing`);

if (verification.length) {
  log(`\nVERIFICATION FAILED — leaving old files in place so nothing is lost:`);
  for (const v of verification) log(`  ${v}`);
  for (const r of remaining.slice(0, 10)) log(`    ${r}`);
  log(`\nRestore with: copy ${backupPath} over data/jobs.sqlite`);
  db.close();
  process.exit(1);
}
log(`verification         : OK (no stale references, all upload paths resolve)`);

// 5. Only now remove the originals.
let removed = 0;
for (const p of plan) { fs.rmSync(p.oldPath, { force: true }); removed += 1; }
log(`old files removed    : ${removed}`);
db.close();
log(`\nMigration complete. Restart with: pm2 start momi-dispatcher momi-api`);
