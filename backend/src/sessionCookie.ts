// The momi_session and momi_media cookies.

import express from "express";

const SESSION_COOKIE = "momi_session";
export const MEDIA_COOKIE = "momi_media";

export function setSessionCookie(res: express.Response, token: string, expiresAt: string) {
  appendCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`, maxAgeFrom(expiresAt));
}

/**
 * The media access token, as a cookie, so media URLs do not have to carry it.
 *
 * `<img src>` cannot set an Authorization header, which is why this token exists
 * at all (see mediaAccessToken.ts). Putting it in the query string works, but the
 * token rotates every few minutes and the URL is the browser's cache key -- so
 * every rotation silently invalidated the cache for every thumbnail on the page.
 * In a cookie the URL stays fixed for the life of the result and the HTTP cache
 * actually does its job.
 *
 * Deliberately NOT HttpOnly, unlike the session cookie. The frontend has to know
 * whether this cookie really exists before it stops putting the token in URLs;
 * guessing and being wrong would break every image. This is not a meaningful
 * downgrade: the token is media-read-only, expires in minutes, and was already
 * readable by any script on the page back when it sat in the URLs.
 */
export function setMediaAccessCookie(res: express.Response, token: string, expiresAt: string) {
  appendCookie(res, `${MEDIA_COOKIE}=${encodeURIComponent(token)}; SameSite=Lax; Path=/`, maxAgeFrom(expiresAt));
}

export function clearSessionCookie(res: express.Response) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.append("Set-Cookie", `${MEDIA_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`);
}

// Appended rather than set: a response that issues both cookies would otherwise
// have the second setHeader silently discard the first.
function appendCookie(res: express.Response, attributes: string, maxAgeSeconds: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append("Set-Cookie", `${attributes}; Max-Age=${maxAgeSeconds}${secure}`);
}

// Math.max(1, NaN) is NaN, not 1, so the floor below does not protect against an
// unparseable expiry on its own -- it would emit `Max-Age=NaN`, which browsers
// ignore, silently downgrading the cookie to last only until the tab closes.
function maxAgeFrom(expiresAt: string) {
  const remainingSeconds = (new Date(expiresAt).getTime() - Date.now()) / 1000;
  return Number.isFinite(remainingSeconds) ? Math.max(1, Math.floor(remainingSeconds)) : 1;
}
