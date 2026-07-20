import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  brickProjectsRoot,
  comfyRoot,
  generationBackend,
  HOST,
  jsonBodyLimit,
  localComfyEnabled,
  localProjectsRoot,
  mediaUploadMaxBytes,
  memoryLogIntervalMs,
  PORT,
  runpodPollIntervalMs,
  runpodTimeoutMs,
  uploadedMediaRoot,
  validateRuntimeConfigForStartup,
} from "./config.js";
import {
  changePassword,
  createUser,
  getUserById,
  listUsers,
  loadAuthData,
  login,
  logout,
  resetPassword,
  updatePinnedProjects,
  updateOwnProfile,
  updateUser,
} from "./authService.js";
import { extractAuthToken, getRequestUser, requireAdmin, requireAuth } from "./authMiddleware.js";
import { readWindowsClipboardImage } from "./clipboardService.js";
import { getServers, refreshServers, runComfyPoolAction, type ComfyPoolAction } from "./comfyPool.js";
import { getCredits } from "./creditService.js";
import { creditAccountingSource, creditsSpentForAccounting, isCountedCreditUsage } from "./creditUsageAccounting.js";
import { getCreditTrackerProjectStats, type CreditTrackerProjectStats } from "./creditUsageService.js";
import {
  archiveJob,
  cancelJob,
  createJob,
  getJob,
  getJobFromAnySource,
  getJobs,
  getJobsWithExistingMedia,
  loadJobs,
  moveJobResult,
  permanentlyDeleteArchivedJob,
  renameJob,
  restoreArchivedJob,
  updateJobSaveNumber,
} from "./jobQueue.js";
import {
  addProjectMember,
  createProjectFolder,
  createProject,
  deleteProjectFolder,
  getProject,
  getProjects,
  listProjectFolders,
  loadProjects,
  removeProjectMember,
  renameProject,
  renameProjectFolder,
  updateProject,
} from "./projectService.js";
import { getPodStatus } from "./podStatusService.js";
import { httpErrorCode, httpStatusFromError } from "./httpError.js";
import { resolveRunpodInputToken } from "./runpodInputUrlService.js";
import { describeImageWithRunpod } from "./runpodService.js";
import { runKlingPromptWorkflow } from "./klingPromptWorkflowService.js";
import { runSeedancePromptWorkflow } from "./seedancePromptWorkflowService.js";
import type { Job, Project, User } from "./types.js";
import { getWorkflowModel, getWorkflowModels, loadWorkflowModels } from "./workflowService.js";
import { estimateWorkflowCredits } from "./creditEstimator.js";
import { assertMetadataHealth } from "./metadataHealthService.js";
import { logMemory, startMemoryLogging } from "./memoryLogger.js";
import { safeSegment } from "./storageService.js";
import { writeStreamAtomically } from "./streamingMediaService.js";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: jsonBodyLimit }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "momi-animation-backend", time: new Date().toISOString() });
});

