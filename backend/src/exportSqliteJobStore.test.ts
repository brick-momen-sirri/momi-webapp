import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { exportSqliteJobStoreToJson } from "./exportSqliteJobStore.js";
import { openSqliteJobStore } from "./sqliteJobStore.js";
import { writeJsonFile } from "./storageService.js";
import type { Job } from "./types.js";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-export-"));
after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL handles briefly; the OS temp dir is transient.
  }
});

let counter = 0;
function scratch() {
  const dir = path.join(tempDir, `case-${counter++}`);
  return {
    jobsJson: path.join(dir, "jobs.json"),
    archivedJson: path.join(dir, "archived.json"),
    jobsSqlite: path.join(dir, "jobs.sqlite"),
    archivedSqlite: path.join(dir, "archived.sqlite"),
  };
}

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    projectId: "prj_1",
    userId: "usr_1",
    status: "completed",
    createdAt: "2026-07-20T00:00:00.000Z",
    resultUrls: [],
    thumbnailUrls: [],
    ...overrides,
  } as Job;
}

function seedSqlite(dbPath: string, table: string, jobs: Job[]) {
  const store = openSqliteJobStore(dbPath, table);
  store.replaceAll(jobs);
  store.close();
}

test("export round-trips a populated store back to byte-identical JSON", async () => {
  const p = scratch();
  const jobs = [
    job("job_c", { status: "failed", prompt: "third" } as Partial<Job>),
    job("job_b", { prompt: "second \"quoted\" and unicode: café 🎬" } as Partial<Job>),
    job("job_a"),
  ];
  const archived = [job("arch_1", { source: "existing_project_media" } as Partial<Job>)];
  await writeJsonFile(p.jobsJson, jobs);
  await writeJsonFile(p.archivedJson, archived);
  const jobsBefore = readFileSync(p.jobsJson, "utf8");
  const archivedBefore = readFileSync(p.archivedJson, "utf8");
  seedSqlite(p.jobsSqlite, "jobs", jobs);
  seedSqlite(p.archivedSqlite, "archived_jobs", archived);

  const result = await exportSqliteJobStoreToJson(
    { jobsSqlitePath: p.jobsSqlite, jobsJsonPath: p.jobsJson, archivedSqlitePath: p.archivedSqlite, archivedJsonPath: p.archivedJson },
    { retireSqlite: false },
  );

  assert.equal(result.jobs, 3);
  assert.equal(result.archived, 1);
  assert.equal(readFileSync(p.jobsJson, "utf8"), jobsBefore);
  assert.equal(readFileSync(p.archivedJson, "utf8"), archivedBefore);
});

test("export refuses to run when the SQLite file is missing (no clobber)", async () => {
  const p = scratch();
  await writeJsonFile(p.jobsJson, [job("job_keep")]); // populated fallback
  const before = readFileSync(p.jobsJson, "utf8");

  await assert.rejects(
    exportSqliteJobStoreToJson({ jobsSqlitePath: p.jobsSqlite, jobsJsonPath: p.jobsJson, archivedSqlitePath: p.archivedSqlite, archivedJsonPath: p.archivedJson }),
    /SQLite store not found/,
  );
  // jobs.json must be untouched.
  assert.equal(readFileSync(p.jobsJson, "utf8"), before);
});

test("export refuses to overwrite a populated JSON with an empty store", async () => {
  const p = scratch();
  await writeJsonFile(p.jobsJson, [job("job_keep_1"), job("job_keep_2")]);
  const before = readFileSync(p.jobsJson, "utf8");
  seedSqlite(p.jobsSqlite, "jobs", []); // exists but empty
  seedSqlite(p.archivedSqlite, "archived_jobs", []);

  await assert.rejects(
    exportSqliteJobStoreToJson({ jobsSqlitePath: p.jobsSqlite, jobsJsonPath: p.jobsJson, archivedSqlitePath: p.archivedSqlite, archivedJsonPath: p.archivedJson }),
    /Refusing to overwrite .* with an empty export/,
  );
  assert.equal(readFileSync(p.jobsJson, "utf8"), before);
});

test("export of an empty store proceeds when allowEmpty is set", async () => {
  const p = scratch();
  await writeJsonFile(p.jobsJson, [job("job_old")]);
  seedSqlite(p.jobsSqlite, "jobs", []);
  seedSqlite(p.archivedSqlite, "archived_jobs", []);

  const result = await exportSqliteJobStoreToJson(
    { jobsSqlitePath: p.jobsSqlite, jobsJsonPath: p.jobsJson, archivedSqlitePath: p.archivedSqlite, archivedJsonPath: p.archivedJson },
    { allowEmpty: true, retireSqlite: false },
  );
  assert.equal(result.jobs, 0);
  assert.deepEqual(JSON.parse(readFileSync(p.jobsJson, "utf8")), []);
});

test("export retires the SQLite files so a re-enable re-migrates from JSON", async () => {
  const p = scratch();
  await writeJsonFile(p.jobsJson, [job("job_a")]);
  await writeJsonFile(p.archivedJson, []);
  seedSqlite(p.jobsSqlite, "jobs", [job("job_a")]);
  seedSqlite(p.archivedSqlite, "archived_jobs", []);

  const result = await exportSqliteJobStoreToJson({
    jobsSqlitePath: p.jobsSqlite,
    jobsJsonPath: p.jobsJson,
    archivedSqlitePath: p.archivedSqlite,
    archivedJsonPath: p.archivedJson,
  });

  assert.equal(existsSync(p.jobsSqlite), false, "jobs.sqlite should be renamed aside");
  assert.ok(result.retired.some((f) => f.includes("rolledback")), "should report retired files");
  assert.ok(readdirSync(path.dirname(p.jobsSqlite)).some((f) => f.startsWith("jobs.sqlite.rolledback-")));
});
