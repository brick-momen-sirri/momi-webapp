// Projects, their folders, their members, and the per-project job mutations.

import express from "express";
import { getRequestUser, requireAdmin } from "../authMiddleware.js";
import { getUserById } from "../authService.js";
import { creditsSpentForJob, findCreditTrackerProjectStats, roundCredits, roundUsd, usdSpentForJob } from "../creditDashboardService.js";
import { getCreditTrackerProjectStats } from "../creditUsageService.js";
import { currentMonthRange } from "../httpQuery.js";
import { canAccessJob, canManageJob, canManageProject, canViewProject, filterJobsForUser } from "../jobPermissions.js";
import { getJob, getJobsWithExistingMedia, moveJobResult, renameJob, updateJobSaveNumber } from "../jobQueue.js";
import { parseProjectMemberInput, projectMemberInputError } from "../projectMemberInput.js";
import { projectCodeChangeRequested, projectRenameRequested } from "../projectRequestGuards.js";
import { isProjectVisibility } from "../projectVisibility.js";
import {
  addProjectMember,
  createProject,
  createProjectFolder,
  deleteProjectFolder,
  getProject,
  getProjects,
  listProjectFolders,
  removeProjectMember,
  renameProject,
  renameProjectFolder,
  updateProject,
} from "../projectService.js";
import type { ProjectMember } from "../types.js";

export const projectRouter = express.Router();

projectRouter.get("/api/projects", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const visibleProjects = getProjects().filter((project) => canViewProject(user, project));
    const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
    const jobs = filterJobsForUser(await getJobsWithExistingMedia(), user);
    const { startAt, endAt } = currentMonthRange();
    const jobStatsByProjectId = new Map<
      string,
      { jobCount: number; creditsUsed: number; monthCreditsUsed: number; usdUsed: number }
    >();
    const trackerStatsByProjectName = await getCreditTrackerProjectStats();

    for (const job of jobs) {
      if (!visibleProjectIds.has(job.projectId)) continue;
      const stats = jobStatsByProjectId.get(job.projectId) ?? { jobCount: 0, creditsUsed: 0, monthCreditsUsed: 0, usdUsed: 0 };
      const creditsUsed = creditsSpentForJob(job);
      const usdUsed = usdSpentForJob(job);
      const createdAt = new Date(job.completedAt ?? job.createdAt).getTime();

      stats.jobCount += 1;
      stats.creditsUsed = roundCredits(stats.creditsUsed + creditsUsed);
      stats.usdUsed = roundUsd(stats.usdUsed + usdUsed);

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
          usdUsed: jobStats?.usdUsed ?? trackerStats?.usdUsed ?? 0,
          spendLimitUsd: project.spendLimitUsd,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not scan project counts" });
  }
});

projectRouter.get("/api/projects/:projectId", (req, res) => {
  const user = getRequestUser(req);
  const project = getProject(req.params.projectId);
  if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
  res.json({ project });
});

projectRouter.get("/api/projects/:projectId/folders", async (req, res) => {
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

projectRouter.post("/api/projects", async (req, res) => {
  try {
    const user = getRequestUser(req);
    // The invite list from the create dialog is honored here. It used to be
    // overwritten with an owner-only list, so every project arrived with nobody
    // on it and the picker in the dialog was decoration.
    const memberInput = parseProjectMemberInput(req.body?.members, {
      ownerId: user.id,
      actorId: user.id,
      now: new Date().toISOString(),
      userExists: (userId) => Boolean(getUserById(userId)),
    });
    const memberError = projectMemberInputError(memberInput);
    if (memberError) return res.status(400).json({ error: memberError });

    const project = await createProject({
      ...(req.body ?? {}),
      ownerId: user.id,
      visibility: isProjectVisibility(req.body?.visibility) ? req.body.visibility : undefined,
      members: memberInput.members,
    });
    res.status(201).json({ project });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create project." });
  }
});

projectRouter.patch("/api/projects/:projectId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canManageProject(user, project)) return res.status(403).json({ error: "Project owner access required." });
    if (projectCodeChangeRequested(req.body, project)) return res.status(400).json({ error: "Project code cannot be changed." });
    if (projectRenameRequested(req.body, project)) {
      if (user.role !== "admin") return res.status(403).json({ error: "Admin permission required" });
      const renamed = await renameProject(
        project.id,
        {
          client: typeof req.body?.client === "string" ? req.body.client : undefined,
          name: typeof req.body?.name === "string" ? req.body.name : undefined,
        },
        user.id,
      );
      if (!renamed) return res.status(404).json({ error: "Project not found" });
    }

    let members: ProjectMember[] | undefined;
    if (Array.isArray(req.body?.members)) {
      const memberInput = parseProjectMemberInput(req.body.members, {
        ownerId: project.ownerId,
        actorId: user.id,
        now: new Date().toISOString(),
        userExists: (userId) => Boolean(getUserById(userId)),
      });
      const memberError = projectMemberInputError(memberInput);
      if (memberError) return res.status(400).json({ error: memberError });
      members = memberInput.members;
    }

    // The frontend PATCHes the whole project object on every save, so a spend-limit
    // value that merely rides along unchanged (e.g. while toggling visibility) must
    // not require admin -- only an actual change to the limit does.
    let nextSpendLimitUsd = project.spendLimitUsd;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "spendLimitUsd")) {
      const raw = req.body.spendLimitUsd;
      if (raw === null) {
        nextSpendLimitUsd = undefined;
      } else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        nextSpendLimitUsd = raw;
      } else {
        return res.status(400).json({ error: "Spend limit must be a non-negative number or null." });
      }
      if (nextSpendLimitUsd !== (project.spendLimitUsd ?? undefined) && user.role !== "admin") {
        return res.status(403).json({ error: "Admin permission required to change the spend limit." });
      }
    }

    const updated = await updateProject(project.id, {
      description: typeof req.body?.description === "string" ? req.body.description : undefined,
      visibility: isProjectVisibility(req.body?.visibility) ? req.body.visibility : undefined,
      members,
      groupMembers: Array.isArray(req.body?.groupMembers) ? req.body.groupMembers : undefined,
      spendLimitUsd: nextSpendLimitUsd,
    });
    if (!updated) return res.status(404).json({ error: "Project not found" });
    res.json({ project: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update project." });
  }
});

