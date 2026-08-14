// Short-lived, media-only bearer tokens for URLs a browser element loads
// directly.
//
// `<img src>` and `<video src>` cannot set an Authorization header, so media URLs
// have to carry their credential in the query string. The old approach put the
// raw 14-day session token there, which meant a full-account credential landed
// in reverse-proxy access logs, browser history, and any Referer sent by a page
// the media was embedded in. Recovering one of those logs was equivalent to
// recovering the account.
//
// These tokens replace it and are deliberately much weaker:
//   * they expire in minutes, not weeks;
//   * they are accepted ONLY on the media read routes (see mediaTokenPaths),
//     so one cannot create a job, spend credits, change a password, or read
//     /api/auth/me;
//   * they establish identity only. The media routes still run their own
//     authorizeMediaRead project check, so a token cannot widen what its owner
//     is allowed to see.
//
// Signed and self-verifying (HMAC-SHA256 over a base64url payload) rather than
// stored, matching runpodInputUrlService: verification is a hash, so the media
// grid does not put a database read in front of every thumbnail. The trade-off
// is that a minted token cannot be revoked before it expires, which is what
// keeps the TTL short.

import { createHmac, timingSafeEqual } from "node:crypto";
import { mediaAccessTokenSecret, mediaAccessTokenTtlMs } from "./config.js";

type MediaTokenPayload = {
  v: 1;
  // The user this token acts as. Deliberately the id, not the session token, so
  // this value is useless anywhere else in the system.
  sub: string;
  exp: number;
};

export type MintedMediaAccessToken = {
  token: string;
  expiresAt: string;
};

// Request paths that will accept a media token in place of a session. Anchored
// and exact: a token must not work on /api/jobs (the list), only on the two
// per-job binary reads, and not on anything under /api/media except the reads.
const mediaTokenPaths = [
  /^\/api\/media$/,
  /^\/api\/media\/thumbnail$/,
  /^\/api\/media\/playable$/,
  /^\/api\/jobs\/[^/]+\/result-(file|media)$/,
];

export function isMediaTokenPath(pathname: string): boolean {
  return mediaTokenPaths.some((pattern) => pattern.test(pathname));
}

export function createMediaAccessToken(userId: string, nowMs = Date.now()): MintedMediaAccessToken {
  const expiresAtMs = nowMs + mediaAccessTokenTtlMs;
  const payload = encodePayload({ v: 1, sub: userId, exp: expiresAtMs });
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function verifyMediaAccessToken(token: string, nowMs = Date.now()): { userId: string } | undefined {
  if (!token) return undefined;
  const [payloadText, signature, ...extra] = token.split(".");
  // Reject anything with a stray extra segment rather than ignoring the tail:
  // a JWT-shaped `header.payload.signature` must not be silently accepted.
  if (!payloadText || !signature || extra.length) return undefined;
  if (!signaturesMatch(signature, sign(payloadText))) return undefined;

  const payload = decodePayload(payloadText);
  if (!payload) return undefined;
  if (payload.v !== 1) return undefined;
  if (!payload.sub) return undefined;
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) return undefined;

  return { userId: payload.sub };
}

function encodePayload(payload: MediaTokenPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(payloadText: string): MediaTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as MediaTokenPayload;
  } catch {
    return undefined;
  }
}

function sign(payloadText: string) {
  return createHmac("sha256", mediaAccessTokenSecret).update(payloadText).digest("base64url");
}

function signaturesMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
