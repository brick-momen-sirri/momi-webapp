import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  archivedItemsSqlitePath,
  archivedItemsStorePath,
  jobsSqlitePath,
  jobsStorePath,
} from "./config.js";
import { openSqliteJobStore } from "./sqliteJobStore.js";
import { readJsonFileWithBackup, writeJsonFile } from "./storageService.js";
import type { Job } from "./types.js";

export type ExportPaths = {
  jobsSqlitePath: string;
  jobsJsonPath: string;
  archivedSqlitePath: string;
  archivedJsonPath: string;
};

export type ExportOptions = {
  // Allow overwriting a populated JSON file with an empty export (default: refuse).
  allowEmpty?: boolean;
  // After a successful export, rename the SQLite files aside so re-enabling
  // JOB_STORE_DRIVER=sqlite later re-migrates from the now-current JSON instead
  // of resurrecting a stale store. Default true (this is a rollback tool).
  retireSqlite?: boolean;
};

export type ExportResult = { jobs: number; archived: number; retired: string[] };

// A full store export can legitimately exceed the per-metadata JSON cap.
const EXPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// Exports the SQLite job stores back to the JSON files, so a deployment can
// roll back from JOB_STORE_DRIVER=sqlite to "json" without losing jobs created
// while on SQLite. The written JSON matches the live store format exactly, so
// loadJobs reads it back identically. The mirror image of the migration in
// loadJobs. Run with the backend STOPPED so SQLite isn't written concurrently.
export async function exportSqliteJobStoreToJson(paths: ExportPaths, options: ExportOptions = {}): Promise<ExportResult> {
  // Read both stores first (read-only; missing file throws, never fabricated),
  // and validate BEFORE writing anything so a bad state can't half-overwrite.
  const jobs = readSqlite(paths.jobsSqlitePath, "jobs");
  const archived = readSqlite(paths.archivedSqlitePath, "archived_jobs");

  // Check both empty-clobber guards before writing either file, so a guard
  // failure can't leave one file overwritten and the other not.
  await assertNotEmptyClobber(paths.jobsJsonPath, jobs, "jobs", options.allowEmpty);
  await assertNotEmptyClobber(paths.archivedJsonPath, archived, "archived items", options.allowEmpty);

  await writeJsonFile(paths.jobsJsonPath, jobs, { maxBytes: EXPORT_MAX_BYTES });
  await writeJsonFile(paths.archivedJsonPath, archived, { maxBytes: EXPORT_MAX_BYTES });

  const retired = options.retireSqlite === false
    ? []
    : [...retireStore(paths.jobsSqlitePath), ...retireStore(paths.archivedSqlitePath)];

  return { jobs: jobs.length, archived: archived.length, retired };
}

function readSqlite(dbPath: string, table: string): Job[] {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `SQLite store not found at ${dbPath}. Refusing to export (this would otherwise overwrite the JSON fallback with an empty list). `
      + "Point JOBS_SQLITE_PATH/JOBS_ARCHIVED_SQLITE_PATH at the real store, or run this only after the backend has booted on SQLite.",
    );
  }
  const store = openSqliteJobStore(dbPath, table, { readonly: true });
  try {
    return store.loadAll();
  } finally {
    store.close();
  }
}

// Refuse to overwrite a populated JSON file with an empty export unless
// explicitly allowed — an empty read almost always means a wrong path or an
// uninitialized store, not a genuinely emptied history.
async function assertNotEmptyClobber(jsonPath: string, data: Job[], label: string, allowEmpty?: boolean) {
  if (data.length > 0 || allowEmpty) return;
  const existing = await readJsonFileWithBackup<Job[]>(jsonPath, []);
  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite ${jsonPath} (${existing.length} ${label}) with an empty export. `
      + "If the store really is empty, pass { allowEmpty: true } / --allow-empty.",
    );
  }
}

// Rename a SQLite DB (and its WAL/SHM sidecars) aside so a future
// JOB_STORE_DRIVER=sqlite re-enable migrates fresh from the current JSON rather
// than loading a store frozen at the rollback moment.
function retireStore(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const renamed: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${dbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = `${dbPath}.rolledback-${stamp}${suffix}`;
    fs.renameSync(from, to);
    renamed.push(to);
  }
  return renamed;
}

async function main() {
  const allowEmpty = process.argv.includes("--allow-empty");
  const retireSqlite = !process.argv.includes("--keep-sqlite");
  const result = await exportSqliteJobStoreToJson(
    {
      jobsSqlitePath,
      jobsJsonPath: jobsStorePath,
      archivedSqlitePath: archivedItemsSqlitePath,
      archivedJsonPath: archivedItemsStorePath,
    },
    { allowEmpty, retireSqlite },
  );
  console.log(
    `Exported SQLite job store to JSON: ${result.jobs} jobs -> ${jobsStorePath}, `
    + `${result.archived} archived -> ${archivedItemsStorePath}.`,
  );
  if (result.retired.length) {
    console.log(`Retired SQLite files (renamed aside): ${result.retired.join(", ")}`);
  }
  console.log("To roll back: set JOB_STORE_DRIVER=json (or remove it) and restart the backend.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Export failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
