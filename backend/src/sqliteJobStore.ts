import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { assertNoEmbeddedMedia } from "./storageService.js";
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

export type OpenOptions = {
  // Open an existing store for reading only. The DB file MUST already exist
  // (no create-on-missing) and the schema is not touched; replaceAll throws.
  // Used by the exporter so a missing/mis-pathed DB fails loudly instead of
  // fabricating an empty store and clobbering the JSON fallback.
  readonly?: boolean;
};

export type SqliteJobStore = {
  loadAll(): Job[];
  replaceAll(jobs: Job[]): SyncStats;
  // Per-row writes for the multi-process (web/worker) model: each mutation
  // touches only its own row, so a second process's concurrent writes are never
  // clobbered the way a whole-array replaceAll would. seq is assigned in-DB
  // under an IMMEDIATE transaction, so inserts from different processes never
  // collide. Not yet on the live path — replaceAll remains the default writer
  // until jobQueue is switched over.
  insertJob(job: Job): void;
  updateJob(job: Job): boolean;
  applyToJob(id: string, mutate: (job: Job) => Job | void): Job | undefined;
  deleteJob(id: string): boolean;
  count(): number;
  // SQLite's data_version: unchanged by this connection's own commits, but
  // bumped when ANOTHER connection commits. The cross-process change signal a
  // reader (API worker / dispatcher) polls to know when to reload its cache,
  // instead of re-reading the whole table on every request.
  dataVersion(): number;
  close(): void;
};

type JobRow = { data: string };

// `table` lets a second logical store (archived items) reuse this code. It is
// a hardcoded identifier from config, never user input, but is validated to
// keep the SQL string interpolation safe.
export function openSqliteJobStore(dbPath: string, table = "jobs", opts: OpenOptions = {}): SqliteJobStore {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`Invalid SQLite table name: ${table}`);
  }
  const readonly = opts.readonly === true;
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // fileMustExist stops better-sqlite3 from silently creating an empty DB when
  // the path is wrong or the store was never initialized.
  const db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
  // Wait (rather than throw SQLITE_BUSY) when another connection/process holds
  // the write lock. Harmless single-process; required once the web tier and the
  // dispatcher write the same file. Keep write transactions tiny so this wait
  // (which blocks the synchronous better-sqlite3 call) stays sub-millisecond.
  db.pragma("busy_timeout = 5000");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
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
      CREATE INDEX IF NOT EXISTS idx_${table}_seq ON ${table}(seq);
      CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(status);
      CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id);
      CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id);
      CREATE INDEX IF NOT EXISTS idx_${table}_created ON ${table}(created_at);
    `);
  }

  // seq is a stable, monotonically increasing insertion key (higher = newer),
  // assigned once per job and never rewritten, so a prepend doesn't touch
  // existing rows. loadAll returns newest-first (matching the in-memory array,
  // which createJob prepends to). In readonly mode a missing table throws here
  // (the store was never initialized) rather than returning a bogus empty set.
  const selectAll = db.prepare<[], JobRow>(`SELECT data FROM ${table} ORDER BY seq DESC`);
  const countStmt = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);

  if (readonly) {
    const readonlyError = () => {
      throw new Error("Cannot write to a read-only SQLite job store.");
    };
    return {
      loadAll() {
        return selectAll.all().map((row) => JSON.parse(row.data) as Job);
      },
      count() {
        return countStmt.get()?.n ?? 0;
      },
      replaceAll: readonlyError,
      insertJob: readonlyError,
      updateJob: readonlyError,
      applyToJob: readonlyError,
      deleteJob: readonlyError,
      dataVersion() {
        return db.pragma("data_version", { simple: true }) as number;
      },
      close() {
        db.close();
      },
    };
  }

  const selectIdSeq = db.prepare<[], { id: string; seq: number }>(`SELECT id, seq FROM ${table}`);
  const upsert = db.prepare(`
    INSERT INTO ${table} (id, seq, status, project_id, user_id, created_at, completed_at, comfy_prompt_id, credits_used, data)
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
  const deleteById = db.prepare<[string]>(`DELETE FROM ${table} WHERE id = ?`);
  const selectOne = db.prepare<[string], JobRow>(`SELECT data FROM ${table} WHERE id = ?`);
  const maxSeqStmt = db.prepare<[], { m: number }>(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table}`);
  const updateColumns = db.prepare(`
    UPDATE ${table} SET
      status = @status, project_id = @project_id, user_id = @user_id,
      created_at = @created_at, completed_at = @completed_at,
      comfy_prompt_id = @comfy_prompt_id, credits_used = @credits_used, data = @data
    WHERE id = @id
  `);

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
      // Enforce the same no-embedded-media / max-string-size contract as the
      // JSON writer, so the two stores stay symmetric and a later export can
      // never fail on data SQLite accepted but writeJsonFile would reject.
      assertNoEmbeddedMedia(job, `job ${job.id}`);
      upsert.run(toRow(job, knownSeq.get(job.id)!, data));
      knownHash.set(job.id, hash);
      written += 1;
    }

    return { written, deleted };
  });

  const updateParams = (job: Job, data: string) => {
    const { seq: _seq, ...rest } = toRow(job, 0, data);
    return rest;
  };

  // Insert a new row (or refresh an existing id's data), assigning seq = MAX+1
  // inside an IMMEDIATE transaction so two processes can never collide on seq.
  const insertJobTx = db.transaction((job: Job) => {
    const data = JSON.stringify(job);
    assertNoEmbeddedMedia(job, `job ${job.id}`);
    const seq = knownSeq.get(job.id) ?? maxSeqStmt.get()!.m + 1;
    upsert.run(toRow(job, seq, data));
    knownSeq.set(job.id, seq);
    knownHash.set(job.id, hashString(data));
    if (seq >= nextSeq) nextSeq = seq + 1;
  });

  // Read-modify-write a single row atomically (forward-safe for cross-process:
  // never writes a cache-built blob over a row another process may have edited).
  const applyToJobTx = db.transaction((id: string, mutate: (job: Job) => Job | void) => {
    const row = selectOne.get(id);
    if (!row) return undefined;
    const current = JSON.parse(row.data) as Job;
    const next = (mutate(current) ?? current) as Job;
    const data = JSON.stringify(next);
    assertNoEmbeddedMedia(next, `job ${id}`);
    updateColumns.run(updateParams(next, data));
    knownHash.set(id, hashString(data));
    return next;
  });

  return {
    loadAll() {
      return selectAll.all().map((row) => JSON.parse(row.data) as Job);
    },
    replaceAll(jobs: Job[]) {
      return syncTx(jobs);
    },
    insertJob(job: Job) {
      insertJobTx.immediate(job);
    },
    updateJob(job: Job) {
      const data = JSON.stringify(job);
      assertNoEmbeddedMedia(job, `job ${job.id}`);
      const info = updateColumns.run(updateParams(job, data));
      if (info.changes > 0) {
        knownHash.set(job.id, hashString(data));
        return true;
      }
      return false;
    },
    applyToJob(id: string, mutate: (job: Job) => Job | void) {
      return applyToJobTx.immediate(id, mutate);
    },
    deleteJob(id: string) {
      const info = deleteById.run(id);
      knownSeq.delete(id);
      knownHash.delete(id);
      return info.changes > 0;
    },
    count() {
      return countStmt.get()?.n ?? 0;
    },
    dataVersion() {
      return db.pragma("data_version", { simple: true }) as number;
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
