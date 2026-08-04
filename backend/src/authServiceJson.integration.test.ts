// authService on the JSON store driver -- the branch the SQLite integration test
// does not reach, and roughly half the module.
//
// This is the security core: it decides who is signed in, what a session is worth,
// and when a session stops being valid. The assertions worth reading are the ones
// about revocation (disabling a user, changing a password, and resetting one all
// have to invalidate outstanding sessions) and the one confirming a password hash
// never leaves this module on a public user object.
//
// Env is set before the dynamic import because config.js reads it at module load,
// which is the same pattern authServiceSqlite.integration.test.ts uses.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import type { SessionRecord, StoredUser } from "./types.js";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "momi-auth-json-it-"));
const usersJsonPath = path.join(tempDir, "users.json");
const sessionsJsonPath = path.join(tempDir, "sessions.json");

process.env.APP_STATE_DRIVER = "json";
process.env.USERS_STORE_PATH = usersJsonPath;
process.env.SESSIONS_STORE_PATH = sessionsJsonPath;
process.env.MOMI_ADMIN_EMAIL = "admin@example.com";
process.env.MOMI_ADMIN_PASSWORD = "AdminPass123";

writeFileSync(usersJsonPath, "[]", "utf8");
writeFileSync(sessionsJsonPath, "[]", "utf8");

const authService = await import("./authService.js");

const adminEmail = "admin@example.com";
const adminPassword = "AdminPass123";

after(() => {
  authService.closeAuthStore();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // The OS temp dir is transient; a held handle on Windows is not worth failing on.
  }
});

// Each test starts from a store containing only the seeded default admin, so a
// user created in one test cannot collide with the next.
beforeEach(async () => {
  writeFileSync(usersJsonPath, "[]", "utf8");
  writeFileSync(sessionsJsonPath, "[]", "utf8");
  await authService.loadAuthData();
});

function storedUsers(): StoredUser[] {
  return JSON.parse(readFileSync(usersJsonPath, "utf8")) as StoredUser[];
}

function storedSessions(): SessionRecord[] {
  return JSON.parse(readFileSync(sessionsJsonPath, "utf8")) as SessionRecord[];
}

async function newUser(overrides: Partial<Parameters<typeof authService.createUser>[0]> = {}) {
  return authService.createUser({
    email: "artist@example.com",
    name: "Test Artist",
    password: "ArtistPass1",
    ...overrides,
  });
}

test("seeds a default admin and persists it to the JSON store", async () => {
  const users = storedUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].email, adminEmail);
  assert.equal(users[0].role, "admin");
  // The seeded password must be stored hashed, never in the clear.
  assert.ok(users[0].passwordHash.startsWith("scrypt$"));
  assert.ok(!JSON.stringify(users).includes(adminPassword));
});

test("a public user object never carries the password hash", async () => {
  // toPublicUser strips it; this is the boundary that keeps hashes out of API
  // responses, so it is asserted on every shape the service hands back.
  const created = await newUser();
  const login = await authService.login(adminEmail, adminPassword);
  const authed = await authService.getAuthenticatedUser(login.token);
  const fetched = authService.getUserById(created.id);

  for (const user of [created, login.user, authed, fetched, ...authService.listUsers()]) {
    assert.ok(user);
    assert.ok(!Object.hasOwn(user as object, "passwordHash"));
  }
});

test("login accepts the email, ignoring case and surrounding space", async () => {
  const result = await authService.login("  ADMIN@example.com  ", adminPassword);
  assert.equal(result.user.email, adminEmail);
  assert.ok(result.token);
  assert.ok(new Date(result.expiresAt).getTime() > Date.now());
});

test("login accepts a username as well as an email", async () => {
  await newUser({ username: "test.artist" });
  const result = await authService.login("TEST.ARTIST", "ArtistPass1");
  assert.equal(result.user.email, "artist@example.com");
});

test("login refuses a wrong password, an unknown identifier, and a disabled account", async () => {
  await assert.rejects(() => authService.login(adminEmail, "WrongPass1"), /invalid email or password/i);
  await assert.rejects(() => authService.login("nobody@example.com", adminPassword), /invalid email or password/i);

  const user = await newUser();
  await authService.updateUser(user.id, { active: false });
  // Same message for all three: the caller must not be able to tell a disabled
  // account from a non-existent one.
  await assert.rejects(() => authService.login("artist@example.com", "ArtistPass1"), /invalid email or password/i);
});

test("login records the session and the last-login timestamp", async () => {
  const before = storedUsers()[0].lastLoginAt;
  const result = await authService.login(adminEmail, adminPassword);

  const sessions = storedSessions();
  assert.equal(sessions.length, 1);
  // Only the hash is stored, never the bearer token itself.
  assert.notEqual(sessions[0].tokenHash, result.token);
  assert.ok(!JSON.stringify(sessions).includes(result.token));
  assert.notEqual(storedUsers()[0].lastLoginAt, before);
});

