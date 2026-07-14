import type { User } from "../types";
import { createClientId } from "./id";

const ACCOUNTS_KEY = "momi.brickvisual.accounts";
const SESSION_KEY = "momi.brickvisual.session";
const BRICK_DOMAIN = "@brickvisual.com";

export type LocalAccount = {
  id: string;
  name: string;
  email: string;
  avatar: string;
  avatarColor: string;
  profileImageUrl?: string;
  passwordHash: string;
  salt: string;
  creditsRemaining: number;
  createdAt: string;
  updatedAt: string;
  lastSignedInAt?: string;
};

export type AuthResult =
  | { ok: true; account: LocalAccount }
  | { ok: false; error: string };

const seedPassword = "Brickvisual2026!";
const avatarColors = ["#11b8a5", "#ff6b35", "#4f46e5", "#0f766e"];
const defaultSeedUsers: User[] = [
  { id: "usr_momen", name: "momen", email: "momen@brickvisual.com", avatar: "MO", avatarColor: "#11b8a5" },
  { id: "usr_lina", name: "Lina", email: "lina@brickvisual.com", avatar: "LI", avatarColor: "#ff6b35" },
  { id: "usr_sami", name: "Sami", email: "sami@brickvisual.com", avatar: "SA", avatarColor: "#4f46e5" },
  { id: "usr_nora", name: "Nora", email: "nora@brickvisual.com", avatar: "NO", avatarColor: "#0f766e" },
];

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isBrickEmail(email: string) {
  return normalizeEmail(email).endsWith(BRICK_DOMAIN);
}

export function getStoredSessionId() {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setStoredSession(accountId: string) {
  try {
    window.localStorage.setItem(SESSION_KEY, accountId);
  } catch {
    // Ignore local storage write failures so auth UI can still recover.
  }
}

export function clearStoredSession() {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore local storage write failures so auth UI can still recover.
  }
}

export function getStoredAccounts(): LocalAccount[] {
  try {
    const raw = window.localStorage.getItem(ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) as LocalAccount[] : [];
  } catch {
    return [];
  }
}

export function getAccountById(accountId: string) {
  return getStoredAccounts().find((account) => account.id === accountId) ?? null;
}

export function accountToUser(account: LocalAccount): User {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    avatar: account.avatar,
    avatarColor: account.avatarColor,
    profileImageUrl: account.profileImageUrl,
  };
}

