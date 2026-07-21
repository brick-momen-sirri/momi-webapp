import fs from "node:fs/promises";
import path from "node:path";
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import {
  appStateDriver,
  appStateSqlitePath,
  authSessionDays,
  defaultAdminEmail,
  defaultAdminPassword,
  initialAdminPath,
  sessionsStorePath,
  usersStorePath,
} from "./config.js";
import { openSqliteAuthStore, type SqliteAuthStore } from "./sqliteAuthStore.js";
import { readJsonFile, writeJsonFile } from "./storageService.js";
import type { SessionRecord, StoredUser, User, UserRole } from "./types.js";

type CreateUserInput = {
  id?: string;
  email: string;
  username?: string;
  name?: string;
  displayName?: string;
  password: string;
  role?: UserRole;
  active?: boolean;
  avatar?: string;
  avatarColor?: string;
  profileImageUrl?: string;
  pinnedProjectIds?: string[];
};

type UpdateUserInput = Partial<{
  email: string;
  username: string;
  name: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  avatarColor: string;
  profileImageUrl: string;
}>;

type LoginResult = {
  token: string;
  expiresAt: string;
  user: User;
};

const scryptOptions: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const passwordHashPrefix = "scrypt";
const passwordHashLength = 64;
const devFallbackPassword = "BRI-vis-2026";
const sessionTtlMs = Math.max(1, authSessionDays) * 24 * 60 * 60 * 1000;

let users: StoredUser[] = [];
let sessions: SessionRecord[] = [];
let sqliteAuthStore: SqliteAuthStore | undefined;

export async function loadAuthData() {
  sqliteAuthStore?.close();
  sqliteAuthStore = undefined;
  const storedUsers = (await readJsonFile<StoredUser[]>(usersStorePath, []))
    .map(normalizeStoredUser)
    .filter(Boolean) as StoredUser[];
  const storedSessions = (await readJsonFile<SessionRecord[]>(sessionsStorePath, [])).filter(isUsableSession);

  if (appStateDriver === "sqlite") {
    sqliteAuthStore = openSqliteAuthStore(appStateSqlitePath);
    const migrated = sqliteAuthStore.migrateFromJsonIfNeeded(storedUsers, storedSessions);
    if (migrated && (storedUsers.length || storedSessions.length)) {
      console.log(`Migrated ${storedUsers.length} users and ${storedSessions.length} sessions into app-state SQLite.`);
    }
    users = [];
    sessions = [];
  } else {
    users = storedUsers;
    sessions = storedSessions;
  }

  await ensureDefaultAdmin();
  if (!sqliteAuthStore) {
    await persistUsers();
    await persistSessions();
  }
}

export function closeAuthStore() {
  sqliteAuthStore?.close();
  sqliteAuthStore = undefined;
}

