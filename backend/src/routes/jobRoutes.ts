// The job lifecycle: list, create, retry, cancel, archive, restore, delete, and
// the status/result reads the client polls.

import express from "express";
import { getRequestUser } from "../authMiddleware.js";
import { httpStatusFromError } from "../httpError.js";
import { getQueryValue, parseBooleanQuery, parseOptionalNumber, parsePaginationNumber } from "../httpQuery.js";
import { filterJobs } from "../jobFilters.js";
import { validateJobMediaReferences } from "../jobMediaValidation.js";
import {
  canAccessJob,
  canCreateJobInProject,
  canManageJob,
  canViewProject,
  filterJobsForUser,
  getVisibleJobForResult,
  isDemoAccount,
} from "../jobPermissions.js";
import {
  archiveJob,
  cancelJob,
  createCompletedStillImageEditJob,
  createJob,
  createJobIdempotent,
  getJob,
  getJobFromAnySource,
  getJobsWithExistingMedia,
  permanentlyDeleteArchivedJob,
  restoreArchivedJob,
} from "../jobQueue.js";
import { createJobSubmissionHandler } from "../jobSubmissionRoute.js";
import { getProject } from "../projectService.js";
import { parseFinalizeStillImageEditRequest } from "../stillImageEditFinalization.js";
import { getWorkflowModel } from "../workflowService.js";

export const jobRouter = express.Router();

jobRouter.get("/api/jobs", async (req, res) => {
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
      section: getQueryValue(req.query.section),
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

jobRouter.get("/api/jobs/:jobId", (req, res) => {
  const user = getRequestUser(req);
  const job = getJob(req.params.jobId);
  if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });
  res.json({ job });
});

jobRouter.post(
  "/api/jobs",
  createJobSubmissionHandler({
    getProject,
    getWorkflowModel,
    canViewProject,
    canCreateJobInProject,
    isDemoAccount,
    validateMedia: validateJobMediaReferences,
    createJob: createJobIdempotent,
  }),
);

jobRouter.post("/api/still-image-edits/finalize", async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (isDemoAccount(user)) {
      return res.status(403).json({ error: "Demo accounts are view-only and cannot finalize edits." });
    }
    const request = parseFinalizeStillImageEditRequest(req.body);
    const project = getProject(request.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canCreateJobInProject(user, project)) return res.status(403).json({ error: "Project editor access required." });

    await validateJobMediaReferences(
      {
        projectId: project.id,
        modelId: "still_image-editing",
        inputImages: [
          request.originalSourceUrl,
          ...request.layers.flatMap((layer) => [layer.generatedCropUrl, layer.maskSourceUrl]),
        ],
        userId: user.id,
      },
      project,
      user,
    );
    const job = await createCompletedStillImageEditJob({ ...request, userId: user.id });
    res.status(201).json({ job });
  } catch (error) {
    res.status(httpStatusFromError(error, 400)).json({
      error: error instanceof Error ? error.message : "Could not finalize the edited composite.",
    });
  }
});

jobRouter.post("/api/jobs/:jobId/retry", async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (isDemoAccount(user)) {
      return res.status(403).json({ error: "Demo accounts are view-only and cannot generate tasks." });
    }
    const previous = getJob(req.params.jobId);
    if (!previous || !canAccessJob(user, previous)) return res.status(404).json({ error: "Job not found" });
    if (previous.status !== "failed" && previous.status !== "canceled") {
      return res.status(409).json({ error: "Only failed or canceled jobs can be retried." });
    }
    const project = getProject(previous.projectId);
    if (!project || !canViewProject(user, project)) return res.status(404).json({ error: "Project not found" });
    if (!canCreateJobInProject(user, project)) return res.status(403).json({ error: "Project editor access required." });

    // Requeue from the stored spec. Input media are already externalized to
    // local files, so they pass through createJob unchanged (no re-upload).
    const job = await createJob({
      projectId: previous.projectId,
      targetFolderId: previous.folderId ?? null,
      modelId: previous.modelId,
      prompt: previous.prompt,
      resolution: previous.resolution,
      durationSeconds: previous.durationSeconds,
      inputImages: previous.inputImages,
      inputVideo: previous.inputVideo,
      workflowOptions: previous.workflowOptions,
      userId: user.id,
    });
    res.status(201).json({ job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not retry job" });
  }
});

jobRouter.post("/api/jobs/:jobId/cancel", async (req, res) => {
  const user = getRequestUser(req);
  const existing = getJob(req.params.jobId);
  if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Job not found" });
  if (!canManageJob(user, existing))
    return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
  const job = await cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ job });
});

jobRouter.post("/api/jobs/:jobId/archive", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const existing = await getJobFromAnySource(req.params.jobId);
    if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Job not found" });
    if (!canManageJob(user, existing))
      return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    const job = await archiveJob(req.params.jobId, user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    res.status(httpStatusFromError(error, 500)).json({ error: error instanceof Error ? error.message : "Could not archive job" });
  }
});

jobRouter.post("/api/jobs/:jobId/restore", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const existing = await getJobFromAnySource(req.params.jobId, { archived: true });
    if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Archived job not found" });
    if (!canManageJob(user, existing))
      return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    const job = await restoreArchivedJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Archived job not found" });
    res.json({ job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not restore job" });
  }
});

jobRouter.delete("/api/jobs/:jobId/permanent", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const existing = await getJobFromAnySource(req.params.jobId, { archived: true });
    if (!existing || !canAccessJob(user, existing)) return res.status(404).json({ error: "Archived job not found" });
    if (!canManageJob(user, existing))
      return res.status(403).json({ error: "You can only manage your own jobs unless you own the project." });
    const job = await permanentlyDeleteArchivedJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Archived job not found" });
    res.json({ job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not permanently delete job" });
  }
});

jobRouter.get("/api/jobs/:jobId/status", (req, res) => {
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

jobRouter.get("/api/jobs/:jobId/result", (req, res) => {
  void (async () => {
    const user = getRequestUser(req);
    const job = await getVisibleJobForResult(req.params.jobId, user);
    if (!job || !canAccessJob(user, job)) return res.status(404).json({ error: "Job not found" });
    res.json({ resultUrls: job.resultUrls, thumbnailUrls: job.thumbnailUrls, status: job.status });
  })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "Could not read job result" }));
});
