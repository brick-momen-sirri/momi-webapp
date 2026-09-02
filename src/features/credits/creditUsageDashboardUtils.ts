import type {
  BackendCreditDashboard,
  BackendCreditDashboardAnomaly,
  BackendCreditDashboardBreakdown,
  BackendCreditDashboardBreakdownRow,
  BackendCreditDashboardBucket,
  BackendCreditDashboardDay,
  BackendCreditDashboardGranularity,
  BackendCreditDashboardGroup,
  BackendCreditDashboardRecentJob,
} from "../../services/backendApi";

export type TimePreset = "today" | "last7" | "last30" | "thisMonth" | "lastMonth" | "custom";
export type ChartGroupBy = "total" | PivotDimension;
export type PivotDimension = "model" | "project" | "user";
export type SortKey = "timestamp" | "project" | "user" | "workflow" | "credits" | "usd" | "status" | "resolution" | "duration";
export type SortDirection = "asc" | "desc";

export type DisplayAnomaly =
  | BackendCreditDashboardAnomaly
  | {
      id: string;
      type: "low_remaining";
      severity: "warning" | "critical";
      message: string;
      credits: number;
      threshold: number;
    };

const chartColors = ["#14b8a6", "#f97316", "#6366f1", "#e11d48", "#84cc16", "#0ea5e9", "#a855f7", "#f59e0b"];
const OTHER_ROW_ID = "__other__";
const OTHER_COLOR = "#94a3b8";

export function dashboardRangeParams(
  range: TimePreset,
  from: string,
  to: string,
  granularity?: BackendCreditDashboardGranularity | null,
) {
  return {
    range,
    from: range === "custom" ? from : undefined,
    to: range === "custom" ? to : undefined,
    granularity: granularity ?? undefined,
  };
}

// The server folds everything past the top rows into one synthetic row. It has
// no id to match events against and is not a category, so it neither takes a
// category colour nor supports drill-down.
export function isOtherRow(row: BackendCreditDashboardBreakdownRow) {
  return row.id === OTHER_ROW_ID;
}

export function breakdownColor(row: BackendCreditDashboardBreakdownRow, index: number) {
  return isOtherRow(row) ? OTHER_COLOR : chartColors[index % chartColors.length];
}

export function buildDisplayAnomalies(
  anomalies: BackendCreditDashboardAnomaly[],
  creditsRemaining: number,
  burnRateCreditsPerDay: number,
): DisplayAnomaly[] {
  const output: DisplayAnomaly[] = [...anomalies];
  const threshold = burnRateCreditsPerDay > 0 ? Math.max(100, burnRateCreditsPerDay * 3) : 100;
  if (creditsRemaining <= threshold) {
    output.unshift({
      id: "low-remaining",
      type: "low_remaining",
      severity: creditsRemaining <= threshold / 2 ? "critical" : "warning",
      message:
        burnRateCreditsPerDay > 0
          ? "Remaining credits are low compared with the current burn rate."
          : "Remaining credits are low.",
      credits: creditsRemaining,
      threshold: roundCredits(threshold),
    });
  }
  return output;
}

// The frontend is served by vite and goes live the moment src/ changes, while
// the backend only picks this up once dist is rebuilt and pm2 reloads. For that
// window the API still answers without buckets, so fall back to the daily series
// rather than blanking the dashboard on a missing field.
export function withPivotFallback(dashboard: BackendCreditDashboard): BackendCreditDashboard {
  if (dashboard.buckets && dashboard.breakdown && dashboard.granularity) return dashboard;
  return {
    ...dashboard,
    granularity: dashboard.granularity ?? "day",
    buckets: dashboard.buckets ?? (dashboard.byDay ?? []).map(dayAsBucket),
    // No per-dimension series exists in the old payload; the Total chart still
    // works and the pivot shows its empty state instead of wrong numbers.
    breakdown: dashboard.breakdown ?? { project: [], user: [], model: [] },
  };
}

