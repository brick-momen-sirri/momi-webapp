import { appStateDriver, appStateSqlitePath } from "./config.js";
import { openSqliteMediaIndexStore, type SqliteMediaIndexStore } from "./sqliteMediaIndexStore.js";

let mediaIndexStore: SqliteMediaIndexStore | undefined;
let localInvalidationListener: (() => void) | undefined;

export function initializeSharedMediaIndexStore() {
  mediaIndexStore?.close();
  mediaIndexStore = appStateDriver === "sqlite"
    ? openSqliteMediaIndexStore(appStateSqlitePath)
    : undefined;
  return mediaIndexStore;
}

export function getSharedMediaIndexStore() {
  return mediaIndexStore;
}

export function invalidateSharedMediaIndex() {
  localInvalidationListener?.();
  return mediaIndexStore?.invalidate();
}

export function registerMediaIndexInvalidationListener(listener: () => void) {
  localInvalidationListener = listener;
}

export function closeSharedMediaIndexStore() {
  mediaIndexStore?.close();
  mediaIndexStore = undefined;
}
