import type {
  BackendCreditDashboardAnomaly,
  BackendCreditDashboardDay,
  BackendCreditDashboardGroup,
  BackendCreditDashboardRecentJob,
} from "../../services/backendApi";

export type TimePreset = "today" | "last7" | "last30" | "thisMonth" | "lastMonth" | "custom";
export type ChartGroupBy = "total" | "project" | "user" | "workflow";
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

const chartColors = ["#14b8a6", "#f97316", "#6366f1", "#e11d48", "#84cc16", "#0ea5e9", "#a855f7"];

export function dashboardRangeParams(range: TimePreset, from: string, to: string) {
  return {
    range,
    from: range === "custom" ? from : undefined,
    to: range === "custom" ? to : undefined,
  };
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

export function buildChartRows(
  days: BackendCreditDashboardDay[],
  events: BackendCreditDashboardRecentJob[],
  groupBy: ChartGroupBy,
) {
  if (groupBy === "total") {
    return {
      legend: [{ label: "Total", color: chartColors[0] }],
      rows: days.map((day) => ({
        date: day.date,
        total: day.credits,
        segments: day.credits > 0 ? [{ label: "Total", credits: day.credits, color: chartColors[0] }] : [],
      })),
    };
  }

  const totals = new Map<string, number>();
  const byDay = new Map<string, Map<string, number>>();
  const seenJobIds = new Set<string>();
  for (const event of events) {
    if (!Number.isFinite(event.credits) || event.credits <= 0 || !isValidTimestamp(event.timestamp)) continue;
    const jobId = typeof event.jobId === "string" ? event.jobId.trim() : "";
    if (jobId && seenJobIds.has(jobId)) continue;
    if (jobId) seenJobIds.add(jobId);
    const date = event.timestamp.slice(0, 10);
    const label = chartLabel(event, groupBy);
    totals.set(label, roundCredits((totals.get(label) ?? 0) + event.credits));
    const dayMap = byDay.get(date) ?? new Map<string, number>();
    dayMap.set(label, roundCredits((dayMap.get(label) ?? 0) + event.credits));
    byDay.set(date, dayMap);
  }

  const topLabels = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label]) => label);
  const hasOther = Array.from(totals.keys()).some((label) => !topLabels.includes(label));
  const legend = [...topLabels, ...(hasOther ? ["Other"] : [])].map((label, index) => ({
    label,
    color: chartColors[index % chartColors.length],
  }));

  return {
    legend,
    rows: days.map((day) => {
      const dayMap = byDay.get(day.date);
      const segments = topLabels
        .map((label, index) => ({
          label,
          credits: dayMap?.get(label) ?? 0,
          color: chartColors[index % chartColors.length],
        }))
        .filter((segment) => segment.credits > 0);
      const knownCredits = segments.reduce((sum, segment) => sum + segment.credits, 0);
      const otherCredits = Math.max(0, roundCredits(day.credits - knownCredits));
      if (otherCredits > 0) {
        segments.push({
          label: "Other",
          credits: otherCredits,
          color: chartColors[topLabels.length % chartColors.length],
        });
      }
      return { date: day.date, total: day.credits, segments };
    }),
  };
}

function chartLabel(event: BackendCreditDashboardRecentJob, groupBy: ChartGroupBy) {
  if (groupBy === "project") return cleanLabel(event.projectName, "Unknown project");
  if (groupBy === "user") return cleanLabel(event.userName, "Unknown user");
  return cleanLabel(event.modelName, "Unknown workflow");
}

function cleanLabel(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isValidTimestamp(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(new Date(value).getTime());
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
    job.status,
    job.resolution,
    job.runDurationSeconds ?? "",
    job.jobId,
  ]);
  return [headers, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function exportRecentCsv(rows: BackendCreditDashboardRecentJob[]) {
  const blob = new Blob([recentJobsCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `credit-events-${toDateInput(new Date())}.csv`;
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
