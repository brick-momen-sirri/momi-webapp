// Credit-dashboard aggregation: the arithmetic and bucketing behind
// GET /api/credits/dashboard. Extracted from index.ts unchanged -- this was
// ~330 lines of pure date/credit math wedged between route handlers, which made
// both harder to read and left the math untested.

import { creditsSpentForAccounting, isCountedCreditUsage, isCreditExemptJob } from "./creditUsageAccounting.js";
import type { CreditTrackerProjectStats } from "./creditUsageService.js";
import { estimateWorkflowCredits } from "./creditEstimator.js";
import { currentMonthRange, getQueryValue } from "./httpQuery.js";
import { projectFolderName } from "./projectFolderName.js";
import { getJobs } from "./jobQueue.js";
import { canAccessJob } from "./jobPermissions.js";
import type { Job, Project, User } from "./types.js";
import { getWorkflowModel } from "./workflowService.js";

export function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

export function creditsSpentForJob(job: Job) {
  return creditsSpentForAccounting(job);
}

/**
 * Completed renders that drew real provider balance but appear in none of the
 * credit figures, because their pods return no usage (see isCreditExemptJob).
 *
 * Reported as counts so the dashboard can say what its numbers leave out. Only
 * completed runs count: a queued or failed one spent nothing worth reporting.
 */
export function countUncostedRuns(jobs: Job[], monthStart: Date, monthEnd: Date) {
  let uncostedRuns = 0;
  let uncostedMonthRuns = 0;

  for (const job of jobs) {
    if (!isCreditExemptJob(job) || job.status !== "completed") continue;
    uncostedRuns += 1;
    const timestamp = new Date(job.completedAt ?? job.startedAt ?? job.createdAt).getTime();
    if (Number.isFinite(timestamp) && timestamp >= monthStart.getTime() && timestamp < monthEnd.getTime()) {
      uncostedMonthRuns += 1;
    }
  }

  return { uncostedRuns, uncostedMonthRuns };
}

