const AUTH_TOKEN_STORAGE_KEY = "momi_auth_token_v1";

export function getStoredAuthToken() {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? undefined;
}

export function setStoredAuthToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

export function clearStoredAuthToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}
