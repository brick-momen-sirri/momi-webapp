import { BarChart3, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { BackendCreditDashboard, BackendCreditDashboardGranularity } from "../../services/backendApi";
import {
  buildBucketChartRows,
  buildDisplayAnomalies,
  filterRecentJobs,
  formatCredits,
  formatDays,
  formatUsd,
  matchesPivotCell,
  pivotDimensionLabels,
  sortRecentJobs,
  type ChartGroupBy,
  type PivotDimension,
  type SortDirection,
  type SortKey,
} from "../../features/credits/creditUsageDashboardUtils";
import { CreditSpendPivot, type PivotCell } from "./CreditSpendPivot";
import { AnomalyPanel, KpiCard, UserUsagePanel } from "./CreditUsageSummary";
import { NodeRowsTable, ProjectStatsTable, RecentJobsTable, SelectedRunBreakdown, WorkflowStatsTable } from "./CreditUsageTables";

const chartGroups: Array<{ value: ChartGroupBy; label: string }> = [
  { value: "total", label: "Total" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
  { value: "model", label: "Model" },
];

export function CreditUsageDashboardContent({
  dashboard,
  creditsRemaining,
  onGranularityChange,
}: {
  dashboard: BackendCreditDashboard;
  creditsRemaining: number;
  onGranularityChange: (next: BackendCreditDashboardGranularity) => void;
}) {
  const [chartGroup, setChartGroup] = useState<ChartGroupBy>("total");
  const [pivotDimension, setPivotDimension] = useState<PivotDimension>("model");
  const [pivotCell, setPivotCell] = useState<PivotCell | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const chart = useMemo(
    () => buildBucketChartRows(dashboard.buckets, dashboard.breakdown, chartGroup),
    [dashboard.buckets, dashboard.breakdown, chartGroup],
  );
  const maxDailyCredits = useMemo(() => Math.max(1, ...chart.rows.map((day) => day.total)), [chart.rows]);
  const pivotRows = dashboard.breakdown[pivotDimension] ?? [];
  const activeCellBucket = pivotCell ? dashboard.buckets.find((bucket) => bucket.key === pivotCell.bucketKey) : undefined;
  const visibleAnomalies = useMemo(
    () => buildDisplayAnomalies(dashboard.anomalies, creditsRemaining, dashboard.summary.burnRateCreditsPerDay),
    [creditsRemaining, dashboard.anomalies, dashboard.summary.burnRateCreditsPerDay],
  );
  const statuses = useMemo(
    () => ["all", ...Array.from(new Set(dashboard.recent.map((job) => job.status))).sort()],
    [dashboard.recent],
  );
  const filteredRecent = useMemo(() => {
    const scoped =
      pivotCell && activeCellBucket
        ? dashboard.recent.filter((job) => matchesPivotCell(job, pivotCell.dimension, pivotCell.rowId, activeCellBucket))
        : dashboard.recent;
    return sortRecentJobs(filterRecentJobs(scoped, search, statusFilter), sortKey, sortDirection);
  }, [activeCellBucket, dashboard.recent, pivotCell, search, sortDirection, sortKey, statusFilter]);
  const selectedJob = useMemo(
    () => dashboard.recent.find((job) => job.jobId === selectedJobId) ?? filteredRecent[0] ?? null,
    [dashboard.recent, filteredRecent, selectedJobId],
  );
  const selectedNodeRows = useMemo(
    () => (selectedJob ? dashboard.nodeRows.filter((row) => row.jobId === selectedJob.jobId) : []),
    [dashboard.nodeRows, selectedJob],
  );
  const daysUntilEmpty =
    dashboard.summary.burnRateCreditsPerDay > 0 ? creditsRemaining / dashboard.summary.burnRateCreditsPerDay : null;

  function handlePivotDimensionChange(next: PivotDimension) {
    setPivotDimension(next);
    // A cell selection names a row in the old dimension; keeping it would filter
    // the events table by something no longer on screen.
    setPivotCell(null);
  }

  function handleSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "project" || nextKey === "user" || nextKey === "workflow" ? "asc" : "desc");
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 -mx-4 border-b border-line bg-white/95 px-4 pb-3 pt-1 backdrop-blur">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <KpiCard
            label="Today"
            value={`${formatCredits(dashboard.summary.todayCredits)} cr`}
            sub={`${formatUsd(dashboard.summary.todayUsd)} cost`}
          />
          <KpiCard
            label="This month"
            value={`${formatCredits(dashboard.summary.monthCredits)} cr`}
            sub={`${formatUsd(dashboard.summary.monthUsd)} cost`}
          />
          <KpiCard
            label="All time"
            value={`${formatCredits(dashboard.summary.totalCredits)} cr`}
            sub={`${formatUsd(dashboard.summary.totalUsd)} cost`}
          />
          <KpiCard label="Remaining" value={`${formatCredits(creditsRemaining)} cr`} sub="available balance" />
          <KpiCard
            label="Runs today"
            value={String(dashboard.summary.todayRuns)}
            sub={`${dashboard.summary.periodRuns} in range`}
          />
          <KpiCard label="Avg/run" value={`${formatCredits(dashboard.summary.averageCreditsPerRun)} cr`} sub="selected range" />
          <KpiCard
            label="Runway"
            value={formatDays(daysUntilEmpty)}
            sub={`${formatCredits(dashboard.summary.burnRateCreditsPerDay)} cr/day`}
          />
          <KpiCard
            label="Projected EOM"
            value={`${formatCredits(dashboard.summary.projectedMonthCredits)} cr`}
            sub={`${formatUsd(dashboard.summary.projectedMonthUsd)} projected`}
          />
        </div>
      </div>

      {visibleAnomalies.length ? <AnomalyPanel anomalies={visibleAnomalies} /> : null}

      <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-stone-500">
            <BarChart3 className="h-3.5 w-3.5" />
            Credit usage per {dashboard.granularity}
          </div>
          <div className="flex flex-wrap gap-1">
            {chartGroups.map((group) => (
              <button
                key={group.value}
                type="button"
                onClick={() => setChartGroup(group.value)}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-bold transition ${
                  chartGroup === group.value
                    ? "border-accent bg-accent text-white"
                    : "border-line bg-white text-stone-600 hover:border-accent"
                }`}
              >
                {group.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex h-44 items-end gap-1 overflow-hidden rounded-md bg-stone-50 px-2 pb-2 pt-4">
          {chart.rows.length ? (
            chart.rows.map((bucket, bucketIndex) => (
              <div
                key={bucket.key}
                className="flex min-w-0 flex-1 flex-col items-center gap-1"
                title={chartBarTitle(bucket)}
              >
                <div className="flex h-36 w-full items-end">
                  <div
                    className="flex w-full flex-col justify-end overflow-hidden rounded-t"
                    style={{ height: `${bucket.total > 0 ? Math.max(3, (bucket.total / maxDailyCredits) * 100) : 0}%` }}
                  >
                    {bucket.segments.map((segment) => (
                      <div
                        key={`${bucket.key}:${segment.label}`}
                        className="w-full"
                        style={{
                          height: `${bucket.total > 0 ? (segment.credits / bucket.total) * 100 : 0}%`,
                          backgroundColor: segment.color,
                        }}
                      />
                    ))}
                  </div>
                </div>
                {/* Day granularity over a long range packs the axis, so only every
                    nth label is drawn -- the tooltip still names every bar. */}
                <span className="w-full truncate text-center text-[9px] font-semibold text-stone-400">
                  {bucketIndex % chartLabelStride(chart.rows.length) === 0 ? bucket.label : ""}
                </span>
              </div>
            ))
          ) : (
            <p className="m-auto text-sm font-semibold text-stone-500">No credit usage yet.</p>
          )}
        </div>
        {chart.legend.length ? (
          <div className="mt-3 flex flex-wrap gap-3">
            {chart.legend.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-600">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <CreditSpendPivot
        buckets={dashboard.buckets}
        rows={pivotRows}
        dimension={pivotDimension}
        granularity={dashboard.granularity}
        selectedCell={pivotCell}
        onDimensionChange={handlePivotDimensionChange}
        onGranularityChange={onGranularityChange}
        onSelectCell={setPivotCell}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <ProjectStatsTable rows={dashboard.byProject} />
        <WorkflowStatsTable rows={dashboard.byModel} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
        <UserUsagePanel rows={dashboard.byUser} />
        <NodeRowsTable rows={dashboard.nodeRows} />
      </div>

      {pivotCell && activeCellBucket ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-teal-50 px-3 py-2">
          <span className="text-xs font-bold uppercase tracking-wide text-teal-800">Filtered</span>
          <span className="text-sm font-semibold text-ink">
            {pivotDimensionLabels[pivotCell.dimension]} {pivotCell.rowLabel} - {activeCellBucket.label}
          </span>
          <span className="text-xs font-semibold text-stone-500">
            {formatCredits(activeCellBucket.credits)} cr in this {dashboard.granularity} across all rows
          </span>
          <button
            type="button"
            onClick={() => setPivotCell(null)}
            className="ml-auto flex h-7 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-bold text-stone-600 transition hover:border-accent"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      ) : null}

      <RecentJobsTable
        rows={filteredRecent}
        totalRows={dashboard.recent.length}
        statuses={statuses}
        search={search}
        statusFilter={statusFilter}
        sortKey={sortKey}
        sortDirection={sortDirection}
        selectedJobId={selectedJob?.jobId ?? null}
        onSearchChange={setSearch}
        onStatusChange={setStatusFilter}
        onSort={handleSort}
        onSelectJob={setSelectedJobId}
      />

      {selectedJob ? <SelectedRunBreakdown job={selectedJob} rows={selectedNodeRows} /> : null}
    </div>
  );
}

// Roughly a dozen labels regardless of bucket count, so the axis stays readable
// from 7 day-buckets up to the 120-bucket cap.
function chartLabelStride(bucketCount: number) {
  return Math.max(1, Math.ceil(bucketCount / 12));
}

function chartBarTitle(bucket: { label: string; total: number; segments: Array<{ label: string; credits: number }> }) {
  const header = `${bucket.label}: ${formatCredits(bucket.total)} credits`;
  if (bucket.segments.length <= 1) return header;
  // The stacking is the point of the grouped view; a total-only tooltip hides it.
  return [header, ...bucket.segments.map((segment) => `${segment.label}: ${formatCredits(segment.credits)}`)].join("\n");
}
