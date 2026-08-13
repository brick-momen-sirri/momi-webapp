/**
 * Remove a project that holds no work: delete its app_projects row and move its
 * folder aside.
 *
 * Background: the app has no delete-project route, deliberately -- a project
 * folder is real client work and deleting one from a web UI is not a mistake
 * worth making possible. But a project created by accident (wrong folder name,
 * duplicate code) leaves an empty scaffold in the list forever, so removing one
 * needs *some* supported path. This is it: guarded, reversible, and dry-run by
 * default.
 *
 * Safe by construction:
 *   - refuses if any job references the project;
 *   - refuses if the folder holds anything but the metadata scaffold, so a
 *     project with a single rendered frame in it cannot be removed here;
 *   - writes the row to a JSON backup before deleting it;
 *   - MOVES the folder into <projects root>/_removed/<stamp>_<folder> rather
 *     than deleting it, so recovery is a rename.
 *
 * Undo: move the folder back out of _removed/, then re-insert the row from the
 * backup JSON (its `data` column is the whole project).
 *
 * Safe to run against a live backend: projects are read per-request from
 * SQLite with no in-memory authoritative copy (see projectService.getProjects),
 * so no restart is needed and no process will write a stale copy back.
 *
 * Usage (from backend/):
 *   node scripts/removeEmptyProject.mjs <projectId>             # dry run, default
 *   node scripts/removeEmptyProject.mjs <projectId> --execute
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");

const EXECUTE = process.argv.includes("--execute");
const projectId = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

if (!projectId) {
  console.error("Usage: node scripts/removeEmptyProject.mjs <projectId> [--execute]");
  process.exit(2);
}

const APP_STATE = process.env.APP_STATE_SQLITE_PATH ?? path.join("data", "app-state.sqlite");
const JOB_STORE = process.env.JOB_STORE_SQLITE_PATH ?? path.join("data", "jobs.sqlite");
// Only the metadata scaffold the project-creation path writes; anything else
// means the project holds work.
const ALLOWED_FILES = new Set(["project.json", "folders.json"]);

function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

const appState = new Database(APP_STATE);
appState.pragma("busy_timeout = 5000");

const row = appState
  .prepare("SELECT id, folder_path_norm, folder_name_norm, created_at, updated_at, data FROM app_projects WHERE id = ?")
  .get(projectId);

if (!row) {
  console.error(`No project row with id ${projectId}.`);
  appState.close();
  process.exit(1);
}

const project = JSON.parse(row.data);
console.log(`project:    ${project.name} (${project.client ?? "no client"})`);
console.log(`folder:     ${project.folderPath}`);
console.log(`members:    ${(project.members ?? []).map((m) => `${m.userId}:${m.role}`).join(", ") || "none"}`);

let jobCount = 0;
if (fs.existsSync(JOB_STORE)) {
  const jobs = new Database(JOB_STORE, { readonly: true });
  for (const jobRow of jobs.prepare("SELECT data FROM jobs").all()) {
    try {
      if (JSON.parse(jobRow.data).projectId === projectId) jobCount += 1;
    } catch {
      // A row that will not parse cannot be attributed to this project.
    }
  }
  jobs.close();
}
console.log(`jobs:       ${jobCount}`);

const files = listFiles(project.folderPath);
const unexpected = files.filter((file) => !ALLOWED_FILES.has(path.basename(file)));
console.log(`files:      ${files.length} (${unexpected.length} outside the metadata scaffold)`);

if (jobCount > 0) {
  console.error(`\nREFUSED: ${jobCount} job(s) reference this project. Archive or move them first.`);
  appState.close();
  process.exit(1);
}
if (unexpected.length) {
  console.error("\nREFUSED: the folder holds files beyond the metadata scaffold:");
  for (const file of unexpected.slice(0, 20)) console.error(`  ${file}`);
  if (unexpected.length > 20) console.error(`  ... and ${unexpected.length - 20} more`);
  appState.close();
  process.exit(1);
}

if (!EXECUTE) {
  console.log("\nDry run. Re-run with --execute to remove it.");
  appState.close();
  process.exit(0);
}

const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const backupDir = path.join("data", "removed-projects");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `${projectId}.${stamp}.row.json`);
fs.writeFileSync(backupPath, JSON.stringify(row, null, 2), "utf8");
console.log(`\nrow backup: ${backupPath}`);

if (fs.existsSync(project.folderPath)) {
  const quarantine = path.join(path.dirname(project.folderPath), "_removed");
  fs.mkdirSync(quarantine, { recursive: true });
  const moved = path.join(quarantine, `${stamp}_${path.basename(project.folderPath)}`);
  fs.renameSync(project.folderPath, moved);
  console.log(`folder moved to: ${moved}`);
} else {
  console.log("folder was already absent, nothing to move");
}

const changes = appState.prepare("DELETE FROM app_projects WHERE id = ?").run(projectId).changes;
console.log(`row deleted: ${changes === 1 ? "yes" : "no (already gone)"}`);
appState.close();
console.log("\nDone. The project list will drop it on the next poll; no restart needed.");