export type CreditDashboardGroup = {
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

export type CreditDashboardDay = {
  date: string;
  credits: number;
  usd: number;
  jobs: number;
};

export type CreditDashboardGranularity = "day" | "week" | "month";

export type CreditDashboardBucket = {
  key: string;
  label: string;
  startAt: string;
  endAt: string;
  credits: number;
  usd: number;
  jobs: number;
};

export type CreditDashboardBreakdownRow = {
  id: string;
  label: string;
  credits: number;
  usd: number;
  jobs: number;
  percentage: number;
  perBucket: number[];
};

export type CreditDashboardBreakdown = {
  project: CreditDashboardBreakdownRow[];
  user: CreditDashboardBreakdownRow[];
  model: CreditDashboardBreakdownRow[];
};

export type CreditDashboardRecentJob = {
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

export type CreditDashboardNodeRow = {
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

export type CreditDashboardAnomaly = {
  id: string;
  type: "run_high" | "expected_overrun" | "daily_high";
  severity: "warning" | "critical";
  message: string;
  jobId?: string;
  date?: string;
  credits: number;
  threshold: number;
};

export function usdSpentForJob(job: Job) {
  if (!isCountedCreditUsage(job.creditUsage)) return 0;
  const direct = Number(job.creditUsage?.total_estimated_usd ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const rows = job.creditUsage?.rows ?? [];
  return rows.reduce((sum, row) => {
    const value = Number(row.total_estimated_usd ?? 0);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
}

export function roundUsd(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function expectedCreditsForJob(job: Job) {
  const model = getWorkflowModel(job.modelId);
  if (model) {
    const currentEstimate = estimateWorkflowCredits(model, job.durationSeconds, job.resolution, job.workflowOptions);
    if (Number.isFinite(currentEstimate) && currentEstimate > 0) return currentEstimate;
  }
  const storedEstimate = Number(job.creditsEstimated ?? 0);
  return Number.isFinite(storedEstimate) && storedEstimate > 0 ? storedEstimate : 0;
}

export function resolutionLabel(job: Job) {
  if (!job.resolution) return "";
  return job.resolution.label || `${job.resolution.width} x ${job.resolution.height}`;
}

export function runDurationSeconds(job: Job) {
  const start = new Date(job.startedAt ?? "").getTime();
  const end = new Date(job.completedAt ?? "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.round((end - start) / 1000);
}

export function creditDashboardRange(query: Record<string, unknown>, now: Date) {
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

export function parseDateOnly(value: string, fallback: Date) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(date.getTime()) ? date : fallback;
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function daysBetween(startAt: Date, endAt: Date) {
  return Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / 86400000));
}

export function fillDailyRange(startAt: Date, endAt: Date, rows: Map<string, CreditDashboardDay>) {
  const output: CreditDashboardDay[] = [];
  const maxDays = Math.min(120, daysBetween(startAt, endAt));
  const start = addDays(endAt, -maxDays);
  for (let date = startOfDay(start); date < endAt; date = addDays(date, 1)) {
    const key = dayKey(date);
    output.push(rows.get(key) ?? { date: key, credits: 0, usd: 0, jobs: 0 });
  }
  return output;
}

// Day/week/month bucketing for the spend pivot. byDay above stays as-is for the
// daily chart; these build the same period totals at a chosen granularity and,
// unlike the old client-side grouping over the capped `recent` list, they see
// every usage event in the range.

const MAX_BUCKETS = 120;
const MAX_BREAKDOWN_ROWS = 8;
const OTHER_ROW_ID = "__other__";
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function creditDashboardGranularity(
  query: Record<string, unknown>,
  startAt: Date,
  endAt: Date,
): CreditDashboardGranularity {
  const requested = getQueryValue(query.granularity);
  if (requested === "day" || requested === "week" || requested === "month") return requested;
  return defaultGranularity(startAt, endAt);
}

// A 30-day range at day granularity is 30 columns nobody can read. Widen the
// bucket as the range grows; an explicit ?granularity= always wins.
export function defaultGranularity(startAt: Date, endAt: Date): CreditDashboardGranularity {
  const days = daysBetween(startAt, endAt);
  if (days <= 14) return "day";
  if (days <= 92) return "week";
  return "month";
}

// Weeks are ISO: Monday start.
export function bucketStart(date: Date, granularity: CreditDashboardGranularity) {
  const day = startOfDay(date);
  if (granularity === "day") return day;
  if (granularity === "week") return addDays(day, -((day.getDay() + 6) % 7));
  return new Date(day.getFullYear(), day.getMonth(), 1);
}

export function nextBucketStart(date: Date, granularity: CreditDashboardGranularity) {
  if (granularity === "day") return addDays(date, 1);
  if (granularity === "week") return addDays(date, 7);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

export function previousBucketStart(date: Date, granularity: CreditDashboardGranularity) {
  if (granularity === "day") return addDays(date, -1);
  if (granularity === "week") return addDays(date, -7);
  return new Date(date.getFullYear(), date.getMonth() - 1, 1);
}

export function bucketKey(date: Date, granularity: CreditDashboardGranularity) {
  const start = bucketStart(date, granularity);
  if (granularity === "day") return dayKey(start);
  if (granularity === "week") return isoWeekKey(start);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
}

export function bucketLabel(start: Date, granularity: CreditDashboardGranularity) {
  if (granularity === "day") return `${MONTH_LABELS[start.getMonth()]} ${String(start.getDate()).padStart(2, "0")}`;
  if (granularity === "week") {
    const end = addDays(start, 6);
    return `${MONTH_LABELS[start.getMonth()]} ${start.getDate()} - ${MONTH_LABELS[end.getMonth()]} ${end.getDate()}`;
  }
  return `${MONTH_LABELS[start.getMonth()]} ${start.getFullYear()}`;
}

// The ISO week-numbering year is the year of that week's Thursday, which is why
// early January can belong to the previous year's week 52/53.
export function isoWeekKey(date: Date) {
  const thursday = addDays(bucketStart(date, "week"), 3);
  const isoYear = thursday.getFullYear();
  const firstThursday = addDays(bucketStart(new Date(isoYear, 0, 4), "week"), 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// Walks back from the end of the range so a wide custom range costs at most
// MAX_BUCKETS iterations, and keeps the most recent buckets when it truncates
// -- same trade fillDailyRange makes.
export function buildCreditBuckets(startAt: Date, endAt: Date, granularity: CreditDashboardGranularity) {
  const floor = bucketStart(startAt, granularity);
  const starts: Date[] = [];
  for (
    let cursor = bucketStart(addDays(endAt, -1), granularity);
    cursor >= floor && starts.length < MAX_BUCKETS;
    cursor = previousBucketStart(cursor, granularity)
  ) {
    starts.push(cursor);
  }
  return starts.reverse().map((start) => ({
    key: bucketKey(start, granularity),
    label: bucketLabel(start, granularity),
    startAt: start.toISOString(),
    endAt: nextBucketStart(start, granularity).toISOString(),
    credits: 0,
    usd: 0,
    jobs: 0,
  }));
}

// One pass over every usage event in the range produces both the bucket totals
// and the per-dimension rows, so the chart and the pivot cannot disagree.
export function buildCreditPivot(
  events: CreditDashboardRecentJob[],
  startAt: Date,
  endAt: Date,
  granularity: CreditDashboardGranularity,
) {
  const buckets = buildCreditBuckets(startAt, endAt, granularity);
  const indexByKey = new Map(buckets.map((bucket, index) => [bucket.key, index]));
  const project = new Map<string, CreditDashboardBreakdownRow>();
  const user = new Map<string, CreditDashboardBreakdownRow>();
  const model = new Map<string, CreditDashboardBreakdownRow>();

  for (const event of events) {
    const timestamp = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;
    const index = indexByKey.get(bucketKey(new Date(timestamp), granularity));
    if (index === undefined) continue;
    const bucket = buckets[index];
    bucket.credits = roundCredits(bucket.credits + event.credits);
    bucket.usd = roundUsd(bucket.usd + event.usd);
    bucket.jobs += 1;
    addBreakdownRow(project, event.projectId, event.projectName, index, buckets.length, event);
    addBreakdownRow(user, event.userId, event.userName, index, buckets.length, event);
    addBreakdownRow(model, event.modelId, event.modelName, index, buckets.length, event);
  }

  return {
    buckets,
    breakdown: {
      project: collapseBreakdown(project, buckets.length),
      user: collapseBreakdown(user, buckets.length),
      model: collapseBreakdown(model, buckets.length),
    },
  };
}

function addBreakdownRow(
  map: Map<string, CreditDashboardBreakdownRow>,
  id: string,
  label: string,
  index: number,
  bucketCount: number,
  event: CreditDashboardRecentJob,
) {
  const key = id || label;
  const current = map.get(key) ?? {
    id: key,
    label,
    credits: 0,
    usd: 0,
    jobs: 0,
    percentage: 0,
    perBucket: new Array<number>(bucketCount).fill(0),
  };
  current.credits = roundCredits(current.credits + event.credits);
  current.usd = roundUsd(current.usd + event.usd);
  current.jobs += 1;
  current.perBucket[index] = roundCredits(current.perBucket[index] + event.credits);
  map.set(key, current);
}

// Bounded payload: the top rows by spend, everything else folded into one
// "Other" row that still carries its own per-bucket series so column totals add up.
function collapseBreakdown(map: Map<string, CreditDashboardBreakdownRow>, bucketCount: number) {
  const rows = Array.from(map.values()).sort((a, b) => b.credits - a.credits || a.label.localeCompare(b.label));
  const total = rows.reduce((sum, row) => sum + row.credits, 0);
  const visible = rows.slice(0, MAX_BREAKDOWN_ROWS);
  const rest = rows.slice(MAX_BREAKDOWN_ROWS);

  if (rest.length) {
    visible.push({
      id: OTHER_ROW_ID,
      label: `Other (${rest.length})`,
      credits: roundCredits(rest.reduce((sum, row) => sum + row.credits, 0)),
      usd: roundUsd(rest.reduce((sum, row) => sum + row.usd, 0)),
      jobs: rest.reduce((sum, row) => sum + row.jobs, 0),
      percentage: 0,
      perBucket: Array.from({ length: bucketCount }, (_, index) =>
        roundCredits(rest.reduce((sum, row) => sum + row.perBucket[index], 0)),
      ),
    });
  }

  return visible.map((row) => ({
    ...row,
    percentage: total > 0 ? Math.round((row.credits / total) * 1000) / 10 : 0,
  }));
}

export function creditAnomalies(
  events: CreditDashboardRecentJob[],
  byDay: Map<string, CreditDashboardDay>,
): CreditDashboardAnomaly[] {
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

export function addGroup(map: Map<string, CreditDashboardGroup>, id: string, label: string, event: CreditDashboardRecentJob) {
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

export function addDay(map: Map<string, CreditDashboardDay>, date: string, credits: number, usd: number) {
  const current = map.get(date) ?? { date, credits: 0, usd: 0, jobs: 0 };
  current.credits = roundCredits(current.credits + credits);
  current.usd = roundUsd(current.usd + usd);
  current.jobs += 1;
  map.set(date, current);
}

export function sortedGroups(map: Map<string, CreditDashboardGroup>) {
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

export function dayKey(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function stringField(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function findCreditTrackerProjectStats(project: Project, statsByProjectName: Map<string, CreditTrackerProjectStats>) {
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

export function projectStatNameCandidates(project: Project) {
  const folderName = project.folderName || projectFolderName(project.folderPath);
  return [
    folderName,
    `${project.shortName}_${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    `${project.shortName}_${project.name}`,
    project.name,
    project.shortName,
  ].filter(Boolean);
}

export function normalizeProjectStatName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Per-user credit spend for the current calendar month, scoped to the jobs the
// caller may see. Shared by GET /api/usage/monthly and the aggregated snapshot.
export function monthlyUsageForUser(currentUser: User) {
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

  return {
    month,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    users: Array.from(users.values()).sort((a, b) => b.creditsSpent - a.creditsSpent),
  };
}