projectRouter.post("/api/projects/:projectId/folders", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const folder = await createProjectFolder(
      project.id,
      {
        name: typeof req.body?.name === "string" ? req.body.name : "",
        parentId: typeof req.body?.parentId === "string" ? req.body.parentId : null,
      },
      user.id,
    );
    if (!folder) return res.status(404).json({ error: "Project not found" });
    res.status(201).json({ folder, project: getProject(project.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create project folder." });
  }
});

projectRouter.patch("/api/projects/:projectId/folders/:folderId", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const folder = await renameProjectFolder(
      project.id,
      req.params.folderId,
      {
        name: typeof req.body?.name === "string" ? req.body.name : "",
      },
      user.id,
    );
    if (!folder) return res.status(404).json({ error: "Folder not found" });
    res.json({ folder, project: getProject(project.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not rename project folder." });
  }
});

projectRouter.delete("/api/projects/:projectId/folders/:folderId", requireAdmin, async (req, res) => {
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

projectRouter.patch("/api/projects/:projectId/jobs/:jobId", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const job = await renameJob(project.id, req.params.jobId, typeof req.body?.title === "string" ? req.body.title : "", user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not rename job." });
  }
});

projectRouter.patch("/api/projects/:projectId/jobs/:jobId/save-number", requireAdmin, async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    const job = await updateJobSaveNumber(project.id, req.params.jobId, req.body?.saveNumber ?? req.body?.value ?? "", user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update shot/camera number." });
  }
});

projectRouter.patch("/api/projects/:projectId/jobs/:jobId/folder", async (req, res) => {
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
    const destinationFolderId =
      typeof requestedFolderId === "string" && requestedFolderId.trim() ? requestedFolderId.trim() : null;
    const job = await moveJobResult(project.id, existing.id, destinationFolderId, user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not move result.";
    const status = /missing|already exists|not found|only completed|restore this result/i.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

projectRouter.post("/api/projects/:projectId/members", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canManageProject(user, project)) return res.status(403).json({ error: "Project owner access required." });

    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    if (!getUserById(userId)) return res.status(400).json({ error: `No such user: ${userId || "(none)"}.` });
    // An unrecognized role used to be silently downgraded to viewer, which read
    // as "added, but view-only" in the UI with no way to tell why. Let
    // addProjectMember reject it instead.
    const updated = await addProjectMember(req.params.projectId, {
      userId,
      role: req.body?.role,
      addedAt: new Date().toISOString(),
      addedBy: user.id,
    });
    if (!updated) return res.status(404).json({ error: "Project not found" });
    res.json({ project: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not add project member." });
  }
});

projectRouter.delete("/api/projects/:projectId/members/:userId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const project = getProject(req.params.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canManageProject(user, project)) return res.status(403).json({ error: "Project owner access required." });
    const updated = await removeProjectMember(req.params.projectId, req.params.userId);
    if (!updated) return res.status(404).json({ error: "Project not found" });
    res.json({ project: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not remove project member." });
  }
});
