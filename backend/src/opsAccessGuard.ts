// Access control for the ops surface: /metrics, /ops-dashboard, /api/health,
// /api/ops-config, /api/alerts/recent and /api/backup-status.
//
// Those routes are registered above `app.use(requireAuth)` on purpose -- a
// Prometheus scraper has no session, and the dashboard's first paint happens
// before any login. That left them readable by anyone who could reach the port,
// while they report queue depth, RunPod capacity, process RSS, free disk and
// backup freshness. This guard closes that without giving the scraper a session:
//
//   * loopback callers are trusted (local scrapers, the topology load test,
//     an operator on the box) -- controlled by OPS_ALLOW_LOOPBACK;
//   * anyone else must present OPS_ACCESS_TOKEN.
//
// Default is empty token + trusted loopback, which behaves like binding the ops
// surface to localhost. Note that a same-host reverse proxy or tunnel also
// arrives from 127.0.0.1: deployments fronted that way must set a token and
// OPS_ALLOW_LOOPBACK=false, or restrict these paths at the proxy.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { opsAccessToken, opsAllowLoopback } from "./config.js";

export type OpsAccessInput = {
  remoteAddress?: string;
  presentedToken?: string;
  configuredToken: string;
  allowLoopback: boolean;
};

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4 peers on a dual-stack socket as ::ffff:127.0.0.1, and
  // remoteAddress can carry a zone id (fe80::1%eth0).
  const host = address
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/%.*$/, "")
    .replace(/^::ffff:/, "");
  if (host === "::1") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

// Compared over digests so a length difference does not leak through
// timingSafeEqual's own length check.
export function tokensMatch(presented: string | undefined, configured: string): boolean {
  if (!configured || !presented) return false;
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(configured).digest();
  return timingSafeEqual(left, right);
}

export function decideOpsAccess(input: OpsAccessInput): { allowed: boolean; reason: string } {
  if (tokensMatch(input.presentedToken, input.configuredToken)) {
    return { allowed: true, reason: "token" };
  }
  if (input.allowLoopback && isLoopbackAddress(input.remoteAddress)) {
    return { allowed: true, reason: "loopback" };
  }
  if (!input.configuredToken) {
    return { allowed: false, reason: "ops endpoints are local-only; set OPS_ACCESS_TOKEN to allow remote access" };
  }
  return { allowed: false, reason: "a valid ops access token is required" };
}

export function extractOpsToken(req: Request): string | undefined {
  const bearer = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const headerToken = req.header("x-ops-token")?.trim();
  if (headerToken) return headerToken;
  // Query form exists so a browser can open /ops-dashboard?token=... and so
  // scrapers that cannot set headers can still authenticate.
  const queryToken = req.query.token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  return undefined;
}

export const requireOpsAccess: RequestHandler = (req, res, next) => {
  const decision = decideOpsAccess({
    remoteAddress: req.ip ?? req.socket.remoteAddress ?? undefined,
    presentedToken: extractOpsToken(req),
    configuredToken: opsAccessToken,
    allowLoopback: opsAllowLoopback,
  });

  if (!decision.allowed) {
    return res.status(403).json({ error: `Forbidden: ${decision.reason}.` });
  }
  next();
};