export function listUsers(options: { includeDisabled?: boolean } = {}) {
  return authUsers()
    .filter((user) => options.includeDisabled || user.active)
    .map(toPublicUser)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getUserById(userId: string) {
  const user = sqliteAuthStore?.loadUserById(userId) ?? users.find((item) => item.id === userId);
  return user ? toPublicUser(user) : undefined;
}

export async function login(identifier: string, password: string): Promise<LoginResult> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const user = sqliteAuthStore?.loadUserByIdentifier(normalizedIdentifier) ?? users.find((item) => {
    return item.email === normalizedIdentifier || normalizeUsername(item.username) === normalizeUsername(normalizedIdentifier);
  });

  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    throw new Error("Invalid email or password.");
  }

  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlMs).toISOString();
  const session: SessionRecord = {
    id: `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    userId: user.id,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt,
    lastUsedAt: now.toISOString(),
  };

  if (sqliteAuthStore) {
    const updated = sqliteAuthStore.recordLogin(user.id, user.passwordHash, session);
    if (!updated) throw new Error("Invalid email or password.");
    return { token, expiresAt, user: toPublicUser(updated) };
  }

  sessions = [
    session,
    ...sessions.filter((session) => session.userId !== user.id || new Date(session.expiresAt).getTime() > now.getTime()),
  ];
  user.lastLoginAt = now.toISOString();
  user.updatedAt = now.toISOString();
  await persistUsers();
  await persistSessions();
  return { token, expiresAt, user: toPublicUser(user) };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const tokenHash = hashToken(token);
  if (sqliteAuthStore) {
    sqliteAuthStore.deleteSessionByTokenHash(tokenHash);
    return;
  }
  const before = sessions.length;
  sessions = sessions.filter((session) => session.tokenHash !== tokenHash);
  if (sessions.length !== before) {
    await persistSessions();
  }
}

export async function getAuthenticatedUser(token: string | undefined) {
  if (!token) return undefined;
  const now = Date.now();
  const tokenHash = hashToken(token);
  if (sqliteAuthStore) {
    const nowIso = new Date(now).toISOString();
    const session = sqliteAuthStore.loadSessionByTokenHash(tokenHash, nowIso);
    if (!session) return undefined;
    const user = sqliteAuthStore.loadUserById(session.userId);
    if (!user || !user.active) {
      sqliteAuthStore.deleteSessionByTokenHash(tokenHash);
      return undefined;
    }
    sqliteAuthStore.touchSession(
      tokenHash,
      nowIso,
      new Date(now - 60_000).toISOString(),
    );
    return toPublicUser(user);
  }

  let changed = false;
  sessions = sessions.filter((session) => {
    const valid = new Date(session.expiresAt).getTime() > now;
    if (!valid) changed = true;
    return valid;
  });

  const session = sessions.find((item) => item.tokenHash === tokenHash);
  if (!session) {
    if (changed) void tryPersistSessions();
    return undefined;
  }

  const user = users.find((item) => item.id === session.userId);
  if (!user || !user.active) {
    sessions = sessions.filter((item) => item.id !== session.id);
    void tryPersistSessions();
    return undefined;
  }

  session.lastUsedAt = new Date().toISOString();
  void tryPersistSessions();
  return toPublicUser(user);
}

export async function createUser(input: CreateUserInput) {
  const user = await buildStoredUser(input);
  if (sqliteAuthStore) {
    try {
      sqliteAuthStore.insertUser(user);
    } catch (error) {
      throwIdentityConstraint(error);
    }
    return toPublicUser(user);
  }
  users = [user, ...users];
  await persistUsers();
  return toPublicUser(user);
}

export async function updateOwnProfile(
  userId: string,
  updates: Pick<UpdateUserInput, "name" | "displayName" | "avatarColor" | "profileImageUrl">,
) {
  if (sqliteAuthStore) {
    const updated = sqliteAuthStore.applyToUser(userId, (user) => {
      applyOwnProfileUpdates(user, updates);
    });
    if (!updated) throw new Error("User not found.");
    return toPublicUser(updated);
  }
  const user = findStoredUser(userId);
  applyOwnProfileUpdates(user, updates);
  await persistUsers();
  return toPublicUser(user);
}

export async function updatePinnedProjects(userId: string, projectIds: string[]) {
  if (sqliteAuthStore) {
    const updated = sqliteAuthStore.applyToUser(userId, (user) => {
      user.pinnedProjectIds = sanitizePinnedProjectIds(projectIds);
      user.updatedAt = new Date().toISOString();
    });
    if (!updated) throw new Error("User not found.");
    return toPublicUser(updated);
  }
  const user = findStoredUser(userId);
  user.pinnedProjectIds = sanitizePinnedProjectIds(projectIds);
  user.updatedAt = new Date().toISOString();
  await persistUsers();
  return toPublicUser(user);
}

export async function updateUser(userId: string, input: UpdateUserInput) {
  if (sqliteAuthStore) {
    try {
      const updated = sqliteAuthStore.applyToUser(userId, (user) => {
        applyUserUpdates(user, input);
      }, { revokeSessions: input.active === false });
      if (!updated) throw new Error("User not found.");
      return toPublicUser(updated);
    } catch (error) {
      throwIdentityConstraint(error);
    }
  }

  const user = findStoredUser(userId);
  applyUserUpdates(user, input);
  if (input.active === false) {
    sessions = sessions.filter((session) => session.userId !== user.id);
    await persistSessions();
  }
  await persistUsers();
  return toPublicUser(user);
}

function applyUserUpdates(user: StoredUser, input: UpdateUserInput) {
  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (!email) throw new Error("Enter a valid email address.");
    assertUniqueEmail(email, user.id);
    user.email = email;
  }
  if (input.username !== undefined) {
    const username = safeOptionalUsername(input.username);
    assertUniqueUsername(username, user.id);
    user.username = username;
  }
  if (input.displayName !== undefined || input.name !== undefined) {
    const displayName = safeDisplayName(input.displayName ?? input.name ?? user.displayName);
    user.displayName = displayName;
    user.name = displayName;
    user.avatar = initialsFor(displayName);
  }
  if (input.role !== undefined) {
    if (input.role !== "admin" && input.role !== "user") throw new Error("Role must be admin or user.");
    user.role = input.role;
  }
  if (input.active !== undefined) {
    user.active = Boolean(input.active);
  }
  if (input.avatarColor !== undefined) user.avatarColor = safeAvatarColor(input.avatarColor);
  if (input.profileImageUrl !== undefined) user.profileImageUrl = safeOptionalString(input.profileImageUrl, 250000);
  user.updatedAt = new Date().toISOString();
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, confirmPassword: string) {
  const user = findStoredUser(userId);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new Error("Current password is incorrect.");
  }
  validatePasswordPair(newPassword, confirmPassword);
  const passwordHash = await hashPassword(newPassword);
  if (sqliteAuthStore) {
    const updated = sqliteAuthStore.applyToUser(userId, (current) => {
      if (current.passwordHash !== user.passwordHash) {
        throw new Error("Current password is incorrect.");
      }
      current.passwordHash = passwordHash;
      current.updatedAt = new Date().toISOString();
    }, { revokeSessions: true });
    if (!updated) throw new Error("User not found.");
    return toPublicUser(updated);
  }
  user.passwordHash = passwordHash;
  user.updatedAt = new Date().toISOString();
  sessions = sessions.filter((session) => session.userId !== user.id);
  await persistUsers();
  await persistSessions();
  return toPublicUser(user);
}

export async function resetPassword(userId: string, password: string, confirmPassword: string) {
  validatePasswordPair(password, confirmPassword);
  const passwordHash = await hashPassword(password);
  if (sqliteAuthStore) {
    const updated = sqliteAuthStore.applyToUser(userId, (current) => {
      current.passwordHash = passwordHash;
      current.updatedAt = new Date().toISOString();
    }, { revokeSessions: true });
    if (!updated) throw new Error("User not found.");
    return toPublicUser(updated);
  }
  const user = findStoredUser(userId);
  user.passwordHash = passwordHash;
  user.updatedAt = new Date().toISOString();
  sessions = sessions.filter((session) => session.userId !== user.id);
  await persistUsers();
  await persistSessions();
  return toPublicUser(user);
}

export function isAdmin(user: User) {
  return user.role === "admin";
}

function validateCreateUser(input: CreateUserInput) {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("Enter a valid email address.");
  assertUniqueEmail(email);

  const username = safeOptionalUsername(input.username);
  assertUniqueUsername(username);

  const displayName = safeDisplayName(input.displayName ?? input.name ?? "");
  validatePasswordPair(input.password, input.password);
  if (input.role && input.role !== "admin" && input.role !== "user") {
    throw new Error("Role must be admin or user.");
  }
  return { email, username, displayName };
}

async function buildStoredUser(input: CreateUserInput): Promise<StoredUser> {
  const normalized = validateCreateUser(input);
  const createdAt = new Date().toISOString();
  return {
    id: input.id ?? `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    email: normalized.email,
    username: normalized.username,
    name: normalized.displayName,
    displayName: normalized.displayName,
    passwordHash: await hashPassword(input.password),
    role: input.role ?? "user",
    active: input.active ?? true,
    avatar: initialsFor(normalized.displayName),
    avatarColor: safeAvatarColor(input.avatarColor),
    profileImageUrl: safeOptionalString(input.profileImageUrl, 250000),
    pinnedProjectIds: sanitizePinnedProjectIds(input.pinnedProjectIds),
    createdAt,
    updatedAt: createdAt,
  };
}

