import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Job } from "./types.js";

// A SQLite-backed persistence layer for the job list, an alternative to the
// JSON file store. It keeps the same "full Job as JSON" shape (the in-memory
// array stays the runtime source of truth) but promotes the frequently-queried
// fields to indexed columns, and swaps whole-file rewrites for per-row upserts.
//
// This is opt-in via JOB_STORE_DRIVER=sqlite (see config.ts). Nothing uses it
// on the default path, so the JSON behavior is unchanged until the flag flips.

export type SqliteJobStore = {
  loadAll(): Job[];
  replaceAll(jobs: Job[]): void;
  count(): number;
  close(): void;
};

type JobRow = { data: string };

export function openSqliteJobStore(dbPath: string): SqliteJobStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      status TEXT,
      project_id TEXT,
      user_id TEXT,
      created_at TEXT,
      completed_at TEXT,
      comfy_prompt_id TEXT,
      credits_used REAL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_seq ON jobs(seq);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
  `);

  const selectAll = db.prepare<[], JobRow>("SELECT data FROM jobs ORDER BY seq ASC");
  const selectIds = db.prepare<[], { id: string }>("SELECT id FROM jobs");
  const countStmt = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM jobs");
  const upsert = db.prepare(`
    INSERT INTO jobs (id, seq, status, project_id, user_id, created_at, completed_at, comfy_prompt_id, credits_used, data)
    VALUES (@id, @seq, @status, @project_id, @user_id, @created_at, @completed_at, @comfy_prompt_id, @credits_used, @data)
    ON CONFLICT(id) DO UPDATE SET
      seq = excluded.seq,
      status = excluded.status,
      project_id = excluded.project_id,
      user_id = excluded.user_id,
      created_at = excluded.created_at,
      completed_at = excluded.completed_at,
      comfy_prompt_id = excluded.comfy_prompt_id,
      credits_used = excluded.credits_used,
      data = excluded.data
  `);
  const deleteById = db.prepare<[string]>("DELETE FROM jobs WHERE id = ?");

  const replaceAllTx = db.transaction((jobs: Job[]) => {
    const keepIds = new Set(jobs.map((job) => job.id));
    // Upsert the current set, preserving array order via seq.
    jobs.forEach((job, index) => upsert.run(toRow(job, index)));
    // Prune rows for jobs that no longer exist in memory.
    for (const { id } of selectIds.all()) {
      if (!keepIds.has(id)) deleteById.run(id);
    }
  });

  return {
    loadAll() {
      return selectAll.all().map((row) => JSON.parse(row.data) as Job);
    },
    replaceAll(jobs: Job[]) {
      replaceAllTx(jobs);
    },
    count() {
      return countStmt.get()?.n ?? 0;
    },
    close() {
      db.close();
    },
  };
}

function toRow(job: Job, seq: number) {
  return {
    id: job.id,
    seq,
    status: job.status ?? null,
    project_id: job.projectId ?? null,
    user_id: job.userId ?? null,
    created_at: job.createdAt ?? null,
    completed_at: job.completedAt ?? null,
    comfy_prompt_id: job.comfyPromptId ?? null,
    credits_used: typeof job.creditsUsed === "number" && Number.isFinite(job.creditsUsed) ? job.creditsUsed : null,
    data: JSON.stringify(job),
  };
}
