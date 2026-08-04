// The momi_session cookie. HttpOnly + SameSite=Lax, Secure in production.

import express from "express";

export function setSessionCookie(res: express.Response, token: string, expiresAt: string) {
  const maxAgeSeconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `momi_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

export function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", "momi_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
