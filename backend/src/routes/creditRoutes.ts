// Credit balance, monthly usage, and the credit dashboard. The dashboard's
// arithmetic lives in creditDashboardService.ts.

import express from "express";
import { getRequestUser } from "../authMiddleware.js";
import { getUserById } from "../authService.js";
import {
  monthlyUsageForUser,
  type CreditDashboardDay,
  type CreditDashboardGroup,
  type CreditDashboardNodeRow,
  type CreditDashboardRecentJob,
  addDay,
  addDays,
  addGroup,
  buildCreditPivot,
  countUncostedRuns,
  creditAnomalies,
  creditDashboardGranularity,
  creditDashboardRange,
  creditsSpentForJob,
  daysBetween,
  expectedCreditsForJob,
  fillDailyRange,
  resolutionLabel,
  roundCredits,
  roundUsd,
  runDurationSeconds,
  sortedGroups,
  startOfDay,
  stringField,
  usdSpentForJob,
} from "../creditDashboardService.js";
import { getCredits } from "../creditService.js";
import { creditAccountingSource, isCountedCreditUsage } from "../creditUsageAccounting.js";
import { currentMonthRange } from "../httpQuery.js";
import { canAccessJob } from "../jobPermissions.js";
import { getJobs } from "../jobQueue.js";
import { getProject } from "../projectService.js";

export const creditRouter = express.Router();

creditRouter.get("/api/credits", async (_req, res) => {
  res.json(await getCredits());
});

creditRouter.get("/api/usage/monthly", (req, res) => {
  res.json(monthlyUsageForUser(getRequestUser(req)));
});

creditRouter.get("/api/credits/dashboard", (req, res) => {
  const currentUser = getRequestUser(req);
  const visibleJobs = getJobs()
    .filter((job) => canAccessJob(currentUser, job))
    .filter((job) => job.source !== "existing_project_media");
  const now = new Date();
  const range = creditDashboardRange(req.query, now);
  const granularity = creditDashboardGranularity(req.query, range.startAt, range.endAt);
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
    // What every figure above leaves out: renders that drew real provider
    // balance but report no usage, so the dashboard can say so rather than
    // quietly under-reporting.
    ...countUncostedRuns(visibleJobs, monthStart, monthEnd),
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
  const pivot = buildCreditPivot(periodUsageEvents, range.startAt, range.endAt, granularity);
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
      if (!Number.isFinite(rowTimestamp) || rowTimestamp < range.startAt.getTime() || rowTimestamp >= range.endAt.getTime())
        continue;
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
      granularity,
      byProject: sortedGroups(byProject),
      byUser: sortedGroups(byUser),
      byModel: sortedGroups(byModel),
      byDay: fillDailyRange(range.startAt, range.endAt, byDay),
      buckets: pivot.buckets,
      breakdown: pivot.breakdown,
      anomalies: creditAnomalies(periodEvents, byDay),
      recent: periodEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 500),
      nodeRows: nodeRows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 500),
    },
  });
});