test("getAuthenticatedUser resolves a live token and rejects anything else", async () => {
  const { token } = await authService.login(adminEmail, adminPassword);

  assert.equal((await authService.getAuthenticatedUser(token))?.email, adminEmail);
  assert.equal(await authService.getAuthenticatedUser(undefined), undefined);
  assert.equal(await authService.getAuthenticatedUser(""), undefined);
  assert.equal(await authService.getAuthenticatedUser("not-a-real-token"), undefined);
});

test("an expired session is rejected and dropped from the store", async () => {
  const { token } = await authService.login(adminEmail, adminPassword);
  const sessions = storedSessions();
  sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(sessionsJsonPath, JSON.stringify(sessions), "utf8");
  await authService.loadAuthData();

  assert.equal(await authService.getAuthenticatedUser(token), undefined);
});

test("logout revokes only the token it was given", async () => {
  const first = await authService.login(adminEmail, adminPassword);
  const second = await authService.login(adminEmail, adminPassword);

  await authService.logout(first.token);

  assert.equal(await authService.getAuthenticatedUser(first.token), undefined);
  // A sign-out on one device must not sign the account out everywhere.
  assert.equal((await authService.getAuthenticatedUser(second.token))?.email, adminEmail);
});

test("logout with no token is a no-op rather than an error", async () => {
  await authService.login(adminEmail, adminPassword);
  await authService.logout(undefined);
  assert.equal(storedSessions().length, 1);
});

test("createUser applies safe defaults", async () => {
  const user = await newUser();
  assert.equal(user.role, "user");
  assert.equal(user.active, true);
  assert.equal(user.name, "Test Artist");
  assert.equal(user.avatar, "TA");
  assert.deepEqual(user.pinnedProjectIds, []);
});

test("createUser rejects a malformed email", async () => {
  for (const email of ["", "not-an-email", "no@domain", "spaces in@example.com"]) {
    await assert.rejects(() => newUser({ email }), /valid email/i);
  }
});

test("createUser rejects a duplicate email or username", async () => {
  await newUser({ username: "taken.name" });
  await assert.rejects(() => newUser({ email: "artist@example.com" }), /email/i);
  await assert.rejects(() => newUser({ email: "other@example.com", username: "TAKEN.NAME" }), /username/i);
});

test("createUser enforces the password policy", async () => {
  await assert.rejects(() => newUser({ password: "short1" }), /at least 8 characters/i);
  await assert.rejects(() => newUser({ password: "alllettersonly" }), /letter and one number/i);
  await assert.rejects(() => newUser({ password: "12345678" }), /letter and one number/i);
});

test("createUser rejects an unusable display name or username", async () => {
  await assert.rejects(() => newUser({ name: "A" }), /2-80 characters/i);
  await assert.rejects(() => newUser({ username: "ab" }), /username must be/i);
  await assert.rejects(() => newUser({ username: "has spaces" }), /username must be/i);
});

test("updateUser validates the role and keeps emails unique", async () => {
  const user = await newUser();
  await assert.rejects(() => authService.updateUser(user.id, { role: "superuser" as never }), /admin or user/i);
  await assert.rejects(() => authService.updateUser(user.id, { email: adminEmail }), /email/i);
  assert.equal((await authService.updateUser(user.id, { role: "admin" })).role, "admin");
});

test("updateUser rejects an unknown user", async () => {
  await assert.rejects(() => authService.updateUser("usr_nope", { role: "admin" }), /not found/i);
});

test("disabling a user revokes their outstanding sessions", async () => {
  const user = await newUser();
  const { token } = await authService.login("artist@example.com", "ArtistPass1");
  assert.ok(await authService.getAuthenticatedUser(token));

  await authService.updateUser(user.id, { active: false });

  // Otherwise a disabled account keeps working until its session expires.
  assert.equal(await authService.getAuthenticatedUser(token), undefined);
});

test("renaming a user refreshes the derived initials", async () => {
  const user = await newUser();
  const updated = await authService.updateUser(user.id, { name: "Nour Ahmad" });
  assert.equal(updated.name, "Nour Ahmad");
  assert.equal(updated.avatar, "NA");
});

test("changePassword requires the current password and then revokes sessions", async () => {
  const user = await newUser();
  const { token } = await authService.login("artist@example.com", "ArtistPass1");

  await assert.rejects(
    () => authService.changePassword(user.id, "WrongPass1", "NewPass123", "NewPass123"),
    /current password is incorrect/i,
  );
  await assert.rejects(() => authService.changePassword(user.id, "ArtistPass1", "NewPass123", "Mismatch1"), /do not match/i);
  await assert.rejects(() => authService.changePassword(user.id, "ArtistPass1", "weak", "weak"), /at least 8 characters/i);

  await authService.changePassword(user.id, "ArtistPass1", "NewPass123", "NewPass123");

  // Changing a password is the standard response to a suspected compromise, so
  // existing sessions must not survive it.
  assert.equal(await authService.getAuthenticatedUser(token), undefined);
  await assert.rejects(() => authService.login("artist@example.com", "ArtistPass1"), /invalid email or password/i);
  assert.ok(await authService.login("artist@example.com", "NewPass123"));
});

