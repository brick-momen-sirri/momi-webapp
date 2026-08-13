import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getAuthenticatedUser, getUserById, isAdmin } from "./authService.js";
import { isMediaTokenPath, verifyMediaAccessToken } from "./mediaAccessToken.js";
import { MEDIA_COOKIE } from "./sessionCookie.js";
import type { User } from "./types.js";

export type AuthenticatedRequest = Request & {
  authUser?: User;
  authToken?: string;
  // Set when the caller authenticated with a media access token rather than a
  // session. Routes that want to refuse those can check it; today none need to,
  // because the token is only accepted on media read paths in the first place.
  authViaMediaToken?: boolean;
};

/**
 * Accepts a short-lived media access token from `?access_token=`, but ONLY on the
 * media read paths, and resolves it to a user so the normal requireAuth below
 * passes the request through.
 *
 * This exists because <img src>/<video src> cannot send an Authorization header.
 * It used to be the session token in that query parameter, which put a 14-day
 * full-account credential into access logs and Referer headers. See
 * mediaAccessToken.ts for what replaced it and why.
 *
 * Runs before requireAuth and never rejects: an absent, malformed, or expired
 * token simply leaves the request unauthenticated, and requireAuth produces the
 * usual 401. A session presented the normal way always takes precedence.
 */
export const resolveMediaAccessToken: RequestHandler = async (req, res, next) => {
  try {
    if ((req as AuthenticatedRequest).authUser) return next();
    if (!isMediaTokenPath(req.path)) return next();

    const raw = req.query.access_token;
    // The cookie is the normal carrier; the query parameter stays supported so
    // URLs minted before the cookie existed, and any client that cannot rely on
    // cookies, keep working.
    const token = (typeof raw === "string" ? raw.trim() : "") || readCookie(req, MEDIA_COOKIE) || "";
    if (!token) return next();

    const verified = verifyMediaAccessToken(token);
    if (!verified) return next();

    // The token proves who minted it; it does not prove they are still allowed
    // in. A deactivated or deleted account must stop working immediately rather
    // than at the token's expiry.
    const user = getUserById(verified.userId);
    if (!user || user.active === false) return next();

    (req as AuthenticatedRequest).authUser = user;
    (req as AuthenticatedRequest).authViaMediaToken = true;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    // Already resolved upstream (media access token).
    if ((req as AuthenticatedRequest).authUser) return next();

    const token = extractAuthToken(req);
    const user = await getAuthenticatedUser(token);

    if (!token || !user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    (req as AuthenticatedRequest).authUser = user;
    (req as AuthenticatedRequest).authToken = token;
    next();
  } catch (error) {
    next(error);
  }
};

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = getRequestUser(req);
  if (!isAdmin(user)) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

export function getRequestUser(req: Request) {
  const user = (req as AuthenticatedRequest).authUser;
  if (!user) {
    throw new Error("Authenticated user missing from request.");
  }
  return user;
}

/**
 * Session token, from the Authorization header or the momi_session cookie.
 *
 * Deliberately does NOT read the query string. Session tokens are long-lived
 * full-account credentials and must never end up in a URL, where they would be
 * captured by access logs, browser history, and Referer headers. Media URLs use
 * resolveMediaAccessToken above instead.
 */
export function extractAuthToken(req: Request) {
  const header = req.header("authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  return readCookie(req, "momi_session");
}

function readCookie(req: Request, name: string) {
  const cookieHeader = req.header("cookie") ?? "";
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(cookie.slice(separator + 1).trim());
  }

  return undefined;
}