export async function ensureSeedAccounts(users: User[]) {
  const accounts = getStoredAccounts();
  const existingEmails = new Set(accounts.map((account) => normalizeEmail(account.email)));
  const now = new Date().toISOString();
  const seeded: LocalAccount[] = [];

  for (const [index, user] of users.entries()) {
    const email = normalizeEmail(user.email ?? `${user.name.toLowerCase().replace(/[^a-z0-9]/g, ".")}${BRICK_DOMAIN}`);

    if (existingEmails.has(email)) {
      continue;
    }

    const salt = createSalt();
    seeded.push({
      id: user.id,
      name: user.name,
      email,
      avatar: user.avatar ?? initials(user.name),
      avatarColor: user.avatarColor ?? avatarColors[index % avatarColors.length],
      passwordHash: await hashPassword(seedPassword, salt),
      salt,
      creditsRemaining: user.id === "usr_momen" ? 16 : 40,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (seeded.length) {
    saveAccounts([...accounts, ...seeded]);
  }
}

export async function signInLocal(email: string, password: string): Promise<AuthResult> {
  const normalizedEmail = normalizeEmail(email);

  if (!isBrickEmail(normalizedEmail)) {
    return { ok: false, error: "Use your @brickvisual.com email address." };
  }

  await ensureSeedAccounts(defaultSeedUsers);
  const accounts = getStoredAccounts();
  const account = accounts.find((item) => item.email === normalizedEmail);

  if (!account) {
    return { ok: false, error: "No local account exists for this email." };
  }

  const passwordHash = await hashPassword(password, account.salt);

  if (passwordHash !== account.passwordHash) {
    return { ok: false, error: "The password is incorrect." };
  }

  const updatedAccount = { ...account, lastSignedInAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveAccount(updatedAccount);
  setStoredSession(updatedAccount.id);
  return { ok: true, account: updatedAccount };
}

export async function signUpLocal(params: {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}): Promise<AuthResult> {
  const name = params.name.trim();
  const email = normalizeEmail(params.email);

  if (!name) {
    return { ok: false, error: "Add your name." };
  }

  if (!isBrickEmail(email)) {
    return { ok: false, error: "New accounts must use @brickvisual.com email." };
  }

  if (params.password.length < 8) {
    return { ok: false, error: "Use at least 8 characters for the password." };
  }

  if (params.password !== params.confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  const accounts = getStoredAccounts();

  if (accounts.some((account) => account.email === email)) {
    return { ok: false, error: "A local account already exists for this email." };
  }

  const salt = createSalt();
  const now = new Date().toISOString();
  const account: LocalAccount = {
    id: createClientId("usr_").slice(0, 16),
    name,
    email,
    avatar: initials(name),
    avatarColor: avatarColors[accounts.length % avatarColors.length],
    passwordHash: await hashPassword(params.password, salt),
    salt,
    creditsRemaining: 40,
    createdAt: now,
    updatedAt: now,
    lastSignedInAt: now,
  };

  saveAccounts([...accounts, account]);
  setStoredSession(account.id);
  return { ok: true, account };
}

export async function updateLocalProfile(
  accountId: string,
  updates: Pick<LocalAccount, "name" | "avatarColor"> & { profileImageUrl?: string },
): Promise<AuthResult> {
  const account = getAccountById(accountId);

  if (!account) {
    return { ok: false, error: "Account not found." };
  }

  const name = updates.name.trim();

  if (!name) {
    return { ok: false, error: "Name cannot be empty." };
  }

  const updatedAccount: LocalAccount = {
    ...account,
    name,
    avatar: initials(name),
    avatarColor: updates.avatarColor,
    profileImageUrl: updates.profileImageUrl,
    updatedAt: new Date().toISOString(),
  };

  saveAccount(updatedAccount);
  return { ok: true, account: updatedAccount };
}

export async function changeLocalPassword(
  accountId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): Promise<AuthResult> {
  const account = getAccountById(accountId);

  if (!account) {
    return { ok: false, error: "Account not found." };
  }

  if (newPassword.length < 8) {
    return { ok: false, error: "Use at least 8 characters for the new password." };
  }

  if (newPassword !== confirmPassword) {
    return { ok: false, error: "New passwords do not match." };
  }

  const currentHash = await hashPassword(currentPassword, account.salt);

  if (currentHash !== account.passwordHash) {
    return { ok: false, error: "Current password is incorrect." };
  }

  const salt = createSalt();
  const updatedAccount = {
    ...account,
    salt,
    passwordHash: await hashPassword(newPassword, salt),
    updatedAt: new Date().toISOString(),
  };

  saveAccount(updatedAccount);
  return { ok: true, account: updatedAccount };
}

export function updateLocalCredits(accountId: string, creditsRemaining: number) {
  const account = getAccountById(accountId);

  if (!account) {
    return null;
  }

  const updatedAccount = {
    ...account,
    creditsRemaining,
    updatedAt: new Date().toISOString(),
  };
  saveAccount(updatedAccount);
  return updatedAccount;
}

function saveAccount(account: LocalAccount) {
  saveAccounts(getStoredAccounts().map((item) => (item.id === account.id ? account : item)));
}

function saveAccounts(accounts: LocalAccount[]) {
  try {
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    // The app should remain usable even when browser storage is full or blocked.
  }
}

async function hashPassword(password: string, salt: string) {
  const payload = new TextEncoder().encode(`${salt}:${password}`);
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", payload);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  return fallbackHash(`${salt}:${password}`);
}

function createSalt() {
  const bytes = new Uint8Array(16);
  if (crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fallbackHash(value: string) {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);

  return `fallback:${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "BV";
}
