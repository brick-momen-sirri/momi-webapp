// Sign-in and sign-out. Mounted before the session middleware, for the obvious
// reason. Login is throttled per IP and per identifier before any password work
// happens -- see loginRateLimiter.ts.

import express from "express";
import { extractAuthToken } from "../authMiddleware.js";
import { login, logout } from "../authService.js";
import { loginRateLimitLockoutMs, loginRateLimitMaxAttempts, loginRateLimitWindowMs } from "../config.js";
import { createLoginRateLimiter, loginRateLimitKeys } from "../loginRateLimiter.js";
import { createMediaAccessToken } from "../mediaAccessToken.js";
import { clearSessionCookie, setSessionCookie } from "../sessionCookie.js";

export const authPublicRouter = express.Router();

const loginRateLimiter = createLoginRateLimiter({
  maxAttempts: loginRateLimitMaxAttempts,
  windowMs: loginRateLimitWindowMs,
  lockoutMs: loginRateLimitLockoutMs,
});

authPublicRouter.post("/api/auth/login", async (req, res) => {
  const identifier =
    typeof req.body?.email === "string" ? req.body.email : typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const rateLimitKeys = loginRateLimitKeys(req.ip ?? req.socket.remoteAddress ?? undefined, identifier);

  // Checked before login() so a throttled attempt never reaches scrypt.
  const verdict = loginRateLimiter.check(rateLimitKeys, Date.now());
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    return res.status(429).json({
      error: `Too many failed sign-in attempts. Try again in ${Math.ceil(verdict.retryAfterSeconds / 60)} minute(s).`,
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  try {
    const result = await login(identifier, password);
    loginRateLimiter.recordSuccess(rateLimitKeys);
    setSessionCookie(res, result.token, result.expiresAt);
    // Issued alongside the session so the first render already has a credential
    // for its <img>/<video> URLs -- no gap where media would 401, and no extra
    // round trip.
    res.json({ ...result, mediaAccess: createMediaAccessToken(result.user.id) });
  } catch (error) {
    loginRateLimiter.recordFailure(rateLimitKeys, Date.now());
    res.status(401).json({ error: error instanceof Error ? error.message : "Could not sign in." });
  }
});

authPublicRouter.post("/api/auth/logout", async (req, res) => {
  await logout(extractAuthToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});
