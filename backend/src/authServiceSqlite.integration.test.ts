import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { SessionRecord } from "./types.js";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-auth-service-it-"));
const usersJsonPath = path.join(tempDir, "users.json");
const sessionsJsonPath = path.join(tempDir, "sessions.json");
const appStatePath = path.join(tempDir, "app-state.sqlite");

process.env.APP_STATE_DRIVER = "sqlite";
process.env.APP_STATE_SQLITE_PATH = appStatePath;
process.env.USERS_STORE_PATH = usersJsonPath;
process.env.SESSIONS_STORE_PATH = sessionsJsonPath;
process.env.MOMI_ADMIN_EMAIL = "admin@example.com";
process.env.MOMI_ADMIN_PASSWORD = "AdminPass123";

writeFileSync(usersJsonPath, "[]", "utf8");
writeFileSync(sessionsJsonPath, "[]", "utf8");

const authService = await import("./authService.js");
const { openSqliteAuthStore } = await import("./sqliteAuthStore.js");
let externalStore: ReturnType<typeof openSqliteAuthStore> | undefined;

after(() => {
  externalStore?.close();
  authService.closeAuthStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL handles briefly; the OS temp dir is transient.
  }
});

test("authService observes cross-connection sessions, user edits, and revocation", async () => {
  await authService.loadAuthData();
  externalStore = openSqliteAuthStore(appStatePath);

  const login = await authService.login("admin@example.com", "AdminPass123");
  const loginHash = hashToken(login.token);
  assert.ok(externalStore.loadSessionByTokenHash(loginHash, new Date().toISOString()));
  assert.equal((await authService.getAuthenticatedUser(login.token))?.id, "usr_momen");

  const externalToken = "token-created-by-worker-b";
  const externalSession = session("ses_worker_b", "usr_momen", hashToken(externalToken));
  externalStore.insertSession(externalSession);
  assert.equal((await authService.getAuthenticatedUser(externalToken))?.email, "admin@example.com");

  externalStore.applyToUser("usr_momen", (user) => {
    user.displayName = "Edited by worker B";
    user.name = user.displayName;
    user.updatedAt = new Date().toISOString();
  });
  assert.equal(authService.getUserById("usr_momen")?.displayName, "Edited by worker B");

  externalStore.applyToUser("usr_momen", (user) => {
    user.active = false;
    user.updatedAt = new Date().toISOString();
  }, { revokeSessions: true });
  assert.equal(await authService.getAuthenticatedUser(login.token), undefined);
  assert.equal(await authService.getAuthenticatedUser(externalToken), undefined);
  await assert.rejects(authService.login("admin@example.com", "AdminPass123"), /Invalid email or password/);

  assert.equal(readFileSync(usersJsonPath, "utf8"), "[]");
  assert.equal(readFileSync(sessionsJsonPath, "utf8"), "[]");
});

function session(id: string, userId: string, tokenHash: string): SessionRecord {
  const now = new Date();
  return {
    id,
    userId,
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    lastUsedAt: now.toISOString(),
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
