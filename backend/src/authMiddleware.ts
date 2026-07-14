import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getAuthenticatedUser, isAdmin } from "./authService.js";
import type { User } from "./types.js";

export type AuthenticatedRequest = Request & {
  authUser?: User;
  authToken?: string;
};

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
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

export function extractAuthToken(req: Request) {
  const queryToken = req.query.access_token;
  if (typeof queryToken === "string" && queryToken.trim()) {
    return queryToken.trim();
  }

  const header = req.header("authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const cookieHeader = req.header("cookie") ?? "";
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    const name = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();
    if (name === "momi_session") {
      return decodeURIComponent(value);
    }
  }

  return undefined;
}