function applyOwnProfileUpdates(
  user: StoredUser,
  updates: Pick<UpdateUserInput, "name" | "displayName" | "avatarColor" | "profileImageUrl">,
) {
  const displayName = safeDisplayName(updates.displayName ?? updates.name ?? user.displayName);
  user.displayName = displayName;
  user.name = displayName;
  user.avatar = initialsFor(displayName);
  if (updates.avatarColor !== undefined) user.avatarColor = safeAvatarColor(updates.avatarColor);
  if (updates.profileImageUrl !== undefined) user.profileImageUrl = safeOptionalString(updates.profileImageUrl, 250000);
  user.updatedAt = new Date().toISOString();
}

function authUsers() {
  return sqliteAuthStore?.loadUsers() ?? users;
}

function findStoredUser(userId: string) {
  const user = sqliteAuthStore?.loadUserById(userId) ?? users.find((item) => item.id === userId);
  if (!user) throw new Error("User not found.");
  return user;
}

function assertUniqueEmail(email: string, exceptUserId?: string) {
  if (authUsers().some((user) => user.email === email && user.id !== exceptUserId)) {
    throw new Error("An account with that email already exists.");
  }
}

function assertUniqueUsername(username: string | undefined, exceptUserId?: string) {
  if (!username) return;
  if (authUsers().some((user) => normalizeUsername(user.username) === username && user.id !== exceptUserId)) {
    throw new Error("An account with that username already exists.");
  }
}

function throwIdentityConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("auth_users.email_norm")) {
    throw new Error("An account with that email already exists.");
  }
  if (message.includes("auth_users.username_norm")) {
    throw new Error("An account with that username already exists.");
  }
  throw error;
}

function validatePasswordPair(password: string, confirmPassword: string) {
  if (password !== confirmPassword) throw new Error("Passwords do not match.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("Password must include at least one letter and one number.");
  }
}

async function hashPassword(password: string) {
  const salt = randomBytes(24).toString("base64url");
  const derived = await scryptPassword(password, salt, passwordHashLength, scryptOptions);
  return [
    passwordHashPrefix,
    String(scryptOptions.N),
    String(scryptOptions.r),
    String(scryptOptions.p),
    salt,
    derived.toString("base64url"),
  ].join("$");
}

async function verifyPassword(password: string, storedHash: string) {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== passwordHashPrefix) return false;
  const [, rawN, rawR, rawP, salt, rawHash] = parts;
  const expected = Buffer.from(rawHash, "base64url");
  const derived = await scryptPassword(password, salt, expected.length, {
    N: Number(rawN),
    r: Number(rawR),
    p: Number(rawP),
    maxmem: 64 * 1024 * 1024,
  }) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function scryptPassword(password: string, salt: string, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function randomToken() {
  return randomBytes(48).toString("base64url");
}

function randomPassword() {
  return `${randomBytes(12).toString("base64url")}A1`;
}

async function ensureDefaultAdmin() {
  if (sqliteAuthStore ? sqliteAuthStore.countUsers() > 0 : users.length > 0) return;

  const production = process.env.NODE_ENV === "production";
  const password = defaultAdminPassword ?? (production ? randomPassword() : devFallbackPassword);
  const storedAdmin = await buildStoredUser({
    id: "usr_momen",
    email: defaultAdminEmail,
    username: "momen",
    name: "momen",
    password,
    role: "admin",
    active: true,
    avatarColor: "#11b8a5",
  });
  if (sqliteAuthStore) {
    if (!sqliteAuthStore.insertFirstUser(storedAdmin)) return;
  } else {
    users = [storedAdmin, ...users];
    await persistUsers();
  }
  const admin = toPublicUser(storedAdmin);

  if (!defaultAdminPassword) {
    if (production) {
      await fs.mkdir(path.dirname(initialAdminPath), { recursive: true });
      await fs.writeFile(
        initialAdminPath,
        [
          "Initial Momi Animation admin account",
          `Email: ${admin.email}`,
          `Password: ${password}`,
          "Set MOMI_ADMIN_PASSWORD and rotate this password after first login.",
          "",
        ].join("\n"),
        "utf8",
      );
      console.warn(`[auth] Created initial admin ${admin.email}. Temporary password written to ${initialAdminPath}`);
    } else {
      console.warn(`[auth] Created development admin ${admin.email} with the local default password.`);
    }
  }
}

function toPublicUser(user: StoredUser): User {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

function normalizeStoredUser(user: StoredUser | Partial<StoredUser>): StoredUser | undefined {
  if (!user || typeof user !== "object" || typeof user.passwordHash !== "string") return undefined;
  const email = normalizeEmail(user.email);
  if (!email) return undefined;
  const displayName = safeDisplayName(user.displayName ?? user.name ?? email.split("@")[0]);
  const createdAt = safeDate(user.createdAt) ?? new Date().toISOString();
  return {
    id: typeof user.id === "string" && user.id.trim() ? user.id : `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    email,
    username: safeOptionalUsername(user.username),
    name: displayName,
    displayName,
    passwordHash: user.passwordHash,
    role: user.role === "admin" ? "admin" : "user",
    active: user.active !== false,
    avatar: user.avatar || initialsFor(displayName),
    avatarColor: safeAvatarColor(user.avatarColor),
    profileImageUrl: safeOptionalString(user.profileImageUrl, 250000),
    pinnedProjectIds: sanitizePinnedProjectIds(user.pinnedProjectIds),
    createdAt,
    updatedAt: safeDate(user.updatedAt) ?? createdAt,
    lastLoginAt: safeDate(user.lastLoginAt),
  };
}

function isUsableSession(session: Partial<SessionRecord>) {
  const expiresAt = safeDate(session.expiresAt);
  return Boolean(
    session &&
      typeof session.id === "string" &&
      typeof session.userId === "string" &&
      typeof session.tokenHash === "string" &&
      expiresAt &&
      new Date(expiresAt).getTime() > Date.now(),
  );
}

function normalizeIdentifier(value: string) {
  return value.trim().toLowerCase();
}

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return "";
  return email;
}

function normalizeUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeOptionalUsername(value: unknown) {
  if (value == null || value === "") return undefined;
  const username = normalizeUsername(value);
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("Username must be 3-64 characters using letters, numbers, dots, dashes, or underscores.");
  }
  return username;
}

function safeDisplayName(value: unknown) {
  const displayName = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (displayName.length < 2 || displayName.length > 80) {
    throw new Error("Display name must be 2-80 characters.");
  }
  return displayName;
}

function safeAvatarColor(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#11b8a5";
}

function safeOptionalString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function sanitizePinnedProjectIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 200) break;
  }
  return ids;
}

function safeDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? value : undefined;
}

function initialsFor(displayName: string) {
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "US";
}

async function persistUsers() {
  await writeJsonFile(usersStorePath, users);
}

async function persistSessions() {
  await writeJsonFile(sessionsStorePath, sessions);
}

async function tryPersistSessions() {
  try {
    await persistSessions();
  } catch {
    // Session timestamp persistence is best-effort so auth reads keep working if the disk is temporarily full.
  }
}