function dayAsBucket(day: BackendCreditDashboardDay): BackendCreditDashboardBucket {
  const [year, month, date] = day.date.split("-").map(Number);
  const startAt = new Date(year, (month || 1) - 1, date || 1);
  return {
    key: day.date,
    label: `${monthLabels[startAt.getMonth()] ?? ""} ${String(startAt.getDate()).padStart(2, "0")}`.trim(),
    startAt: startAt.toISOString(),
    endAt: addDays(startAt, 1).toISOString(),
    credits: day.credits,
    usd: day.usd,
    jobs: day.jobs,
  };
}

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Both the chart and the pivot read the server's buckets and breakdown, so they
// cannot disagree. This used to be re-aggregated in the browser from the recent
// event list, which the API caps at 500 rows -- past that cap the stacked
// segments quietly under-reported while the Total view stayed correct.
export function buildBucketChartRows(
  buckets: BackendCreditDashboardBucket[],
  breakdown: BackendCreditDashboardBreakdown,
  groupBy: ChartGroupBy,
) {
  if (groupBy === "total") {
    const hasSourceSplit = buckets.some((bucket) => bucket.podCredits !== undefined || bucket.comfyCredits !== undefined);
    return {
      legend: hasSourceSplit
        ? [
            { label: "RunPod", color: chartColors[0] },
            { label: "Comfy", color: chartColors[1] },
          ]
        : [{ label: "Total", color: chartColors[0] }],
      rows: buckets.map((bucket) => {
        const segments = hasSourceSplit
          ? [
              { label: "RunPod", credits: finiteNumber(bucket.podCredits), color: chartColors[0] },
              { label: "Comfy", credits: finiteNumber(bucket.comfyCredits), color: chartColors[1] },
            ].filter((segment) => segment.credits > 0)
          : bucket.credits > 0
            ? [{ label: "Total", credits: bucket.credits, color: chartColors[0] }]
            : [];
        return { key: bucket.key, label: bucket.label, total: bucket.credits, segments };
      }),
    };
  }

  const rows = breakdown[groupBy] ?? [];
  return {
    legend: rows.map((row, index) => ({ label: row.label, color: breakdownColor(row, index) })),
    rows: buckets.map((bucket, bucketIndex) => ({
      key: bucket.key,
      label: bucket.label,
      total: bucket.credits,
      segments: rows
        .map((row, index) => ({
          label: row.label,
          credits: row.perBucket[bucketIndex] ?? 0,
          color: breakdownColor(row, index),
        }))
        .filter((segment) => segment.credits > 0),
    })),
  };
}

// Tint strength for a pivot cell, scaled against the largest cell in the table
// so one spike does not flatten every other cell to white.
export function pivotCellTint(credits: number, maxCellCredits: number) {
  if (!Number.isFinite(credits) || credits <= 0 || maxCellCredits <= 0) return 0;
  return Math.min(1, Math.max(0.06, credits / maxCellCredits));
}

export function maxPivotCell(rows: BackendCreditDashboardBreakdownRow[]) {
  let max = 0;
  for (const row of rows) {
    for (const credits of row.perBucket) if (credits > max) max = credits;
  }
  return max;
}

export function bucketTotals(buckets: BackendCreditDashboardBucket[]) {
  return {
    credits: roundCredits(buckets.reduce((sum, bucket) => sum + bucket.credits, 0)),
    usd: buckets.reduce((sum, bucket) => sum + bucket.usd, 0),
    jobs: buckets.reduce((sum, bucket) => sum + bucket.jobs, 0),
  };
}

export const pivotDimensionLabels: Record<PivotDimension, string> = {
  model: "Model",
  project: "Project",
  user: "User",
};

export const granularityLabels: Record<BackendCreditDashboardGranularity, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

// Does the event belong to the cell the user clicked? The bucket window comes
// from the server so week boundaries match the column exactly.
export function matchesPivotCell(
  job: BackendCreditDashboardRecentJob,
  dimension: PivotDimension,
  rowId: string,
  bucket: BackendCreditDashboardBucket,
) {
  const field = dimension === "project" ? job.projectId : dimension === "user" ? job.userId : job.modelId;
  if (field !== rowId) return false;
  const timestamp = new Date(job.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= new Date(bucket.startAt).getTime() && timestamp < new Date(bucket.endAt).getTime();
}

export function filterRecentJobs(rows: BackendCreditDashboardRecentJob[], search: string, statusFilter: string) {
  const query = search.trim().toLowerCase();
  return rows.filter((job) => {
    if (statusFilter !== "all" && job.status !== statusFilter) return false;
    if (!query) return true;
    return [job.jobId, job.projectName, job.userName, job.modelName, job.status, job.resolution].some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query),
    );
  });
}

