// The signed-in user's own account: identity, media credential, profile, pinned
// projects, password change.

import express from "express";
import { extractAuthToken, getRequestUser } from "../authMiddleware.js";
import { changePassword, logout, updateOwnProfile, updatePinnedProjects } from "../authService.js";
import { canViewProject } from "../jobPermissions.js";
import { createMediaAccessToken } from "../mediaAccessToken.js";
import { getProjects } from "../projectService.js";
import { clearSessionCookie } from "../sessionCookie.js";

export const authSessionRouter = express.Router();

authSessionRouter.get("/api/auth/me", (req, res) => {
  const user = getRequestUser(req);
  res.json({ user, mediaAccess: createMediaAccessToken(user.id) });
});

// Refresh endpoint for a page that has been open longer than the token TTL. Sits
// behind requireAuth, so refreshing needs the session -- a media token cannot
// renew itself into an unbounded credential.
authSessionRouter.post("/api/media/access-token", (req, res) => {
  res.json({ mediaAccess: createMediaAccessToken(getRequestUser(req).id) });
});

authSessionRouter.patch("/api/auth/me", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const updated = await updateOwnProfile(user.id, {
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      avatarColor: typeof req.body?.avatarColor === "string" ? req.body.avatarColor : undefined,
      profileImageUrl: typeof req.body?.profileImageUrl === "string" ? req.body.profileImageUrl : undefined,
    });
    res.json({ user: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update profile." });
  }
});

authSessionRouter.patch("/api/auth/me/pinned-projects", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const requestedIds: string[] = Array.isArray(req.body?.projectIds)
      ? req.body.projectIds.filter((item: unknown): item is string => typeof item === "string")
      : [];
    const visibleProjectIds = new Set(
      getProjects()
        .filter((project) => canViewProject(user, project))
        .map((project) => project.id),
    );
    const projectIds = requestedIds.filter((projectId) => visibleProjectIds.has(projectId));
    const updated = await updatePinnedProjects(user.id, projectIds);
    res.json({ user: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not save pinned projects." });
  }
});

authSessionRouter.post("/api/auth/change-password", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const updated = await changePassword(
      user.id,
      typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "",
      typeof req.body?.newPassword === "string" ? req.body.newPassword : "",
      typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "",
    );
    await logout(extractAuthToken(req));
    clearSessionCookie(res);
    res.json({ user: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not change password." });
  }
});