app.get("/api/runpod-input", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const input = resolveRunpodInputToken(token);
  if (!input) {
    return res.status(403).json({ error: "Invalid or expired RunPod input link." });
  }

  try {
    await fs.access(input.filePath);
    await streamLocalFile(req, res, input.filePath, {
      cacheControl: "no-store",
      contentType: contentTypeFromFilePath(input.filePath),
      disposition: `inline; filename="${safeHeaderFileName(path.basename(input.filePath))}"`,
    });
  } catch {
    res.status(404).json({ error: "RunPod input file not found." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const identifier = typeof req.body?.email === "string" ? req.body.email : typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const result = await login(identifier, password);
    setSessionCookie(res, result.token, result.expiresAt);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "Could not sign in." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  await logout(extractAuthToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use(requireAuth);

app.get("/api/auth/me", (req, res) => {
  res.json({ user: getRequestUser(req) });
});

app.get("/api/runtime", (_req, res) => {
  res.json({
    generationBackend,
    localComfyEnabled,
    runpodConfigured: Boolean(process.env.RUNPOD_ENDPOINT_ID && process.env.RUNPOD_API_KEY && process.env.COMFY_ORG_API_KEY),
    runpodPollIntervalMs,
    runpodTimeoutMs,
  });
});

app.get("/api/pods/status", async (_req, res) => {
  try {
    res.json({ status: await getPodStatus() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read pod status." });
  }
});

app.get("/api/clipboard/image", async (_req, res) => {
  try {
    const image = await readWindowsClipboardImage();
    if (!image) {
      return res.status(404).json({ error: "No image found on the Windows clipboard." });
    }

    res.json({ image });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read the Windows clipboard." });
  }
});

app.patch("/api/auth/me", async (req, res) => {
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

app.patch("/api/auth/me/pinned-projects", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const requestedIds: string[] = Array.isArray(req.body?.projectIds)
      ? req.body.projectIds.filter((item: unknown): item is string => typeof item === "string")
      : [];
    const visibleProjectIds = new Set(getProjects().filter((project) => canViewProject(user, project)).map((project) => project.id));
    const projectIds = requestedIds.filter((projectId) => visibleProjectIds.has(projectId));
    const updated = await updatePinnedProjects(user.id, projectIds);
    res.json({ user: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not save pinned projects." });
  }
});

app.post("/api/auth/change-password", async (req, res) => {
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

app.get("/api/users", (req, res) => {
  const currentUser = getRequestUser(req);
  res.json({ users: listUsers({ includeDisabled: currentUser.role === "admin" }) });
});

app.post("/api/users", requireAdmin, async (req, res) => {
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

app.patch("/api/users/:userId", requireAdmin, async (req, res) => {
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

app.post("/api/users/:userId/reset-password", requireAdmin, async (req, res) => {
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

app.post("/api/users/:userId/enable", requireAdmin, async (req, res) => {
  try {
    res.json({ user: await updateUser(req.params.userId, { active: true }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not enable user." });
  }
});

app.post("/api/users/:userId/disable", requireAdmin, async (req, res) => {
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

app.get("/api/comfy/servers", async (_req, res) => {
  if (!localComfyEnabled) {
    return res.json({ servers: [] });
  }
  await refreshServers();
  res.json({ servers: getServers() });
});

app.post("/api/comfy/action", requireAdmin, async (req, res) => {
  try {
    if (!localComfyEnabled) {
      return res.status(400).json({ error: "Local ComfyUI pool controls are disabled. Set GENERATION_BACKEND=local_comfy for local development." });
    }
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    const port = Number(req.body?.port);
    const result = await runComfyPoolAction({
      action: action as ComfyPoolAction,
      port: Number.isFinite(port) ? port : undefined,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not manage the Comfy pool." });
  }
});

app.get("/api/models", (_req, res) => {
  res.json({ models: getWorkflowModels() });
});

app.get("/api/projects", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const visibleProjects = getProjects().filter((project) => canViewProject(user, project));
    const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
    const jobs = filterJobsForUser(await getJobsWithExistingMedia(), user);
    const { startAt, endAt } = currentMonthRange();
    const jobStatsByProjectId = new Map<string, { jobCount: number; creditsUsed: number; monthCreditsUsed: number }>();
    const trackerStatsByProjectName = await getCreditTrackerProjectStats();

    for (const job of jobs) {
      if (!visibleProjectIds.has(job.projectId)) continue;
      const stats = jobStatsByProjectId.get(job.projectId) ?? { jobCount: 0, creditsUsed: 0, monthCreditsUsed: 0 };
      const creditsUsed = creditsSpentForJob(job);
      const createdAt = new Date(job.completedAt ?? job.createdAt).getTime();

      stats.jobCount += 1;
      stats.creditsUsed = roundCredits(stats.creditsUsed + creditsUsed);

      if (creditsUsed && Number.isFinite(createdAt) && createdAt >= startAt.getTime() && createdAt < endAt.getTime()) {
        stats.monthCreditsUsed = roundCredits(stats.monthCreditsUsed + creditsUsed);
      }

      jobStatsByProjectId.set(job.projectId, stats);
    }

    res.json({
      projects: visibleProjects.map((project) => {
        const jobStats = jobStatsByProjectId.get(project.id);
        const trackerStats = findCreditTrackerProjectStats(project, trackerStatsByProjectName);
        return {
          ...project,
          jobCount: jobStats?.jobCount ?? 0,
          creditsUsed: jobStats?.creditsUsed ?? trackerStats?.creditsUsed ?? 0,
          monthCreditsUsed: jobStats?.monthCreditsUsed ?? trackerStats?.monthCreditsUsed ?? 0,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not scan project counts" });
  }
});

app.get("/api/projects/:projectId", (req, res) => {
  const user = getRequestUser(req);
  const project = getProject(req.params.projectId);
  if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
  res.json({ project });
});

app.get("/api/projects/:projectId/folders", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const folders = await listProjectFolders(project.id);
    if (!folders) return res.status(404).json({ error: "Project not found" });
    res.json({ folders });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read project folders." });
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = await createProject({
      ...(req.body ?? {}),
      ownerId: user.id,
      members: [{ userId: user.id, role: "owner", addedAt: new Date().toISOString(), addedBy: user.id }],
    });
    res.status(201).json({ project });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create project." });
  }
});

app.patch("/api/projects/:projectId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canManageProject(user, project)) return res.status(403).json({ error: "Project owner access required." });
    if (projectCodeChangeRequested(req.body, project)) return res.status(400).json({ error: "Project code cannot be changed." });
    if (projectRenameRequested(req.body, project)) {
      if (user.role !== "admin") return res.status(403).json({ error: "Admin permission required" });
      const renamed = await renameProject(project.id, {
        client: typeof req.body?.client === "string" ? req.body.client : undefined,
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
      }, user.id);
      if (!renamed) return res.status(404).json({ error: "Project not found" });
    }

    const updated = await updateProject(project.id, {
      description: typeof req.body?.description === "string" ? req.body.description : undefined,
      members: Array.isArray(req.body?.members) ? req.body.members : undefined,
      groupMembers: Array.isArray(req.body?.groupMembers) ? req.body.groupMembers : undefined,
    });
    if (!updated) return res.status(404).json({ error: "Project not found" });
    res.json({ project: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update project." });
  }
});

app.post("/api/projects/:projectId/folders", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const folder = await createProjectFolder(project.id, {
      name: typeof req.body?.name === "string" ? req.body.name : "",
      parentId: typeof req.body?.parentId === "string" ? req.body.parentId : null,
    }, user.id);
    if (!folder) return res.status(404).json({ error: "Project not found" });
    res.status(201).json({ folder, project: getProject(project.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create project folder." });
  }
});

app.patch("/api/projects/:projectId/folders/:folderId", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const folder = await renameProjectFolder(project.id, req.params.folderId, {
      name: typeof req.body?.name === "string" ? req.body.name : "",
    }, user.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });
    res.json({ folder, project: getProject(project.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not rename project folder." });
  }
});

app.delete("/api/projects/:projectId/folders/:folderId", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const folder = await deleteProjectFolder(project.id, req.params.folderId, user.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });
    res.json({ folder, project: getProject(project.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete project folder." });
  }
});

app.patch("/api/projects/:projectId/jobs/:jobId", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const job = await renameJob(
      project.id,
      req.params.jobId,
      typeof req.body?.title === "string" ? req.body.title : "",
      user.id,
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not rename job." });
  }
});

app.patch("/api/projects/:projectId/jobs/:jobId/save-number", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const job = await updateJobSaveNumber(
      project.id,
      req.params.jobId,
      req.body?.saveNumber ?? req.body?.value ?? "",
      user.id,
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update shot/camera number." });
  }
});

app.patch("/api/projects/:projectId/jobs/:jobId/folder", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });

    const existing = getJob(req.params.jobId);
    if (!existing || existing.projectId !== project.id || !canAccessJob(user, existing)) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!canManageJob(user, existing)) {
      return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    }

    const requestedFolderId = req.body?.destinationFolderId;
    if (requestedFolderId !== null && typeof requestedFolderId !== "string") {
      return res.status(400).json({ error: "Destination folder must be a folder ID or null for the project root." });
    }
    const destinationFolderId = typeof requestedFolderId === "string" && requestedFolderId.trim()
      ? requestedFolderId.trim()
      : null;
    const job = await moveJobResult(project.id, existing.id, destinationFolderId, user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not move result.";
    const status = /missing|already exists|not found|only completed|restore this result/i.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

app.post("/api/projects/:projectId/members", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canManageProject(user, project)) return res.status(403).json({ error: "Project owner access required." });

    const updated = await addProjectMember(req.params.projectId, {
      userId: typeof req.body?.userId === "string" ? req.body.userId : "",
      role: req.body?.role === "owner" || req.body?.role === "editor" || req.body?.role === "viewer" ? req.body.role : "viewer",
      addedAt: new Date().toISOString(),
      addedBy: user.id,
    });
    if (!updated) return res.status(404).json({ error: "Project not found" });
    res.json({ project: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not add project member." });
  }
});

app.delete("/api/projects/:projectId/members/:userId", async (req, res) => {
  const user = getRequestUser(req);
  const project = getProject(req.params.projectId);
  if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
  if (!canManageProject(user, project)) return res.status(403).json({ error: "Project owner access required." });
  const updated = await removeProjectMember(req.params.projectId, req.params.userId);
  if (!updated) return res.status(404).json({ error: "Project not found" });
  res.json({ project: updated });
});

app.get("/api/credits", async (_req, res) => {
  res.json(await getCredits());
});

app.get("/api/usage/monthly", (req, res) => {
  const currentUser = getRequestUser(req);
  const { startAt, endAt, month } = currentMonthRange();
  const users = new Map<string, { userId: string; creditsSpent: number; jobsCompleted: number }>();

  for (const job of getJobs()) {
    if (!canAccessJob(currentUser, job)) continue;
    const finishedAt = new Date(job.completedAt ?? job.createdAt).getTime();
    if (job.status !== "completed" || !Number.isFinite(finishedAt)) continue;
    if (finishedAt < startAt.getTime() || finishedAt >= endAt.getTime()) continue;

    const current = users.get(job.userId) ?? {
      userId: job.userId,
      creditsSpent: 0,
      jobsCompleted: 0,
    };
    current.creditsSpent = roundCredits(current.creditsSpent + creditsSpentForJob(job));
    current.jobsCompleted += 1;
    users.set(job.userId, current);
  }

  res.json({
    month,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    users: Array.from(users.values()).sort((a, b) => b.creditsSpent - a.creditsSpent),
  });
});

app.get("/api/credits/dashboard", (req, res) => {
  const currentUser = getRequestUser(req);
  const visibleJobs = getJobs()
    .filter((job) => canAccessJob(currentUser, job))
    .filter((job) => job.source !== "existing_project_media");
  const now = new Date();
  const range = creditDashboardRange(req.query, now);
  const todayStart = startOfDay(now);
  const todayEnd = addDays(todayStart, 1);
  const { startAt: monthStart, endAt: monthEnd, month } = currentMonthRange();
  const byProject = new Map<string, CreditDashboardGroup>();
  const byUser = new Map<string, CreditDashboardGroup>();
  const byModel = new Map<string, CreditDashboardGroup>();
  const byDay = new Map<string, CreditDashboardDay>();
  const nodeRows: CreditDashboardNodeRow[] = [];
  const allEvents: CreditDashboardRecentJob[] = [];
  const summary = {
    totalCredits: 0,
    totalUsd: 0,
    todayCredits: 0,
    todayUsd: 0,
    todayRuns: 0,
    monthCredits: 0,
    monthUsd: 0,
    monthRuns: 0,
    projectedMonthCredits: 0,
    projectedMonthUsd: 0,
    periodCredits: 0,
    periodUsd: 0,
    periodRuns: 0,
    averageCreditsPerRun: 0,
    burnRateCreditsPerDay: 0,
    jobsWithUsage: 0,
    totalJobs: visibleJobs.length,
  };

  for (const job of visibleJobs) {
    const credits = creditsSpentForJob(job);
    const usd = usdSpentForJob(job);
    const hasUsage = credits > 0 || usd > 0 || Boolean(job.creditUsage);
    const eventDate = new Date(job.completedAt ?? job.startedAt ?? job.createdAt);
    const timestamp = eventDate.getTime();
    const project = getProject(job.projectId);
    const owner = getUserById(job.userId);
    const event: CreditDashboardRecentJob = {
      jobId: job.id,
      projectId: job.projectId,
      projectName: project?.name ?? "Unknown project",
      userId: job.userId,
      userName: owner?.name ?? "Unknown user",
      modelId: job.modelId,
      modelName: job.modelName,
      status: job.status,
      credits,
      usd,
      expectedCredits: expectedCreditsForJob(job),
      source: creditAccountingSource(job),
      resolution: resolutionLabel(job),
      runDurationSeconds: runDurationSeconds(job),
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      timestamp: Number.isFinite(timestamp) ? eventDate.toISOString() : job.createdAt,
    };
    allEvents.push(event);

    if (Number.isFinite(timestamp)) {
      if (timestamp >= todayStart.getTime() && timestamp < todayEnd.getTime()) summary.todayRuns += 1;
      if (timestamp >= monthStart.getTime() && timestamp < monthEnd.getTime()) summary.monthRuns += 1;
    }

    if (hasUsage) {
      summary.jobsWithUsage += 1;
      summary.totalCredits = roundCredits(summary.totalCredits + credits);
      summary.totalUsd = roundUsd(summary.totalUsd + usd);

      if (Number.isFinite(timestamp)) {
        if (timestamp >= todayStart.getTime() && timestamp < todayEnd.getTime()) {
          summary.todayCredits = roundCredits(summary.todayCredits + credits);
          summary.todayUsd = roundUsd(summary.todayUsd + usd);
        }
        if (timestamp >= monthStart.getTime() && timestamp < monthEnd.getTime()) {
          summary.monthCredits = roundCredits(summary.monthCredits + credits);
          summary.monthUsd = roundUsd(summary.monthUsd + usd);
        }
      }
    }
  }

  const periodEvents = allEvents.filter((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    return Number.isFinite(timestamp) && timestamp >= range.startAt.getTime() && timestamp < range.endAt.getTime();
  });
  const periodUsageEvents = periodEvents.filter((event) => event.credits > 0 || event.usd > 0);

  summary.periodRuns = periodEvents.length;
  for (const event of periodUsageEvents) {
    summary.periodCredits = roundCredits(summary.periodCredits + event.credits);
    summary.periodUsd = roundUsd(summary.periodUsd + event.usd);
    addDay(byDay, event.timestamp.slice(0, 10), event.credits, event.usd);
    addGroup(byProject, event.projectId, event.projectName, event);
    addGroup(byUser, event.userId, event.userName, event);
    addGroup(byModel, event.modelId, event.modelName, event);
  }
  summary.averageCreditsPerRun = periodEvents.length ? roundCredits(summary.periodCredits / periodEvents.length) : 0;
  summary.burnRateCreditsPerDay = roundCredits(summary.periodCredits / Math.max(1, daysBetween(range.startAt, range.endAt)));
  const monthDays = daysBetween(monthStart, monthEnd);
  const elapsedMonthDays = Math.max(
    1,
    Math.min(monthDays, Math.ceil((Math.min(now.getTime(), monthEnd.getTime()) - monthStart.getTime()) / 86400000)),
  );
  summary.projectedMonthCredits = roundCredits((summary.monthCredits / elapsedMonthDays) * monthDays);
  summary.projectedMonthUsd = roundUsd((summary.monthUsd / elapsedMonthDays) * monthDays);

  for (const job of visibleJobs) {
    const project = getProject(job.projectId);
    const owner = getUserById(job.userId);
    if (!isCountedCreditUsage(job.creditUsage)) continue;
    for (const [index, row] of (job.creditUsage?.rows ?? []).entries()) {
      const createdAt = job.completedAt ?? job.createdAt;
      const rowTimestamp = new Date(createdAt).getTime();
      if (!Number.isFinite(rowTimestamp) || rowTimestamp < range.startAt.getTime() || rowTimestamp >= range.endAt.getTime()) continue;
      nodeRows.push({
        jobId: job.id,
        projectName: project?.name ?? "Unknown project",
        userName: owner?.name ?? "Unknown user",
        modelName: job.modelName,
        nodeId: stringField(row.node_id),
        nodeTitle: stringField(row.node_title),
        classType: stringField(row.class_type),
        credits: roundCredits(Number(row.total_estimated_credits ?? 0) || 0),
        usd: roundUsd(Number(row.total_estimated_usd ?? 0) || 0),
        source: stringField(row.source),
        status: stringField(row.status),
        createdAt: job.completedAt ?? job.createdAt,
        rowKey: `${job.id}:${row.node_id ?? row.node_title ?? index}`,
      });
    }
  }

  res.json({
    dashboard: {
      generatedAt: now.toISOString(),
      month,
      range: {
        preset: range.preset,
        label: range.label,
        startAt: range.startAt.toISOString(),
        endAt: range.endAt.toISOString(),
      },
      summary,
      byProject: sortedGroups(byProject),
      byUser: sortedGroups(byUser),
      byModel: sortedGroups(byModel),
      byDay: fillDailyRange(range.startAt, range.endAt, byDay),
      anomalies: creditAnomalies(periodEvents, byDay),
      recent: periodEvents
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 500),
      nodeRows: nodeRows
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 500),
    },
  });
});

app.post("/api/prompt/describe-image", async (req, res) => {
  try {
    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : undefined;

    if (!imageBase64.trim() && !imagesBase64?.length) {
      return res.status(400).json({ error: "imageBase64 or imagesBase64 is required." });
    }

    const result = await describeImageWithRunpod({
      imageBase64,
      imagesBase64,
      prompt: typeof req.body?.prompt === "string" ? req.body.prompt : undefined,
      systemPrompt: typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : undefined,
      maxTokens: Number.isFinite(Number(req.body?.maxTokens)) ? Number(req.body.maxTokens) : undefined,
      temperature: Number.isFinite(Number(req.body?.temperature)) ? Number(req.body.temperature) : undefined,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not describe image.";
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

app.post("/api/prompt/seedance-workflow", async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : [];
    const referenceImages = imagesBase64.length ? imagesBase64 : imageBase64.trim() ? [imageBase64] : [];

    const result = await runSeedancePromptWorkflow({
      prompt,
      imagesBase64: referenceImages,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate Seedance prompt.";
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

app.post("/api/prompt/kling-workflow", async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const cameraPrompt = typeof req.body?.cameraPrompt === "string" ? req.body.cameraPrompt : undefined;
    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : [];
    const referenceImages = imagesBase64.length ? imagesBase64 : imageBase64.trim() ? [imageBase64] : [];

    const result = await runKlingPromptWorkflow({
      prompt,
      cameraPrompt,
      imagesBase64: referenceImages,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate Kling prompt.";
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

app.post("/api/prompt/improve", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  try {
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required." });
    }

    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : undefined;
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : undefined;

    if (!imageBase64?.trim() && !imagesBase64?.length) {
      return res.json({
        text: improveTextPromptLocally(prompt),
        model: "local-text-prompt-fallback",
      });
    }

    const result = await describeImageWithRunpod({
      imageBase64,
      imagesBase64,
      prompt,
      systemPrompt: typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : undefined,
      maxTokens: Number.isFinite(Number(req.body?.maxTokens)) ? Number(req.body.maxTokens) : undefined,
      temperature: Number.isFinite(Number(req.body?.temperature)) ? Number(req.body.temperature) : undefined,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not improve prompt.";
    const errorCode = httpErrorCode(error);
    if (errorCode === "prompt_helper_not_configured" || errorCode === "prompt_helper_no_text") {
      return res.json({
        text: improveTextPromptLocally(prompt),
        model: "local-text-prompt-fallback",
        warning: message,
      });
    }
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

app.post("/api/media/upload", async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (isDemoAccount(user)) {
      return res.status(403).json({ error: "Demo accounts are view-only and cannot upload media." });
    }

    const projectId = getQueryValue(req.query.projectId);
    const project = getProject(projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canCreateJobInProject(user, project)) return res.status(403).json({ error: "Project editor access required." });

    const kind = getQueryValue(req.query.kind) === "video" ? "video" : "image";
    const contentType = String(req.headers["content-type"] ?? "");
    if (!isAllowedUploadContentType(kind, contentType)) {
      return res.status(415).json({ error: `Expected an ${kind} upload body.` });
    }

    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > mediaUploadMaxBytes) {
      return res.status(413).json({ error: `Upload is larger than the ${formatBytes(mediaUploadMaxBytes)} limit.` });
    }

    const fileName = uploadedMediaFileName(getQueryValue(req.query.name), kind, contentType);
    const uploadId = `${Date.now()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const filePath = path.join(uploadedMediaRoot, safeSegment(project.id), safeSegment(user.id), `${uploadId}-${fileName}`);
    const { bytesWritten } = await writeStreamAtomically(req, filePath, mediaUploadMaxBytes, requestAbortSignal(req));
    if (bytesWritten <= 0) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      return res.status(400).json({ error: "Upload body was empty." });
    }

    res.status(201).json({
      url: mediaUrl(filePath),
      name: fileName,
      kind,
      bytes: bytesWritten,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not upload media.";
    const status = message.includes("maximum allowed size") || message.includes("larger than") ? 413 : 400;
    res.status(status).json({ error: message });
  }
});

app.get("/api/jobs", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const limit = parsePaginationNumber(req.query.limit, 80, 250);
    const offset = parsePaginationNumber(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
    const ownerFilter = getQueryValue(req.query.userId);
    const archived = parseBooleanQuery(req.query.archived);
    const visibleJobs = filterJobsForUser(await getJobsWithExistingMedia({ archived }), user, ownerFilter);
    const filteredJobs = filterJobs(visibleJobs, {
      projectId: getQueryValue(req.query.projectId),
      source: getQueryValue(req.query.source),
      status: getQueryValue(req.query.status),
      outputType: getQueryValue(req.query.outputType),
      folderId: getQueryValue(req.query.folderId),
      q: getQueryValue(req.query.q),
      dateDays: parseOptionalNumber(req.query.dateDays),
    });
    const jobs = filteredJobs.slice(offset, offset + limit);

    res.json({
      jobs,
      total: filteredJobs.length,
      limit,
      offset,
      hasMore: offset + jobs.length < filteredJobs.length,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not scan jobs" });
  }
});

app.get("/api/media", async (req, res) => {
  const user = getRequestUser(req);
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  const resolvedPath = path.resolve(rawPath);
  const allowedRoots = [brickProjectsRoot, localProjectsRoot, uploadedMediaRoot, path.join(comfyRoot, "output"), path.join(comfyRoot, "input")]
    .map((root) => path.resolve(root).toLowerCase());

  if (!allowedRoots.some((root) => resolvedPath.toLowerCase().startsWith(root))) {
    return res.status(403).json({ error: "Media path is outside allowed project roots" });
  }

  const project = getProjects().find((item) => {
    const folderPath = item.folderPath ? path.resolve(item.folderPath).toLowerCase() : "";
    return folderPath && resolvedPath.toLowerCase().startsWith(folderPath);
  });
  if (project && !canViewProject(user, project)) {
    return res.status(404).json({ error: "Media file not found" });
  }

  try {
    await fs.access(resolvedPath);
    await streamLocalFile(req, res, resolvedPath, {
      contentType: contentTypeFromFilePath(resolvedPath),
      disposition: `inline; filename="${safeHeaderFileName(path.basename(resolvedPath))}"`,
    });
  } catch {
    res.status(404).json({ error: "Media file not found" });
  }
});

app.get("/api/jobs/:jobId/result-file", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });

    const index = Number(req.query.index ?? 0);
    const resultUrl = job.resultUrls[Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0)] ?? job.thumbnailUrls[0];
    if (!resultUrl) return res.status(404).json({ error: "Result file not found" });

    const absoluteUrl = new URL(resultUrl, `http://127.0.0.1:${PORT}`);
    const localPath = mediaFilePathFromUrl(absoluteUrl);
    if (localPath) {
      try {
        await fs.access(localPath);
        const contentType = contentTypeFromFilePath(localPath);
        await streamLocalFile(req, res, localPath, {
          contentType,
          disposition: `attachment; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType))}"`,
        });
        return;
      } catch {
        return res.status(404).json({ error: "Result file not found" });
      }
    }

    const upstream = await fetch(absoluteUrl, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Could not read result file" });
    }

    const contentType = upstream.headers.get("content-type") ?? contentTypeFromUrl(absoluteUrl);
    const contentLength = upstream.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName(job, absoluteUrl, contentType)}"`);
    sendUpstreamBody(upstream, res);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not download result file" });
  }
});

app.get("/api/jobs/:jobId/result-media", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });

    const index = Number(req.query.index ?? 0);
    const resultUrl = job.resultUrls[Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0)] ?? job.thumbnailUrls[0];
    if (!resultUrl) return res.status(404).json({ error: "Result file not found" });

    const absoluteUrl = new URL(resultUrl, `http://127.0.0.1:${PORT}`);
    const localPath = mediaFilePathFromUrl(absoluteUrl);
    if (localPath) {
      try {
        await fs.access(localPath);
        const contentType = contentTypeFromFilePath(localPath);
        await streamLocalFile(req, res, localPath, {
          contentType,
          disposition: `inline; filename="${safeHeaderFileName(downloadFileName(job, absoluteUrl, contentType))}"`,
        });
        return;
      } catch {
        return res.status(404).json({ error: "Result file not found" });
      }
    }

    const headers = new Headers();
    const range = req.headers.range;
    if (range) {
      headers.set("Range", range);
    }

    const upstream = await fetch(absoluteUrl, { headers, signal: AbortSignal.timeout(120000) });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: "Could not read result media" });
    }

    const contentType = upstream.headers.get("content-type") ?? contentTypeFromUrl(absoluteUrl);
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    for (const header of ["accept-ranges", "content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) {
        res.setHeader(header, value);
      }
    }
    res.setHeader("Content-Disposition", `inline; filename="${downloadFileName(job, absoluteUrl, contentType)}"`);
    sendUpstreamBody(upstream, res);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read result media" });
  }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const user = getRequestUser(req);
  const job = getJob(req.params.jobId);
  if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });
  res.json({ job });
});

app.post("/api/jobs", async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (isDemoAccount(user)) {
      return res.status(403).json({ error: "Demo accounts are view-only and cannot generate tasks." });
    }
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const project = getProject(projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canCreateJobInProject(user, project)) return res.status(403).json({ error: "Project editor access required." });
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : "";
    const model = getWorkflowModel(modelId);
    if (user.role !== "admin" && model && isSeedanceModel(model) && is4KResolution(req.body?.resolution)) {
      return res.status(403).json({ error: "Seedance 4K generation is available to administrators only." });
    }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    if (model && isKlingVideoModel(model) && prompt.length > KLING_PROMPT_CHARACTER_LIMIT) {
      return res.status(400).json({
        error: `Kling prompts are limited to ${KLING_PROMPT_CHARACTER_LIMIT} characters; this prompt is ${prompt.length}. Shorten it and try again.`,
      });
    }
    const job = await createJob({ ...(req.body ?? {}), userId: user.id });
    res.status(201).json({ job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create job" });
  }
});

function isSeedanceModel(model: { id: string; name: string; category: string; workflowPath: string }) {
  return `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase().includes("seedance");
}

// Kept in sync with KLING_PROMPT_CHARACTER_LIMIT in src/services/promptRules.ts.
const KLING_PROMPT_CHARACTER_LIMIT = 2500;

function isKlingVideoModel(model: { id: string; name: string; category: string; workflowPath: string; outputType: string }) {
  return model.outputType === "video"
    && `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase().includes("kling");
}

function is4KResolution(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resolution = value as { width?: unknown; height?: unknown; label?: unknown };
  const label = typeof resolution.label === "string" ? resolution.label.toLowerCase().replace(/\s+/g, "") : "";
  const width = Number(resolution.width);
  const height = Number(resolution.height);
  return label === "4k" || (Math.max(width, height) === 3840 && Math.min(width, height) === 2160);
}

app.post("/api/jobs/:jobId/cancel", async (req, res) => {
  const user = getRequestUser(req);
  const existing = getJob(req.params.jobId);
  if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Job not found" });
  if (!canManageJob(user, existing)) return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
  const job = await cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ job });
});

app.post("/api/jobs/:jobId/archive", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const existing = await getJobFromAnySource(req.params.jobId);
    if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Job not found" });
    if (!canManageJob(user, existing)) return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    const job = await archiveJob(req.params.jobId, user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not archive job" });
  }
});

app.post("/api/jobs/:jobId/restore", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const existing = await getJobFromAnySource(req.params.jobId, { archived: true });
    if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Archived job not found" });
    if (!canManageJob(user, existing)) return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    const job = await restoreArchivedJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Archived job not found" });
    res.json({ job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not restore job" });
  }
});

app.delete("/api/jobs/:jobId/permanent", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const existing = await getJobFromAnySource(req.params.jobId, { archived: true });
    if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Archived job not found" });
    if (!canManageJob(user, existing)) return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    const job = await permanentlyDeleteArchivedJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Archived job not found" });
    res.json({ job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not permanently delete job" });
  }
});

app.get("/api/jobs/:jobId/status", (req, res) => {
  const user = getRequestUser(req);
  const job = getJob(req.params.jobId);
  if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });
  res.json({
    id: job.id,
    status: job.status,
    errorMessage: job.errorMessage,
    comfyPromptId: job.comfyPromptId,
    runpodJobId: job.runpodJobId,
    runpodStatus: job.runpodStatus,
  });
});

app.get("/api/jobs/:jobId/result", (req, res) => {
  void (async () => {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });
    res.json({ resultUrls: job.resultUrls, thumbnailUrls: job.thumbnailUrls, status: job.status });
  })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "Could not read job result" }));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
  });
});

async function boot() {
  validateRuntimeConfigForStartup();
  startMemoryLogging(memoryLogIntervalMs);
  logMemory("boot-start");
  await Promise.all([
    loadAuthData(),
    loadWorkflowModels(),
    loadProjects(),
    loadJobs(),
    localComfyEnabled ? refreshServers() : Promise.resolve([]),
  ]);
  await assertMetadataHealth();
  app.listen(PORT, HOST, () => {
    console.log(`Momi backend listening on http://${HOST}:${PORT}`);
    console.log(`Generation backend: ${generationBackend}`);
    logMemory("boot-listening");
  });
}

void boot().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function parsePaginationNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(getQueryValue(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(0, Math.floor(parsed)), max);
}

function parseOptionalNumber(value: unknown) {
  const raw = getQueryValue(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function currentMonthRange() {
  const now = new Date();
  const startAt = new Date(now.getFullYear(), now.getMonth(), 1);
  const endAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = `${startAt.getFullYear()}-${String(startAt.getMonth() + 1).padStart(2, "0")}`;
  return { startAt, endAt, month };
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

function creditsSpentForJob(job: Job) {
  return creditsSpentForAccounting(job);
}

type CreditDashboardGroup = {
  id: string;
  label: string;
  credits: number;
  usd: number;
  jobs: number;
  percentage: number;
  averageCreditsPerRun: number;
  minCredits: number;
  maxCredits: number;
  expectedCredits: number;
  actualVsExpectedCredits: number;
  lastActivityAt?: string;
  mostExpensiveWorkflow?: string;
  mostExpensiveWorkflowCredits?: number;
};

type CreditDashboardDay = {
  date: string;
  credits: number;
  usd: number;
  jobs: number;
};

type CreditDashboardRecentJob = {
  jobId: string;
  projectId: string;
  projectName: string;
  userId: string;
  userName: string;
  modelId: string;
  modelName: string;
  status: Job["status"];
  credits: number;
  usd: number;
  expectedCredits: number;
  source: string;
  resolution: string;
  runDurationSeconds?: number;
  createdAt: string;
  completedAt?: string;
  timestamp: string;
};

type CreditDashboardNodeRow = {
  rowKey: string;
  jobId: string;
  projectName: string;
  userName: string;
  modelName: string;
  nodeId: string;
  nodeTitle: string;
  classType: string;
  credits: number;
  usd: number;
  source: string;
  status: string;
  createdAt: string;
};

type CreditDashboardAnomaly = {
  id: string;
  type: "run_high" | "expected_overrun" | "daily_high";
  severity: "warning" | "critical";
  message: string;
  jobId?: string;
  date?: string;
  credits: number;
  threshold: number;
};

function usdSpentForJob(job: Job) {
  if (!isCountedCreditUsage(job.creditUsage)) return 0;
  const direct = Number(job.creditUsage?.total_estimated_usd ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const rows = job.creditUsage?.rows ?? [];
  return rows.reduce((sum, row) => {
    const value = Number(row.total_estimated_usd ?? 0);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
}

function roundUsd(value: number) {
  return Math.round(value * 10000) / 10000;
}

function expectedCreditsForJob(job: Job) {
  const model = getWorkflowModel(job.modelId);
  if (model) {
    const currentEstimate = estimateWorkflowCredits(model, job.durationSeconds, job.resolution, job.workflowOptions);
    if (Number.isFinite(currentEstimate) && currentEstimate > 0) return currentEstimate;
  }
  const storedEstimate = Number(job.creditsEstimated ?? 0);
  return Number.isFinite(storedEstimate) && storedEstimate > 0 ? storedEstimate : 0;
}

function resolutionLabel(job: Job) {
  if (!job.resolution) return "";
  return job.resolution.label || `${job.resolution.width} x ${job.resolution.height}`;
}

function runDurationSeconds(job: Job) {
  const start = new Date(job.startedAt ?? "").getTime();
  const end = new Date(job.completedAt ?? "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.round((end - start) / 1000);
}

function creditDashboardRange(query: Record<string, unknown>, now: Date) {
  const preset = getQueryValue(query.range) || "last30";
  const today = startOfDay(now);
  if (preset === "today") return { preset, label: "Today", startAt: today, endAt: addDays(today, 1) };
  if (preset === "last7") return { preset, label: "Last 7 days", startAt: addDays(today, -6), endAt: addDays(today, 1) };
  if (preset === "thisMonth") {
    const { startAt, endAt, month } = currentMonthRange();
    return { preset, label: month, startAt, endAt };
  }
  if (preset === "lastMonth") {
    const startAt = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endAt = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      preset,
      label: `${startAt.getFullYear()}-${String(startAt.getMonth() + 1).padStart(2, "0")}`,
      startAt,
      endAt,
    };
  }
  if (preset === "custom") {
    const startAt = parseDateOnly(getQueryValue(query.from), addDays(today, -29));
    const endAt = addDays(parseDateOnly(getQueryValue(query.to), today), 1);
    return {
      preset,
      label: `${dayKey(startAt)} to ${dayKey(addDays(endAt, -1))}`,
      startAt: startAt < endAt ? startAt : addDays(today, -29),
      endAt: startAt < endAt ? endAt : addDays(today, 1),
    };
  }
  return { preset: "last30", label: "Last 30 days", startAt: addDays(today, -29), endAt: addDays(today, 1) };
}

function parseDateOnly(value: string, fallback: Date) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysBetween(startAt: Date, endAt: Date) {
  return Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / 86400000));
}

function fillDailyRange(startAt: Date, endAt: Date, rows: Map<string, CreditDashboardDay>) {
  const output: CreditDashboardDay[] = [];
  const maxDays = Math.min(120, daysBetween(startAt, endAt));
  const start = addDays(endAt, -maxDays);
  for (let date = startOfDay(start); date < endAt; date = addDays(date, 1)) {
    const key = dayKey(date);
    output.push(rows.get(key) ?? { date: key, credits: 0, usd: 0, jobs: 0 });
  }
  return output;
}

function creditAnomalies(events: CreditDashboardRecentJob[], byDay: Map<string, CreditDashboardDay>): CreditDashboardAnomaly[] {
  const anomalies: CreditDashboardAnomaly[] = [];
  const workflow = new Map<string, { credits: number; jobs: number }>();
  for (const event of events) {
    if (event.credits <= 0) continue;
    const current = workflow.get(event.modelId) ?? { credits: 0, jobs: 0 };
    current.credits += event.credits;
    current.jobs += 1;
    workflow.set(event.modelId, current);
  }

  for (const event of events) {
    const stats = workflow.get(event.modelId);
    const average = stats && stats.jobs ? stats.credits / stats.jobs : 0;
    if (average > 0 && event.credits > Math.max(average * 2, average + 25)) {
      anomalies.push({
        id: `run-high:${event.jobId}`,
        type: "run_high",
        severity: event.credits > average * 3 ? "critical" : "warning",
        message: `${event.modelName} used ${roundCredits(event.credits)} credits, above its ${roundCredits(average)} average.`,
        jobId: event.jobId,
        credits: event.credits,
        threshold: roundCredits(average * 2),
      });
    }
    if (event.expectedCredits > 0 && event.credits > event.expectedCredits * 1.2) {
      anomalies.push({
        id: `expected:${event.jobId}`,
        type: "expected_overrun",
        severity: event.credits > event.expectedCredits * 1.75 ? "critical" : "warning",
        message: `${event.modelName} used more credits than expected.`,
        jobId: event.jobId,
        credits: event.credits,
        threshold: roundCredits(event.expectedCredits),
      });
    }
  }

  const activeDays = Array.from(byDay.values()).filter((day) => day.credits > 0);
  const averageDaily = activeDays.length ? activeDays.reduce((sum, day) => sum + day.credits, 0) / activeDays.length : 0;
  for (const day of activeDays) {
    if (averageDaily > 0 && day.credits > Math.max(averageDaily * 2, averageDaily + 50)) {
      anomalies.push({
        id: `day-high:${day.date}`,
        type: "daily_high",
        severity: day.credits > averageDaily * 3 ? "critical" : "warning",
        message: `${day.date} usage was unusually high.`,
        date: day.date,
        credits: day.credits,
        threshold: roundCredits(averageDaily * 2),
      });
    }
  }

  return anomalies.slice(0, 50);
}

function addGroup(map: Map<string, CreditDashboardGroup>, id: string, label: string, event: CreditDashboardRecentJob) {
  const current = map.get(id) ?? {
    id,
    label,
    credits: 0,
    usd: 0,
    jobs: 0,
    percentage: 0,
    averageCreditsPerRun: 0,
    minCredits: Number.POSITIVE_INFINITY,
    maxCredits: 0,
    expectedCredits: 0,
    actualVsExpectedCredits: 0,
  };
  current.credits = roundCredits(current.credits + event.credits);
  current.usd = roundUsd(current.usd + event.usd);
  current.jobs += 1;
  current.averageCreditsPerRun = roundCredits(current.credits / current.jobs);
  current.minCredits = Math.min(current.minCredits, event.credits);
  current.maxCredits = Math.max(current.maxCredits, event.credits);
  current.expectedCredits = roundCredits(current.expectedCredits + event.expectedCredits);
  current.actualVsExpectedCredits = roundCredits(current.credits - current.expectedCredits);
  if (!current.lastActivityAt || new Date(event.timestamp).getTime() > new Date(current.lastActivityAt).getTime()) {
    current.lastActivityAt = event.timestamp;
  }
  if (!current.mostExpensiveWorkflowCredits || event.credits > current.mostExpensiveWorkflowCredits) {
    current.mostExpensiveWorkflow = event.modelName;
    current.mostExpensiveWorkflowCredits = event.credits;
  }
  map.set(id, current);
}

function addDay(map: Map<string, CreditDashboardDay>, date: string, credits: number, usd: number) {
  const current = map.get(date) ?? { date, credits: 0, usd: 0, jobs: 0 };
  current.credits = roundCredits(current.credits + credits);
  current.usd = roundUsd(current.usd + usd);
  current.jobs += 1;
  map.set(date, current);
}

function sortedGroups(map: Map<string, CreditDashboardGroup>) {
  const rows = Array.from(map.values());
  const total = rows.reduce((sum, row) => sum + row.credits, 0);
  return rows
    .map((row) => ({
      ...row,
      minCredits: Number.isFinite(row.minCredits) ? row.minCredits : 0,
      percentage: total > 0 ? Math.round((row.credits / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.credits - a.credits || b.usd - a.usd || a.label.localeCompare(b.label));
}

function dayKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function findCreditTrackerProjectStats(
  project: Project,
  statsByProjectName: Map<string, CreditTrackerProjectStats>,
) {
  if (!statsByProjectName.size) return undefined;

  const normalized = new Map(
    Array.from(statsByProjectName.entries()).map(([name, stats]) => [normalizeProjectStatName(name), stats]),
  );
  for (const candidate of projectStatNameCandidates(project)) {
    const stats = normalized.get(normalizeProjectStatName(candidate));
    if (stats) return stats;
  }
  return undefined;
}

function projectStatNameCandidates(project: Project) {
  const folderName = project.folderName || path.basename(project.folderPath || "");
  return [
    folderName,
    `${project.shortName}_${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    `${project.shortName}_${project.name}`,
    project.name,
    project.shortName,
  ].filter(Boolean);
}

function normalizeProjectStatName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function projectRenameRequested(body: unknown, project: Project) {
  if (!body || typeof body !== "object") return false;
  const input = body as Record<string, unknown>;
  const requestedName = typeof input.name === "string" ? input.name.trim() : undefined;
  const requestedClient = typeof input.client === "string" ? input.client.trim() : undefined;
  return Boolean(
    requestedName && requestedName !== project.name
    || requestedClient && requestedClient !== (project.client ?? ""),
  );
}

function projectCodeChangeRequested(body: unknown, project: Project) {
  if (!body || typeof body !== "object") return false;
  const input = body as Record<string, unknown>;
  const requestedCode = typeof input.code === "string" ? input.code.trim() : typeof input.shortName === "string" ? input.shortName.trim() : undefined;
  return Boolean(requestedCode && requestedCode !== (project.code ?? project.shortName));
}

function canAccessJob(user: User, job: Job) {
  if (user.role === "admin" || job.userId === user.id) return true;
  const project = getProject(job.projectId);
  return Boolean(project && canViewProject(user, project));
}

async function getVisibleJobForResult(jobId: string, user: User) {
  const activeJob = (await getJobsWithExistingMedia()).find((job) => job.id === jobId);
  if (activeJob && canAccessJob(user, activeJob)) return activeJob;
  const archivedJob = (await getJobsWithExistingMedia({ archived: true })).find((job) => job.id === jobId);
  return archivedJob && canAccessJob(user, archivedJob) ? archivedJob : undefined;
}

function canManageJob(user: User, job: Job) {
  if (user.role === "admin" || job.userId === user.id) return true;
  const project = getProject(job.projectId);
  return Boolean(project && getProjectRole(project, user.id) === "owner");
}

function canViewProject(user: User, project: Project) {
  return user.role === "admin" || project.ownerId === user.id || Boolean(getProjectRole(project, user.id));
}

function canCreateJobInProject(user: User, project: Project) {
  if (user.role === "admin") return true;
  const role = getProjectRole(project, user.id);
  return role === "owner" || role === "editor";
}

function isDemoAccount(user: User) {
  const email = user.email.toLowerCase();
  const username = (user.username ?? "").toLowerCase();
  const configuredDemoEmails = (process.env.MOMI_DEMO_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return email === "demo@brickvisual.com"
    || email === "momi.demo@brickvisual.com"
    || username === "demo"
    || username === "momi-demo"
    || configuredDemoEmails.includes(email);
}

function canManageProject(user: User, project: Project) {
  return user.role === "admin" || project.ownerId === user.id || getProjectRole(project, user.id) === "owner";
}

function getProjectRole(project: Project, userId: string) {
  return project.members?.find((member) => member.userId === userId)?.role;
}

function filterJobsForUser(jobs: Job[], user: User, ownerUserId?: string) {
  return jobs.filter((job) => {
    if (!canAccessJob(user, job)) return false;
    if (ownerUserId && job.userId !== ownerUserId) return false;
    return true;
  });
}

function getQueryValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBooleanQuery(value: unknown) {
  return typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function setSessionCookie(res: express.Response, token: string, expiresAt: string) {
  const maxAgeSeconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `momi_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", "momi_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function contentTypeFromUrl(url: URL) {
  const extension = path.extname(url.searchParams.get("filename") || url.searchParams.get("path") || url.pathname).toLowerCase();
  return contentTypeFromExtension(extension);
}

function sendUpstreamBody(upstream: Response, res: express.Response) {
  if (!upstream.body) {
    res.status(502).json({ error: "Upstream response did not include a readable body." });
    return;
  }

  Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>).on("error", (error) => {
    res.destroy(error);
  }).pipe(res);
}

async function streamLocalFile(
  req: express.Request,
  res: express.Response,
  filePath: string,
  options: { contentType: string; disposition?: string; cacheControl?: string },
) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Media file not found");
  }

  const fileSize = stat.size;
  const range = parseByteRange(req.headers.range, fileSize);
  if (range === "unsatisfiable") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, fileSize - 1);
  const contentLength = fileSize === 0 ? 0 : end - start + 1;

  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", options.contentType);
  res.setHeader("Content-Length", String(contentLength));
  res.setHeader("Cache-Control", options.cacheControl ?? "private, max-age=3600");
  if (options.disposition) {
    res.setHeader("Content-Disposition", options.disposition);
  }

  if (fileSize === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end, highWaterMark: 64 * 1024 });
  const closeStream = () => stream.destroy();
  req.on("aborted", closeStream);
  res.on("close", closeStream);
  stream.on("error", (error) => {
    res.destroy(error);
  });
  stream.pipe(res);
}

function parseByteRange(rangeHeader: string | undefined, fileSize: number): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!rangeHeader) return undefined;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)(?:,.*)?$/);
  if (!match) return undefined;
  if (fileSize <= 0) return "unsatisfiable";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return {
      start: Math.max(fileSize - Math.floor(suffixLength), 0),
      end: fileSize - 1,
    };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return "unsatisfiable";
  }

  return {
    start: Math.floor(start),
    end: Math.min(Math.floor(end), fileSize - 1),
  };
}

function safeHeaderFileName(value: string) {
  return value.replace(/["\r\n]/g, "_");
}

function contentTypeFromFilePath(filePath: string) {
  return contentTypeFromExtension(path.extname(filePath).toLowerCase());
}

function contentTypeFromExtension(extension: string) {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".m4v") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mkv") return "video/x-matroska";
  if (extension === ".avi") return "video/x-msvideo";
  return "application/octet-stream";
}

function requestAbortSignal(req: express.Request) {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  return controller.signal;
}

function isAllowedUploadContentType(kind: "image" | "video", contentType: string) {
  const lower = contentType.toLowerCase();
  if (kind === "image") {
    return lower.startsWith("image/") || lower === "application/octet-stream";
  }
  return lower.startsWith("video/") || lower === "application/octet-stream" || lower.includes("quicktime");
}

function uploadedMediaFileName(rawName: string, kind: "image" | "video", contentType: string) {
  const parsed = path.parse(rawName || `${kind}-upload`);
  const baseName = safeSegment(parsed.name || `${kind}-upload`);
  const extension = cleanMediaExtension(parsed.ext) || extensionFromContentType(contentType) || (kind === "image" ? ".png" : ".mp4");
  return `${baseName}${extension}`;
}

function cleanMediaExtension(extension: string) {
  const cleaned = extension.toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (!cleaned || cleaned === ".") return "";
  return cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
}

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib >= 1 ? mib.toFixed(1) : (value / 1024).toFixed(1)} ${mib >= 1 ? "MiB" : "KiB"}`;
}

function downloadFileName(job: Job, url: URL, contentType: string) {
  const urlFileName = url.searchParams.get("filename") || path.basename(url.searchParams.get("path") || url.pathname);
  const extension = path.extname(urlFileName) || extensionFromContentType(contentType);
  const baseName = `${job.modelName || "result"}-${job.id}`.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  return `${baseName}${extension}`;
}

function mediaFilePathFromUrl(url: URL) {
  if (url.pathname === "/api/media") {
    const filePath = url.searchParams.get("path");
    return filePath && isAllowedMediaPath(filePath) ? path.resolve(filePath) : undefined;
  }

  if (url.pathname.endsWith("/view")) {
    const filename = url.searchParams.get("filename");
    const subfolder = url.searchParams.get("subfolder") ?? "";
    const type = url.searchParams.get("type") || "output";
    if (!filename) return undefined;
    const port = url.port;
    const filePath = /^82\d\d$/.test(port)
      ? path.join("C:\\Comfy_pool\\instances", `comfy-${port}`, type, subfolder, filename)
      : path.join(comfyRoot, type, subfolder, filename);
    return isAllowedMediaPath(filePath, { allowTemp: true }) ? path.resolve(filePath) : undefined;
  }

  return undefined;
}

function isAllowedMediaPath(filePath: string, options: { allowTemp?: boolean } = {}) {
  const resolvedPath = path.resolve(filePath).toLowerCase();
  const roots = [brickProjectsRoot, localProjectsRoot, uploadedMediaRoot, path.join(comfyRoot, "output"), path.join(comfyRoot, "input")];
  if (options.allowTemp) {
    roots.push(path.join(comfyRoot, "temp"));
    roots.push("C:\\Comfy_pool\\instances");
  }
  return roots.map((root) => path.resolve(root).toLowerCase()).some((root) => resolvedPath.startsWith(root));
}

function extensionFromContentType(contentType: string) {
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/gif")) return ".gif";
  if (contentType.includes("video/mp4")) return ".mp4";
  if (contentType.includes("video/quicktime")) return ".mov";
  if (contentType.includes("video/webm")) return ".webm";
  if (contentType.includes("video/x-matroska")) return ".mkv";
  if (contentType.includes("video/x-msvideo")) return ".avi";
  return ".bin";
}

function normalizeJobSaveNumber(value?: number | string | null) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return (digits || "0000").padStart(4, "0");
}

function isVideoSaveJob(job: Pick<Job, "category" | "inputType" | "modelName" | "outputType">) {
  const modelName = job.modelName.toLowerCase();
  return job.category.includes("video") || job.outputType !== "image" || job.inputType === "video" || modelName.includes("video");
}

function getJobSaveSearchValue(job: Job) {
  if (job.source === "existing_project_media") return "";

  const save = job.workflowOptions?.save;
  const value = isVideoSaveJob(job)
    ? save?.shotNumber ?? save?.cameraNumber
    : save?.cameraNumber ?? save?.shotNumber;

  return normalizeJobSaveNumber(value);
}

function filterJobs(
  jobs: Job[],
  filters: {
    projectId: string;
    folderId: string;
    source: string;
    status: string;
    outputType: string;
    q: string;
    dateDays?: number;
  },
) {
  const query = filters.q.toLowerCase();
  const cutoff = filters.dateDays ? Date.now() - filters.dateDays * 24 * 60 * 60 * 1000 : undefined;

  return jobs.filter((job) => {
    if (filters.projectId && job.projectId !== filters.projectId) return false;
    if (filters.folderId === "root" && job.folderId) return false;
    if (filters.folderId && filters.folderId !== "root" && job.folderId !== filters.folderId) return false;
    if (filters.source && job.source !== filters.source) return false;
    if (filters.status && job.status !== filters.status) return false;
    if (filters.outputType && job.outputType !== filters.outputType) return false;
    if (cutoff && new Date(job.createdAt).getTime() < cutoff) return false;

    if (query) {
      const project = getProject(job.projectId);
      const saveNumber = getJobSaveSearchValue(job);
      const saveLabel = saveNumber ? (isVideoSaveJob(job) ? "shot" : "camera") : "";
      const searchable = [
        job.id,
        job.title,
        job.prompt,
        job.modelName,
        job.fileName,
        job.folderName,
        job.userId,
        project?.name,
        project?.folderName,
        saveLabel,
        saveNumber,
      ].filter(Boolean).join(" ").toLowerCase();

      if (!searchable.includes(query)) return false;
    }

    return true;
  });
}

function improveTextPromptLocally(prompt: string) {
  const currentPromptMatch = prompt.match(/current prompt:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|\nReturn only|\s*$)/i);
  const currentPrompt = (currentPromptMatch?.[1] ?? prompt)
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!currentPrompt) {
    return prompt.trim();
  }

  const cleaned = currentPrompt.replace(/[.。]+$/g, "");
  return `${cleaned}, with clear subject preservation, natural realistic details, consistent lighting, clean edges, and no unwanted changes to the surrounding scene.`;
}
