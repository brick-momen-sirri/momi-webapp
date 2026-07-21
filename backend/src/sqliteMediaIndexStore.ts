import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { assertNoEmbeddedMedia } from "./storageService.js";
import type { Job } from "./types.js";

export type MediaIndexState = {
  dirtyRevision: number;
  builtRevision: number;
  publishedAt?: string;
};

export type PublishedMediaIndex = MediaIndexState & {
  jobs: Job[];
};

export type SqliteMediaIndexStore = {
  loadState(): MediaIndexState;
  loadPublishedIfNewer(afterRevision: number): PublishedMediaIndex | undefined;
  invalidate(): number;
  publish(revision: number, jobs: Job[]): boolean;
  close(): void;
};

type MediaIndexRow = {
  dirty_revision: number;
  built_revision: number;
  published_at: string | null;
  data: string;
};

export function openSqliteMediaIndexStore(dbPath: string): SqliteMediaIndexStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dirty_revision INTEGER NOT NULL,
      built_revision INTEGER NOT NULL,
      published_at TEXT,
      data TEXT NOT NULL
    );
    INSERT OR IGNORE INTO media_index_state (
      id, dirty_revision, built_revision, published_at, data
    ) VALUES (1, 1, 0, NULL, '[]');
  `);

  const selectState = db.prepare<[], MediaIndexRow>(`
    SELECT dirty_revision, built_revision, published_at, data
    FROM media_index_state
    WHERE id = 1
  `);
  const selectPublishedIfNewer = db.prepare<[number], MediaIndexRow>(`
    SELECT dirty_revision, built_revision, published_at, data
    FROM media_index_state
    WHERE id = 1 AND built_revision > ?
  `);
  const invalidate = db.prepare(`
    UPDATE media_index_state
    SET dirty_revision = dirty_revision + 1
    WHERE id = 1
    RETURNING dirty_revision
  `);
  const publish = db.prepare(`
    UPDATE media_index_state
    SET built_revision = @revision,
        published_at = @published_at,
        data = @data
    WHERE id = 1
      AND built_revision < @revision
      AND dirty_revision >= @revision
  `);

  return {
    loadState() {
      return stateFromRow(requiredRow(selectState.get()));
    },
    loadPublishedIfNewer(afterRevision: number) {
      const row = selectPublishedIfNewer.get(afterRevision);
      return row ? publishedFromRow(row) : undefined;
    },
    invalidate() {
      const row = invalidate.get() as { dirty_revision: number } | undefined;
      if (!row) throw new Error("Could not invalidate the shared media index.");
      return row.dirty_revision;
    },
    publish(revision: number, jobs: Job[]) {
      assertNoEmbeddedMedia(jobs, "shared media index");
      return publish.run({
        revision,
        published_at: new Date().toISOString(),
        data: JSON.stringify(jobs),
      }).changes === 1;
    },
    close() {
      db.close();
    },
  };
}

function requiredRow(row: MediaIndexRow | undefined) {
  if (!row) throw new Error("Shared media index state is missing.");
  return row;
}

function stateFromRow(row: MediaIndexRow): MediaIndexState {
  return {
    dirtyRevision: row.dirty_revision,
    builtRevision: row.built_revision,
    publishedAt: row.published_at ?? undefined,
  };
}

function publishedFromRow(row: MediaIndexRow): PublishedMediaIndex {
  return {
    ...stateFromRow(row),
    jobs: JSON.parse(row.data) as Job[],
  };
}
