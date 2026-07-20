import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Job } from "./types.js";

// A SQLite-backed persistence layer for the job list, an alternative to the
// JSON file store. It keeps the same "full Job as JSON" shape (the in-memory
// array stays the runtime source of truth) but promotes the frequently-queried
// fields to indexed columns.
//
// replaceAll() syncs the store to the given array by diffing against the last
// synced state: only rows whose serialized content changed are written, and
// only removed rows are deleted. A status transition on one job writes one row,
// not the whole table. Diffing by content hash (rather than caller-supplied
// dirty flags) means a change can never be silently missed.
//
// Opt-in via JOB_STORE_DRIVER=sqlite (see config.ts). Nothing uses it on the
// default path, so the JSON behavior is unchanged until the flag flips.

export type SyncStats = { written: number; deleted: number };

export type SqliteJobStore = {
  loadAll(): Job[];
  replaceAll(jobs: Job[]): SyncStats;
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

  // seq is a stable, monotonically increasing insertion key (higher = newer),
  // assigned once per job and never rewritten, so a prepend doesn't touch
  // existing rows. loadAll returns newest-first (matching the in-memory array,
  // which createJob prepends to).
  const selectAll = db.prepare<[], JobRow>("SELECT data FROM jobs ORDER BY seq DESC");
  const selectIdSeq = db.prepare<[], { id: string; seq: number }>("SELECT id, seq FROM jobs");
  const countStmt = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM jobs");
  const upsert = db.prepare(`
    INSERT INTO jobs (id, seq, status, project_id, user_id, created_at, completed_at, comfy_prompt_id, credits_used, data)
    VALUES (@id, @seq, @status, @project_id, @user_id, @created_at, @completed_at, @comfy_prompt_id, @credits_used, @data)
    ON CONFLICT(id) DO UPDATE SET
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

  // Last-synced state, seeded from the DB on open. Hashes start empty, so the
  // first sync after boot rewrites row data once (seq is preserved); every
  // sync after that writes only rows whose content actually changed.
  const knownSeq = new Map<string, number>();
  const knownHash = new Map<string, number>();
  let nextSeq = 0;
  for (const row of selectIdSeq.all()) {
    knownSeq.set(row.id, row.seq);
    if (row.seq >= nextSeq) nextSeq = row.seq + 1;
  }

  const syncTx = db.transaction((jobs: Job[]): SyncStats => {
    const currentIds = new Set(jobs.map((job) => job.id));
    let written = 0;
    let deleted = 0;

    // Prune rows for jobs no longer in memory.
    for (const id of [...knownSeq.keys()]) {
      if (!currentIds.has(id)) {
        deleteById.run(id);
        knownSeq.delete(id);
        knownHash.delete(id);
        deleted += 1;
      }
    }

    // Assign seq to newly-seen jobs. Iterate back-to-front so the front of the
    // array (newest) receives the highest seq. Backend only ever prepends new
    // jobs, so new ids form a prefix and this preserves array order.
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const id = jobs[index].id;
      if (!knownSeq.has(id)) knownSeq.set(id, nextSeq++);
    }

    // Write only new or content-changed rows.
    for (const job of jobs) {
      const data = JSON.stringify(job);
      const hash = hashString(data);
      if (knownHash.get(job.id) === hash) continue;
      upsert.run(toRow(job, knownSeq.get(job.id)!, data));
      knownHash.set(job.id, hash);
      written += 1;
    }

    return { written, deleted };
  });

  return {
    loadAll() {
      return selectAll.all().map((row) => JSON.parse(row.data) as Job);
    },
    replaceAll(jobs: Job[]) {
      return syncTx(jobs);
    },
    count() {
      return countStmt.get()?.n ?? 0;
    },
    close() {
      db.close();
    },
  };
}

function toRow(job: Job, seq: number, data: string) {
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
    data,
  };
}

// cyrb53 — a fast, non-cryptographic 53-bit string hash, used only to detect
// whether a job's serialized content changed between syncs.
function hashString(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
