import { BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";

import type { BackendCreditDashboard } from "../../services/backendApi";
import {
  buildChartRows,
  buildDisplayAnomalies,
  filterRecentJobs,
  formatCredits,
  formatDays,
  formatUsd,
  sortRecentJobs,
  type ChartGroupBy,
  type SortDirection,
  type SortKey,
} from "../../features/credits/creditUsageDashboardUtils";
import { AnomalyPanel, KpiCard, UserUsagePanel } from "./CreditUsageSummary";
import { NodeRowsTable, ProjectStatsTable, RecentJobsTable, SelectedRunBreakdown, WorkflowStatsTable } from "./CreditUsageTables";

const chartGroups: Array<{ value: ChartGroupBy; label: string }> = [
  { value: "total", label: "Total" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
  { value: "workflow", label: "Workflow" },
];

export function CreditUsageDashboardContent({
  dashboard,
  creditsRemaining,
}: {
  dashboard: BackendCreditDashboard;
  creditsRemaining: number;
}) {
  const [chartGroup, setChartGroup] = useState<ChartGroupBy>("total");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const chart = useMemo(
    () => buildChartRows(dashboard.byDay, dashboard.recent, chartGroup),
    [dashboard.byDay, dashboard.recent, chartGroup],
  );
  const maxDailyCredits = useMemo(() => Math.max(1, ...chart.rows.map((day) => day.total)), [chart.rows]);
  const visibleAnomalies = useMemo(
    () => buildDisplayAnomalies(dashboard.anomalies, creditsRemaining, dashboard.summary.burnRateCreditsPerDay),
    [creditsRemaining, dashboard.anomalies, dashboard.summary.burnRateCreditsPerDay],
  );
  const statuses = useMemo(
    () => ["all", ...Array.from(new Set(dashboard.recent.map((job) => job.status))).sort()],
    [dashboard.recent],
  );
  const filteredRecent = useMemo(
    () => sortRecentJobs(filterRecentJobs(dashboard.recent, search, statusFilter), sortKey, sortDirection),
    [dashboard.recent, search, sortDirection, sortKey, statusFilter],
  );
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
            Daily credit usage
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
            chart.rows.map((day) => (
              <div
                key={day.date}
                className="flex min-w-0 flex-1 flex-col items-center gap-1"
                title={`${day.date}: ${formatCredits(day.total)} credits`}
              >
                <div className="flex h-36 w-full items-end">
                  <div
                    className="flex w-full flex-col justify-end overflow-hidden rounded-t"
                    style={{ height: `${day.total > 0 ? Math.max(3, (day.total / maxDailyCredits) * 100) : 0}%` }}
                  >
                    {day.segments.map((segment) => (
                      <div
                        key={`${day.date}:${segment.label}`}
                        className="w-full"
                        style={{
                          height: `${day.total > 0 ? (segment.credits / day.total) * 100 : 0}%`,
                          backgroundColor: segment.color,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <span className="w-full truncate text-center text-[9px] font-semibold text-stone-400">{day.date.slice(5)}</span>
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <ProjectStatsTable rows={dashboard.byProject} />
        <WorkflowStatsTable rows={dashboard.byModel} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
        <UserUsagePanel rows={dashboard.byUser} />
        <NodeRowsTable rows={dashboard.nodeRows} />
      </div>

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
