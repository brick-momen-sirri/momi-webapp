import type { SqliteJobStore } from "../sqliteJobStore.js";

export type StoreCacheCursor = {
  dataVersion: number;
  revision: number;
};

export function loadConsistentSnapshot(store: SqliteJobStore) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = store.dataVersion();
    const snapshot = store.loadSnapshot();
    const after = store.dataVersion();
    if (before === after) {
      return {
        snapshot,
        cursor: { dataVersion: after, revision: snapshot.revision } satisfies StoreCacheCursor,
      };
    }
  }
  throw new Error("Could not read a stable SQLite job snapshot after 20 attempts.");
}

export function loadConsistentChanges(store: SqliteJobStore, afterRevision: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = store.dataVersion();
    const changes = store.loadChanges(afterRevision);
    const after = store.dataVersion();
    if (before === after) return { changes, dataVersion: after };
  }
  throw new Error("Could not read stable incremental SQLite job changes after 20 attempts.");
}
