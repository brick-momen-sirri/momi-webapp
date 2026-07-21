import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { assertNoEmbeddedMedia } from "./storageService.js";
import type { SessionRecord, StoredUser } from "./types.js";

export type SqliteAuthStore = {
  countUsers(): number;
  loadUsers(): StoredUser[];
  loadUserById(id: string): StoredUser | undefined;
  loadUserByIdentifier(identifier: string): StoredUser | undefined;
  insertUser(user: StoredUser): void;
  insertFirstUser(user: StoredUser): boolean;
  applyToUser(
    id: string,
    mutate: (user: StoredUser) => StoredUser | void,
    options?: { revokeSessions?: boolean },
  ): StoredUser | undefined;
  recordLogin(userId: string, expectedPasswordHash: string, session: SessionRecord): StoredUser | undefined;
  loadSessionByTokenHash(tokenHash: string, now: string): SessionRecord | undefined;
  loadSessions(): SessionRecord[];
  insertSession(session: SessionRecord): void;
  touchSession(tokenHash: string, lastUsedAt: string, updateBefore: string): boolean;
  deleteSessionByTokenHash(tokenHash: string): boolean;
  deleteSessionsByUserId(userId: string): number;
  migrateFromJsonIfNeeded(users: StoredUser[], sessions: SessionRecord[]): boolean;
  close(): void;
};

type UserRow = { data: string };
type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
};