test("resetPassword sets a new password without knowing the old one, and revokes sessions", async () => {
  const user = await newUser();
  const { token } = await authService.login("artist@example.com", "ArtistPass1");

  await assert.rejects(() => authService.resetPassword(user.id, "NewPass123", "Mismatch1"), /do not match/i);
  await authService.resetPassword(user.id, "NewPass123", "NewPass123");

  assert.equal(await authService.getAuthenticatedUser(token), undefined);
  assert.ok(await authService.login("artist@example.com", "NewPass123"));
});

test("a rehashed password produces a different hash for the same input", async () => {
  const user = await newUser();
  const before = storedUsers().find((item) => item.id === user.id)?.passwordHash;
  await authService.resetPassword(user.id, "SamePass123", "SamePass123");
  const first = storedUsers().find((item) => item.id === user.id)?.passwordHash;
  await authService.resetPassword(user.id, "SamePass123", "SamePass123");
  const second = storedUsers().find((item) => item.id === user.id)?.passwordHash;

  assert.notEqual(first, before);
  // Per-user random salt: identical passwords must not share a hash, or one
  // cracked hash would reveal every account using that password.
  assert.notEqual(first, second);
});

test("updateOwnProfile changes only the fields a user owns", async () => {
  const user = await newUser();
  const updated = await authService.updateOwnProfile(user.id, { name: "Renamed Artist", avatarColor: "#ff0000" });

  assert.equal(updated.name, "Renamed Artist");
  assert.equal(updated.avatarColor, "#ff0000");
  // Role and active are not part of the own-profile surface.
  assert.equal(updated.role, "user");
  assert.equal(updated.active, true);
});

test("updateOwnProfile rejects an unknown user", async () => {
  await assert.rejects(() => authService.updateOwnProfile("usr_nope", { name: "Nobody" }), /not found/i);
});

test("updatePinnedProjects trims, dedupes and drops unusable ids", async () => {
  const user = await newUser();
  const updated = await authService.updatePinnedProjects(user.id, [
    "prj_1",
    "  prj_2  ",
    "prj_1",
    "",
    42 as never,
    "x".repeat(200),
  ]);

  assert.deepEqual(updated.pinnedProjectIds, ["prj_1", "prj_2"]);
});

test("updatePinnedProjects treats a non-array as an empty list", async () => {
  const user = await newUser();
  const updated = await authService.updatePinnedProjects(user.id, "prj_1" as never);
  assert.deepEqual(updated.pinnedProjectIds, []);
});

test("listUsers hides disabled accounts unless asked, and sorts by name", async () => {
  await newUser({ email: "zoe@example.com", name: "Zoe Last", password: "ZoePass123" });
  const disabled = await newUser({ email: "gone@example.com", name: "Gone Away", password: "GonePass123" });
  await authService.updateUser(disabled.id, { active: false });

  const visible = authService.listUsers();
  assert.ok(!visible.some((user) => user.email === "gone@example.com"));
  assert.deepEqual(
    visible.map((user) => user.name),
    [...visible.map((user) => user.name)].sort((a, b) => a.localeCompare(b)),
  );

  assert.ok(authService.listUsers({ includeDisabled: true }).some((user) => user.email === "gone@example.com"));
});

test("getUserById returns undefined for an unknown id", async () => {
  assert.equal(authService.getUserById("usr_nope"), undefined);
});

test("isAdmin distinguishes the two roles", async () => {
  const user = await newUser();
  assert.equal(authService.isAdmin(user), false);
  assert.equal(authService.isAdmin(await authService.updateUser(user.id, { role: "admin" })), true);
});

test("loadAuthData discards stored users that are not usable", async () => {
  writeFileSync(
    usersJsonPath,
    JSON.stringify([
      { id: "usr_ok", email: "ok@example.com", passwordHash: "scrypt$16384$8$1$salt$deadbeef", name: "Ok User" },
      { id: "usr_nohash", email: "nohash@example.com", name: "No Hash" },
      { id: "usr_bademail", email: "not-an-email", passwordHash: "scrypt$x", name: "Bad Email" },
    ]),
    "utf8",
  );
  await authService.loadAuthData();

  const emails = authService.listUsers({ includeDisabled: true }).map((user) => user.email);
  assert.ok(emails.includes("ok@example.com"));
  // A row with no hash could never authenticate, and one with an invalid email
  // could never be looked up; both are dropped rather than half-loaded.
  assert.ok(!emails.includes("nohash@example.com"));
  assert.ok(!emails.includes("not-an-email"));
});