export function sortRecentJobs(rows: BackendCreditDashboardRecentJob[], sortKey: SortKey, direction: SortDirection) {
  const directionMultiplier = direction === "desc" ? -1 : 1;
  return rows
    .map((job, sourceIndex) => ({ job, sourceIndex }))
    .sort((a, b) => {
      const left = recentSortValue(a.job, sortKey);
      const right = recentSortValue(b.job, sortKey);
      const comparison =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left ?? "").localeCompare(String(right ?? ""));
      return comparison === 0 ? a.sourceIndex - b.sourceIndex : comparison * directionMultiplier;
    })
    .map(({ job }) => job);
}

function recentSortValue(job: BackendCreditDashboardRecentJob, sortKey: SortKey) {
  if (sortKey === "timestamp") return new Date(job.timestamp).getTime() || 0;
  if (sortKey === "project") return job.projectName;
  if (sortKey === "user") return job.userName;
  if (sortKey === "workflow") return job.modelName;
  if (sortKey === "credits") return finiteNumber(job.credits);
  if (sortKey === "usd") return finiteNumber(job.usd);
  if (sortKey === "status") return job.status;
  if (sortKey === "resolution") return job.resolution;
  return finiteNumber(job.runDurationSeconds);
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function recentJobsCsv(rows: BackendCreditDashboardRecentJob[]) {
  const headers = [
    "timestamp",
    "project",
    "user",
    "workflow",
    "credits",
    "cost",
    "runpod_credits",
    "runpod_cost",
    "comfy_credits",
    "comfy_cost",
    "status",
    "resolution",
    "duration_seconds",
    "job_id",
  ];
  const body = rows.map((job) => [
    job.timestamp,
    job.projectName,
    job.userName,
    job.modelName,
    job.credits,
    job.usd,
    job.podCredits ?? "",
    job.podUsd ?? "",
    job.comfyCredits ?? "",
    job.comfyUsd ?? "",
    job.status,
    job.resolution,
    job.runDurationSeconds ?? "",
    job.jobId,
  ]);
  return [headers, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

// One row per entity, one column per bucket -- the same grid that is on screen,
// so a spreadsheet pivot does not have to be rebuilt from the raw event export.
export function pivotCsv(
  buckets: BackendCreditDashboardBucket[],
  rows: BackendCreditDashboardBreakdownRow[],
  dimension: PivotDimension,
) {
  const headers = [pivotDimensionLabels[dimension], ...buckets.map((bucket) => bucket.label), "Total", "Share %", "Cost"];
  const body = rows.map((row) => [row.label, ...row.perBucket, row.credits, row.percentage, row.usd]);
  const totals = bucketTotals(buckets);
  const footer = [
    "Total",
    ...buckets.map((bucket) => bucket.credits),
    totals.credits,
    rows.length ? 100 : 0,
    Math.round(totals.usd * 10000) / 10000,
  ];
  return [headers, ...body, footer].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function exportPivotCsv(
  buckets: BackendCreditDashboardBucket[],
  rows: BackendCreditDashboardBreakdownRow[],
  dimension: PivotDimension,
) {
  downloadCsv(pivotCsv(buckets, rows, dimension), `credit-spend-by-${dimension}-${toDateInput(new Date())}.csv`);
}

export function exportRecentCsv(rows: BackendCreditDashboardRecentJob[]) {
  downloadCsv(recentJobsCsv(rows), `credit-events-${toDateInput(new Date())}.csv`);
}

function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export function formatCredits(value: number | undefined) {
  if (!Number.isFinite(value)) return "0";
  const safeValue = Number(value);
  if (Math.abs(safeValue) >= 1000) return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(safeValue);
  if (Number.isInteger(safeValue)) return String(safeValue);
  return safeValue.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

export function formatUsd(value: number | undefined) {
  if (!Number.isFinite(value) || Number(value) <= 0) return "$0";
  return `$${Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function formatPercent(value: number | undefined) {
  if (!Number.isFinite(value)) return "0%";
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)}%`;
}

export function formatExpectedDelta(row: BackendCreditDashboardGroup) {
  if (!row.expectedCredits) return "No expected price";
  const delta = finiteNumber(row.actualVsExpectedCredits);
  const prefix = delta > 0 ? "+" : "";
  return `${formatCredits(row.expectedCredits)} expected / ${prefix}${formatCredits(delta)} cr`;
}

export function formatDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds) || !seconds) return "-";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function formatDays(days: number | null) {
  if (!Number.isFinite(days) || days == null) return "-";
  if (days < 1) return "<1 day";
  if (days > 365) return "365+ days";
  return `${Math.round(days)} days`;
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function toDateInput(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