export function openSqliteAuthStore(dbPath: string): SqliteAuthStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email_norm TEXT NOT NULL UNIQUE,
      username_norm TEXT UNIQUE,
      active INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_users_active ON auth_users(active);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS auth_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const countUsers = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM auth_users");
  const countSessions = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM auth_sessions");
  const selectUsers = db.prepare<[], UserRow>("SELECT data FROM auth_users ORDER BY updated_at DESC, id ASC");
  const selectUserById = db.prepare<[string], UserRow>("SELECT data FROM auth_users WHERE id = ?");
  const selectUserByIdentifier = db.prepare<[string, string], UserRow>(`
    SELECT data FROM auth_users
    WHERE email_norm = ? OR username_norm = ?
    LIMIT 1
  `);
  const insertUser = db.prepare(`
    INSERT INTO auth_users (id, email_norm, username_norm, active, updated_at, data)
    VALUES (@id, @email_norm, @username_norm, @active, @updated_at, @data)
  `);
  const insertUserOrIgnore = db.prepare(`
    INSERT OR IGNORE INTO auth_users (id, email_norm, username_norm, active, updated_at, data)
    VALUES (@id, @email_norm, @username_norm, @active, @updated_at, @data)
  `);
  const updateUser = db.prepare(`
    UPDATE auth_users
    SET email_norm = @email_norm,
        username_norm = @username_norm,
        active = @active,
        updated_at = @updated_at,
        data = @data
    WHERE id = @id
  `);

  const selectSessions = db.prepare<[], SessionRow>(`
    SELECT id, user_id, token_hash, created_at, expires_at, last_used_at
    FROM auth_sessions
    ORDER BY created_at DESC
  `);
  const selectSessionByToken = db.prepare<[string, string], SessionRow>(`
    SELECT id, user_id, token_hash, created_at, expires_at, last_used_at
    FROM auth_sessions
    WHERE token_hash = ? AND expires_at > ?
    LIMIT 1
  `);
  const insertSession = db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES (@id, @user_id, @token_hash, @created_at, @expires_at, @last_used_at)
  `);
  const migrateSessionOrIgnore = db.prepare(`
    INSERT OR IGNORE INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    SELECT @id, @user_id, @token_hash, @created_at, @expires_at, @last_used_at
    WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = @user_id)
  `);
  const touchSession = db.prepare(`
    UPDATE auth_sessions
    SET last_used_at = @last_used_at
    WHERE token_hash = @token_hash AND last_used_at < @update_before
  `);
  const deleteSessionByToken = db.prepare<[string]>("DELETE FROM auth_sessions WHERE token_hash = ?");
  const deleteSessionsByUser = db.prepare<[string]>("DELETE FROM auth_sessions WHERE user_id = ?");
  const deleteExpiredSessions = db.prepare<[string]>("DELETE FROM auth_sessions WHERE expires_at <= ?");
  const migrationComplete = db.prepare<[], { value: string }>(
    "SELECT value FROM auth_meta WHERE key = 'json_migration_complete'",
  );
  const markMigrationComplete = db.prepare(`
    INSERT INTO auth_meta (key, value) VALUES ('json_migration_complete', @completed_at)
    ON CONFLICT(key) DO NOTHING
  `);

  const insertFirstUserTx = db.transaction((user: StoredUser) => {
    if ((countUsers.get()?.n ?? 0) > 0) return false;
    insertUser.run(userParams(user));
    return true;
  });

  const applyToUserTx = db.transaction((
    id: string,
    mutate: (user: StoredUser) => StoredUser | void,
    revokeSessions: boolean,
  ) => {
    const row = selectUserById.get(id);
    if (!row) return undefined;
    const current = JSON.parse(row.data) as StoredUser;
    const next = (mutate(current) ?? current) as StoredUser;
    assertNoEmbeddedMedia(next, `user ${id}`);
    updateUser.run(userParams(next));
    if (revokeSessions) deleteSessionsByUser.run(id);
    return next;
  });

  const recordLoginTx = db.transaction((userId: string, expectedPasswordHash: string, session: SessionRecord) => {
    const row = selectUserById.get(userId);
    if (!row) return undefined;
    const user = JSON.parse(row.data) as StoredUser;
    if (!user.active || user.passwordHash !== expectedPasswordHash) return undefined;
    user.lastLoginAt = session.createdAt;
    user.updatedAt = session.createdAt;
    updateUser.run(userParams(user));
    deleteExpiredSessions.run(session.createdAt);
    insertSession.run(sessionParams(session));
    return user;
  });

  const migrateFromJsonTx = db.transaction((users: StoredUser[], sessions: SessionRecord[]) => {
    if (migrationComplete.get()) return false;
    if ((countUsers.get()?.n ?? 0) === 0) {
      for (const user of users) {
        assertNoEmbeddedMedia(user, `user ${user.id}`);
        insertUserOrIgnore.run(userParams(user));
      }
    }
    if ((countSessions.get()?.n ?? 0) === 0) {
      for (const session of sessions) {
        migrateSessionOrIgnore.run(sessionParams(session));
      }
    }
    markMigrationComplete.run({ completed_at: new Date().toISOString() });
    return true;
  });

  return {
    countUsers() {
      return countUsers.get()?.n ?? 0;
    },
    loadUsers() {
      return selectUsers.all().map((row) => JSON.parse(row.data) as StoredUser);
    },
    loadUserById(id: string) {
      const row = selectUserById.get(id);
      return row ? JSON.parse(row.data) as StoredUser : undefined;
    },
    loadUserByIdentifier(identifier: string) {
      const row = selectUserByIdentifier.get(identifier, identifier);
      return row ? JSON.parse(row.data) as StoredUser : undefined;
    },
    insertUser(user: StoredUser) {
      assertNoEmbeddedMedia(user, `user ${user.id}`);
      insertUser.run(userParams(user));
    },
    insertFirstUser(user: StoredUser) {
      assertNoEmbeddedMedia(user, `user ${user.id}`);
      return insertFirstUserTx.immediate(user);
    },
    applyToUser(id, mutate, options = {}) {
      return applyToUserTx.immediate(id, mutate, options.revokeSessions === true);
    },
    recordLogin(userId, expectedPasswordHash, session) {
      return recordLoginTx.immediate(userId, expectedPasswordHash, session);
    },
    loadSessionByTokenHash(tokenHash: string, now: string) {
      const row = selectSessionByToken.get(tokenHash, now);
      return row ? toSession(row) : undefined;
    },
    loadSessions() {
      return selectSessions.all().map(toSession);
    },
    insertSession(session: SessionRecord) {
      insertSession.run(sessionParams(session));
    },
    touchSession(tokenHash: string, lastUsedAt: string, updateBefore: string) {
      return touchSession.run({
        token_hash: tokenHash,
        last_used_at: lastUsedAt,
        update_before: updateBefore,
      }).changes === 1;
    },
    deleteSessionByTokenHash(tokenHash: string) {
      return deleteSessionByToken.run(tokenHash).changes === 1;
    },
    deleteSessionsByUserId(userId: string) {
      return deleteSessionsByUser.run(userId).changes;
    },
    migrateFromJsonIfNeeded(users: StoredUser[], sessions: SessionRecord[]) {
      return migrateFromJsonTx.immediate(users, sessions);
    },
    close() {
      db.close();
    },
  };
}

function userParams(user: StoredUser) {
  return {
    id: user.id,
    email_norm: user.email.trim().toLowerCase(),
    username_norm: user.username?.trim().toLowerCase() || null,
    active: user.active ? 1 : 0,
    updated_at: user.updatedAt,
    data: JSON.stringify(user),
  };
}

function sessionParams(session: SessionRecord) {
  return {
    id: session.id,
    user_id: session.userId,
    token_hash: session.tokenHash,
    created_at: session.createdAt,
    expires_at: session.expiresAt,
    last_used_at: session.lastUsedAt,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}
