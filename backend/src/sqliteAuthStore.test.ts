import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAuthStore } from "./sqliteAuthStore.js";
import type { SessionRecord, StoredUser } from "./types.js";

async function withStores(run: (
  a: ReturnType<typeof openSqliteAuthStore>,
  b: ReturnType<typeof openSqliteAuthStore>,
) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-auth-sqlite-"));
  const dbPath = path.join(dir, "app-state.sqlite");
  const a = openSqliteAuthStore(dbPath);
  const b = openSqliteAuthStore(dbPath);
  try {
    run(a, b);
  } finally {
    a.close();
    b.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("JSON migration is atomic and runs only once across connections", async () => {
  await withStores((a, b) => {
    const seedUser = user("usr_seed");
    const seedSession = session("ses_seed", seedUser.id, "hash_seed");
    assert.equal(a.migrateFromJsonIfNeeded([seedUser], [seedSession]), true);
    assert.equal(b.migrateFromJsonIfNeeded([user("usr_other")], []), false);
    assert.deepEqual(b.loadUsers().map((item) => item.id), [seedUser.id]);
    assert.deepEqual(b.loadSessions().map((item) => item.id), [seedSession.id]);
  });
});

test("JSON migration skips sessions whose user no longer exists", async () => {
  await withStores((a, b) => {
    const seedUser = user("usr_seed");
    const liveSession = session("ses_live", seedUser.id, "hash_live");
    const staleSession = session("ses_stale", "usr_deleted", "hash_stale");

    assert.equal(a.migrateFromJsonIfNeeded([seedUser], [liveSession, staleSession]), true);
    assert.deepEqual(b.loadSessions().map((item) => item.id), [liveSession.id]);
  });
});

test("sessions created on one connection are immediately visible on another", async () => {
  await withStores((a, b) => {
    const storedUser = user("usr_1");
    a.insertUser(storedUser);
    const first = session("ses_a", storedUser.id, "hash_a");
    const second = session("ses_b", storedUser.id, "hash_b");

    assert.equal(a.recordLogin(storedUser.id, storedUser.passwordHash, first)?.lastLoginAt, first.createdAt);
    b.insertSession(second);
    assert.equal(b.loadSessionByTokenHash(first.tokenHash, "2026-07-21T00:00:00.000Z")?.id, first.id);
    assert.equal(a.loadSessionByTokenHash(second.tokenHash, "2026-07-21T00:00:00.000Z")?.id, second.id);
    assert.deepEqual(a.loadSessions().map((item) => item.id).sort(), [first.id, second.id]);
  });
});

test("user disable and session revocation are one transaction", async () => {
  await withStores((a, b) => {
    const storedUser = user("usr_1");
    a.insertUser(storedUser);
    a.insertSession(session("ses_1", storedUser.id, "hash_1"));
    b.insertSession(session("ses_2", storedUser.id, "hash_2"));

    const disabled = a.applyToUser(storedUser.id, (current) => {
      current.active = false;
      current.updatedAt = "2026-07-21T01:00:00.000Z";
    }, { revokeSessions: true });

    assert.equal(disabled?.active, false);
    assert.equal(b.loadUserById(storedUser.id)?.active, false);
    assert.equal(b.loadSessions().length, 0);
  });
});

test("token touches are throttled and unique identities are DB-enforced", async () => {
  await withStores((a, b) => {
    const storedUser = user("usr_1");
    a.insertUser(storedUser);
    const storedSession = session("ses_1", storedUser.id, "hash_1");
    a.insertSession(storedSession);

    assert.equal(a.touchSession(
      storedSession.tokenHash,
      "2026-07-21T00:01:00.000Z",
      "2026-07-21T00:00:00.000Z",
    ), false);
    assert.equal(b.touchSession(
      storedSession.tokenHash,
      "2026-07-21T00:02:00.000Z",
      "2026-07-21T00:01:00.000Z",
    ), true);
    assert.equal(a.loadSessionByTokenHash(storedSession.tokenHash, "2026-07-21T00:00:00.000Z")?.lastUsedAt, "2026-07-21T00:02:00.000Z");

    assert.throws(() => b.insertUser(user("usr_duplicate", { email: storedUser.email })), /UNIQUE/i);
  });
});

test("only one connection can create the first user", async () => {
  await withStores((a, b) => {
    assert.equal(a.insertFirstUser(user("usr_first")), true);
    assert.equal(b.insertFirstUser(user("usr_second")), false);
    assert.equal(a.countUsers(), 1);
  });
});

test("late login cannot recreate a session after password reset", async () => {
  await withStores((a, b) => {
    const storedUser = user("usr_1");
    a.insertUser(storedUser);
    b.applyToUser(storedUser.id, (current) => {
      current.passwordHash = "new-password-hash";
      current.updatedAt = "2026-07-21T01:00:00.000Z";
    }, { revokeSessions: true });

    assert.equal(
      a.recordLogin(storedUser.id, storedUser.passwordHash, session("ses_late", storedUser.id, "hash_late")),
      undefined,
    );
    assert.equal(a.loadSessions().length, 0);
  });
});

function user(id: string, overrides: Partial<StoredUser> = {}): StoredUser {
  const createdAt = "2026-07-20T00:00:00.000Z";
  return {
    id,
    email: `${id}@example.com`,
    username: id,
    name: id,
    displayName: id,
    passwordHash: "scrypt$16384$8$1$salt$hash",
    role: "user",
    active: true,
    pinnedProjectIds: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function session(id: string, userId: string, tokenHash: string): SessionRecord {
  return {
    id,
    userId,
    tokenHash,
    createdAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-22T00:00:00.000Z",
    lastUsedAt: "2026-07-21T00:00:00.000Z",
  };
}
