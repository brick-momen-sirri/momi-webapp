import { clearStoredAuthToken, setStoredAuthToken } from "./authToken";
import { apiRequest } from "./client";
import { clearMediaAccessToken, storeMediaAccess, type MediaAccess } from "./mediaAccess";
import { mapUser } from "./mappers";
import type { AuthResult, AuthUser } from "./types";

export async function signInBackend(email: string, password: string): Promise<AuthResult> {
  try {
    const data = await apiRequest<{ token: string; user: AuthUser; mediaAccess?: MediaAccess }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setStoredAuthToken(data.token);
    storeMediaAccess(data.mediaAccess);
    return { ok: true, account: mapUser(data.user), token: data.token };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not sign in." };
  }
}

export async function fetchCurrentAccount() {
  const data = await apiRequest<{ user: AuthUser; mediaAccess?: MediaAccess }>("/api/auth/me");
  storeMediaAccess(data.mediaAccess);
  return mapUser(data.user);
}

export async function logoutBackend() {
  try {
    await apiRequest<{ ok: true }>("/api/auth/logout", { method: "POST" });
  } finally {
    clearStoredAuthToken();
    clearMediaAccessToken();
  }
}

export async function updateBackendProfile(
  updates: Pick<AuthUser, "name" | "avatarColor"> & { profileImageUrl?: string },
): Promise<AuthResult> {
  try {
    const data = await apiRequest<{ user: AuthUser }>("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, displayName: updates.name }),
    });
    return { ok: true, account: mapUser(data.user) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save profile." };
  }
}

export async function updateBackendPinnedProjects(projectIds: string[]): Promise<AuthResult> {
  try {
    const data = await apiRequest<{ user: AuthUser }>("/api/auth/me/pinned-projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds }),
    });
    return { ok: true, account: mapUser(data.user) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save pinned projects." };
  }
}

export async function changeBackendPassword(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): Promise<AuthResult> {
  try {
    const data = await apiRequest<{ user: AuthUser }>("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    });
    clearStoredAuthToken();
    return { ok: true, account: mapUser(data.user) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not change password." };
  }
}

export async function fetchBackendUsers() {
  const data = await apiRequest<{ users: AuthUser[] }>("/api/users");
  return data.users.map(mapUser);
}

export async function createBackendUser(payload: {
  name: string;
  email: string;
  username?: string;
  password: string;
  role: "admin" | "user";
  active?: boolean;
}) {
  const data = await apiRequest<{ user: AuthUser }>("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, displayName: payload.name }),
  });
  return mapUser(data.user);
}

export async function updateBackendUser(
  userId: string,
  payload: Partial<Pick<AuthUser, "name" | "email" | "role" | "active" | "avatarColor">>,
) {
  const data = await apiRequest<{ user: AuthUser }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, displayName: payload.name }),
  });
  return mapUser(data.user);
}

export async function resetBackendUserPassword(userId: string, password: string, confirmPassword: string) {
  const data = await apiRequest<{ user: AuthUser }>(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, confirmPassword }),
  });
  return mapUser(data.user);
}

export async function setBackendUserActive(userId: string, active: boolean) {
  const suffix = active ? "enable" : "disable";
  const data = await apiRequest<{ user: AuthUser }>(`/api/users/${encodeURIComponent(userId)}/${suffix}`, { method: "POST" });
  return mapUser(data.user);
}
