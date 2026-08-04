// User administration. Every mutating route is admin-only.

import express from "express";
import { getRequestUser, requireAdmin } from "../authMiddleware.js";
import { createUser, listUsers, resetPassword, updateUser } from "../authService.js";

export const userRouter = express.Router();

userRouter.get("/api/users", (req, res) => {
  const currentUser = getRequestUser(req);
  res.json({ users: listUsers({ includeDisabled: currentUser.role === "admin" }) });
});

userRouter.post("/api/users", requireAdmin, async (req, res) => {
  try {
    const user = await createUser({
      email: typeof req.body?.email === "string" ? req.body.email : "",
      username: typeof req.body?.username === "string" ? req.body.username : undefined,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      password: typeof req.body?.password === "string" ? req.body.password : "",
      role: req.body?.role === "admin" ? "admin" : "user",
      active: req.body?.active !== false,
      avatarColor: typeof req.body?.avatarColor === "string" ? req.body.avatarColor : undefined,
    });
    res.status(201).json({ user });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create user." });
  }
});

userRouter.patch("/api/users/:userId", requireAdmin, async (req, res) => {
  try {
    const currentUser = getRequestUser(req);
    if (currentUser.id === req.params.userId && (req.body?.active === false || req.body?.role === "user")) {
      return res.status(400).json({ error: "You cannot disable or demote your own admin account." });
    }
    const user = await updateUser(req.params.userId, {
      email: typeof req.body?.email === "string" ? req.body.email : undefined,
      username: typeof req.body?.username === "string" ? req.body.username : undefined,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      role: req.body?.role === "admin" || req.body?.role === "user" ? req.body.role : undefined,
      active: typeof req.body?.active === "boolean" ? req.body.active : undefined,
      avatarColor: typeof req.body?.avatarColor === "string" ? req.body.avatarColor : undefined,
      profileImageUrl: typeof req.body?.profileImageUrl === "string" ? req.body.profileImageUrl : undefined,
    });
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update user." });
  }
});

userRouter.post("/api/users/:userId/reset-password", requireAdmin, async (req, res) => {
  try {
    const user = await resetPassword(
      req.params.userId,
      typeof req.body?.password === "string" ? req.body.password : "",
      typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "",
    );
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not reset password." });
  }
});

userRouter.post("/api/users/:userId/enable", requireAdmin, async (req, res) => {
  try {
    res.json({ user: await updateUser(req.params.userId, { active: true }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not enable user." });
  }
});

userRouter.post("/api/users/:userId/disable", requireAdmin, async (req, res) => {
  try {
    const currentUser = getRequestUser(req);
    if (currentUser.id === req.params.userId) {
      return res.status(400).json({ error: "You cannot disable your own account." });
    }
    res.json({ user: await updateUser(req.params.userId, { active: false }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not disable user." });
  }
});
