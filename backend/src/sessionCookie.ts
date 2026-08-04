// The momi_session cookie. HttpOnly + SameSite=Lax, Secure in production.

import express from "express";

export function setSessionCookie(res: express.Response, token: string, expiresAt: string) {
  // Math.max(1, NaN) is NaN, not 1, so the floor below does not protect against an
  // unparseable expiry on its own -- it would emit `Max-Age=NaN`, which browsers
  // ignore, silently downgrading the session to last only until the tab closes.
  const remainingSeconds = (new Date(expiresAt).getTime() - Date.now()) / 1000;
  const maxAgeSeconds = Number.isFinite(remainingSeconds) ? Math.max(1, Math.floor(remainingSeconds)) : 1;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `momi_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

export function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", "momi_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
