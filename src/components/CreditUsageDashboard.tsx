import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  Coins,
  Download,
  Loader2,
  RefreshCw,
  Search,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchBackendCreditDashboard,
  type BackendCreditDashboard,
  type BackendCreditDashboardAnomaly,
  type BackendCreditDashboardDay,
  type BackendCreditDashboardGroup,
  type BackendCreditDashboardNodeRow,
  type BackendCreditDashboardRecentJob,
} from "../services/backendApi";

type CreditUsageDashboardProps = {
  creditsRemaining: number;
  monthlyCreditsSpent: number;
  monthlyCreditsLabel?: string;
};

type TimePreset = "today" | "last7" | "last30" | "thisMonth" | "lastMonth" | "custom";
type ChartGroupBy = "total" | "project" | "user" | "workflow";
type SortKey = "timestamp" | "project" | "user" | "workflow" | "credits" | "usd" | "status" | "resolution" | "duration";
type SortDirection = "asc" | "desc";

const timeFilters: Array<{ value: TimePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "custom", label: "Custom" },
];

const chartGroups: Array<{ value: ChartGroupBy; label: string }> = [
  { value: "total", label: "Total" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
  { value: "workflow", label: "Workflow" },
];

const chartColors = ["#14b8a6", "#f97316", "#6366f1", "#e11d48", "#84cc16", "#0ea5e9", "#a855f7"];

export function CreditUsageDashboard({
  creditsRemaining,
  monthlyCreditsSpent,
  monthlyCreditsLabel = "spent this month",
}: CreditUsageDashboardProps) {
  const [open, setOpen] = useState(false);
  const [dashboard, setDashboard] = useState<BackendCreditDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rangePreset, setRangePreset] = useState<TimePreset>("last30");
  const [customFrom, setCustomFrom] = useState(() => toDateInput(addDays(new Date(), -29)));
  const [customTo, setCustomTo] = useState(() => toDateInput(new Date()));

  async function loadDashboard() {
    setLoading(true);
    setError("");
    try {
      setDashboard(
        await fetchBackendCreditDashboard({
          range: rangePreset,
          from: rangePreset === "custom" ? customFrom : undefined,
          to: rangePreset === "custom" ? customTo : undefined,
        }),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load credit usage.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadDashboard();
  }, [open, rangePreset]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const modal = open ? (
    <div
      className="fixed inset-0 bg-stone-950/50 p-3 backdrop-blur-sm"
      style={{ zIndex: 2147483000 }}
      role="dialog"
      aria-modal="true"
    >
      <div className="relative mx-auto flex h-full max-w-[1480px] flex-col overflow-hidden rounded-lg border border-line bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <WalletCards className="h-5 w-5 shrink-0 text-accent" />
            <div className="min-w-0">
              <h2 className="truncate text-base font-bold text-ink">Credit Usage Analytics</h2>
              <p className="truncate text-xs font-semibold text-stone-500">
                {dashboard ? `${dashboard.range.label} - updated ${formatDateTime(dashboard.generatedAt)}` : "Job-history dashboard"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadDashboard()}
              disabled={loading}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50 disabled:cursor-wait disabled:opacity-60"
              title="Refresh credit usage"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="border-b border-line bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {timeFilters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setRangePreset(filter.value)}
                className={`rounded-md border px-3 py-2 text-xs font-bold transition ${
                  rangePreset === filter.value
                    ? "border-accent bg-accent text-white"
                    : "border-line bg-white text-stone-600 hover:border-accent hover:bg-mist/70"
                }`}
              >
                {filter.label}
              </button>
            ))}
            {rangePreset === "custom" ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  className="h-9 rounded-md border border-line px-2 text-xs font-semibold text-ink"
                />
                <span className="text-xs font-bold text-stone-400">to</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  className="h-9 rounded-md border border-line px-2 text-xs font-semibold text-ink"
                />
                <button
                  type="button"
                  onClick={() => void loadDashboard()}
                  className="h-9 rounded-md border border-accent bg-accent px-3 text-xs font-bold text-white"
                >
                  Apply
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-stone-50/60 p-4">
          {loading && !dashboard ? (
            <div className="flex min-h-80 items-center justify-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-7 w-7 animate-spin text-accent" />
                <p className="mt-3 text-sm font-semibold text-stone-600">Loading credit usage...</p>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="mb-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {error}
            </p>
          ) : null}

          {dashboard ? <DashboardContent dashboard={dashboard} creditsRemaining={creditsRemaining} /> : null}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-white p-3 text-left shadow-panel transition hover:border-accent hover:bg-mist/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
            <Coins className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-ink">Credit usage</span>
            <span className="mt-0.5 block truncate text-xs font-semibold text-stone-500">
              {formatCredits(monthlyCreditsSpent)} {monthlyCreditsLabel}
            </span>
          </span>
        </span>
        <span className="shrink-0 rounded-md bg-mist px-2 py-1 text-right">
          <span className="block text-xs font-bold text-ink">{formatCredits(creditsRemaining)}</span>
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-stone-500">left</span>
        </span>
      </button>

      {modal ? createPortal(modal, document.body) : null}
    </>
  );
}

function DashboardContent({ dashboard, creditsRemaining }: { dashboard: BackendCreditDashboard; creditsRemaining: number }) {
  const [chartGroup, setChartGroup] = useState<ChartGroupBy>("total");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const chart = useMemo(() => buildChartRows(dashboard.byDay, dashboard.recent, chartGroup), [dashboard.byDay, dashboard.recent, chartGroup]);
  const maxDailyCredits = useMemo(() => Math.max(1, ...chart.rows.map((day) => day.total)), [chart.rows]);
  const visibleAnomalies = useMemo(
    () => buildDisplayAnomalies(dashboard.anomalies, creditsRemaining, dashboard.summary.burnRateCreditsPerDay),
    [creditsRemaining, dashboard.anomalies, dashboard.summary.burnRateCreditsPerDay],
  );
  const statuses = useMemo(() => ["all", ...Array.from(new Set(dashboard.recent.map((job) => job.status))).sort()], [dashboard.recent]);
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
          <KpiCard label="Today" value={`${formatCredits(dashboard.summary.todayCredits)} cr`} sub={`${formatUsd(dashboard.summary.todayUsd)} cost`} />
          <KpiCard label="This month" value={`${formatCredits(dashboard.summary.monthCredits)} cr`} sub={`${formatUsd(dashboard.summary.monthUsd)} cost`} />
          <KpiCard label="All time" value={`${formatCredits(dashboard.summary.totalCredits)} cr`} sub={`${formatUsd(dashboard.summary.totalUsd)} cost`} />
          <KpiCard label="Remaining" value={`${formatCredits(creditsRemaining)} cr`} sub="available balance" />
          <KpiCard label="Runs today" value={String(dashboard.summary.todayRuns)} sub={`${dashboard.summary.periodRuns} in range`} />
          <KpiCard label="Avg/run" value={`${formatCredits(dashboard.summary.averageCreditsPerRun)} cr`} sub="selected range" />
          <KpiCard label="Runway" value={formatDays(daysUntilEmpty)} sub={`${formatCredits(dashboard.summary.burnRateCreditsPerDay)} cr/day`} />
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
              <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${day.date}: ${formatCredits(day.total)} credits`}>
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

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-white p-3 shadow-sm">
      <p className="truncate text-[11px] font-bold uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-2 truncate text-xl font-bold text-ink">{value}</p>
      <p className="mt-1 truncate text-xs font-semibold text-stone-500">{sub}</p>
    </div>
  );
}

function AnomalyPanel({ anomalies }: { anomalies: DisplayAnomaly[] }) {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        Usage watch
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {anomalies.slice(0, 6).map((anomaly) => (
          <div key={anomaly.id} className="rounded-md border border-amber-200 bg-white px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className={`text-xs font-bold uppercase ${anomaly.severity === "critical" ? "text-red-700" : "text-amber-700"}`}>
                {anomaly.type.replace(/_/g, " ")}
              </span>
              <span className="text-xs font-semibold text-stone-500">{formatCredits(anomaly.credits)} cr</span>
            </div>
            <p className="mt-1 text-sm font-semibold text-ink">{anomaly.message}</p>
            <p className="mt-1 text-xs font-semibold text-stone-500">Threshold: {formatCredits(anomaly.threshold)} cr</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectStatsTable({ rows }: { rows: BackendCreditDashboardGroup[] }) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-stone-500">Projects</p>
      <div className="max-h-80 overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="sticky top-0 bg-mist text-stone-600">
            <tr>
              <th className="px-2 py-2 font-bold">Project</th>
              <th className="px-2 py-2 font-bold">Credits</th>
              <th className="px-2 py-2 font-bold">Cost</th>
              <th className="px-2 py-2 font-bold">Runs</th>
              <th className="px-2 py-2 font-bold">% total</th>
              <th className="px-2 py-2 font-bold">Last activity</th>
              <th className="px-2 py-2 font-bold">Most expensive workflow</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length ? (
              rows.slice(0, 50).map((row) => (
                <tr key={row.id}>
                  <td className="px-2 py-2 font-bold text-ink">{row.label}</td>
                  <td className="px-2 py-2 font-bold text-ink">{formatCredits(row.credits)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatUsd(row.usd)}</td>
                  <td className="px-2 py-2 text-stone-600">{row.jobs}</td>
                  <td className="px-2 py-2 text-stone-600">{formatPercent(row.percentage)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatDateTime(row.lastActivityAt)}</td>
                  <td className="px-2 py-2 text-stone-600">
                    {row.mostExpensiveWorkflow ? `${row.mostExpensiveWorkflow} (${formatCredits(row.mostExpensiveWorkflowCredits ?? 0)} cr)` : "-"}
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow colSpan={7} label="No project usage in this range." />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkflowStatsTable({ rows }: { rows: BackendCreditDashboardGroup[] }) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-stone-500">Workflows</p>
      <div className="max-h-80 overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="sticky top-0 bg-mist text-stone-600">
            <tr>
              <th className="px-2 py-2 font-bold">Workflow</th>
              <th className="px-2 py-2 font-bold">Credits</th>
              <th className="px-2 py-2 font-bold">Cost</th>
              <th className="px-2 py-2 font-bold">Runs</th>
              <th className="px-2 py-2 font-bold">Avg</th>
              <th className="px-2 py-2 font-bold">Min/Max</th>
              <th className="px-2 py-2 font-bold">Last used</th>
              <th className="px-2 py-2 font-bold">Expected vs actual</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length ? (
              rows.slice(0, 50).map((row) => (
                <tr key={row.id}>
                  <td className="px-2 py-2 font-bold text-ink">{row.label}</td>
                  <td className="px-2 py-2 font-bold text-ink">{formatCredits(row.credits)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatUsd(row.usd)}</td>
                  <td className="px-2 py-2 text-stone-600">{row.jobs}</td>
                  <td className="px-2 py-2 text-stone-600">{formatCredits(row.averageCreditsPerRun)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatCredits(row.minCredits)} / {formatCredits(row.maxCredits)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatDateTime(row.lastActivityAt)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatExpectedDelta(row)}</td>
                </tr>
              ))
            ) : (
              <EmptyRow colSpan={8} label="No workflow usage in this range." />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserUsagePanel({ rows }: { rows: BackendCreditDashboardGroup[] }) {
  const max = Math.max(1, ...rows.map((row) => row.credits));
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-stone-500">Users</p>
      <div className="space-y-3">
        {rows.length ? (
          rows.slice(0, 12).map((row) => (
            <div key={row.id} className="min-w-0">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold">
                <span className="truncate font-bold text-ink">{row.label}</span>
                <span className="shrink-0 text-stone-500">
                  {formatCredits(row.credits)} cr - {row.jobs} runs - {formatPercent(row.percentage)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-stone-100">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(3, (row.credits / max) * 100)}%` }} />
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm font-semibold text-stone-500">No user usage in this range.</p>
        )}
      </div>
    </section>
  );
}

function RecentJobsTable({
  rows,
  totalRows,
  statuses,
  search,
  statusFilter,
  sortKey,
  sortDirection,
  selectedJobId,
  onSearchChange,
  onStatusChange,
  onSort,
  onSelectJob,
}: {
  rows: BackendCreditDashboardRecentJob[];
  totalRows: number;
  statuses: string[];
  search: string;
  statusFilter: string;
  sortKey: SortKey;
  sortDirection: SortDirection;
  selectedJobId: string | null;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onSort: (key: SortKey) => void;
  onSelectJob: (jobId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Recent credit events</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 min-w-56 items-center gap-2 rounded-md border border-line bg-white px-2 text-xs font-semibold text-stone-500">
            <Search className="h-3.5 w-3.5" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search project, user, workflow"
              className="min-w-0 flex-1 bg-transparent text-ink outline-none"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => onStatusChange(event.target.value)}
            className="h-9 rounded-md border border-line bg-white px-2 text-xs font-bold text-stone-600"
          >
            {statuses.map((status) => (
              <option key={status} value={status}>{status === "all" ? "All statuses" : status}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => exportRecentCsv(rows)}
            className="flex h-9 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-bold text-stone-600 transition hover:border-accent"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
        </div>
      </div>
      <p className="mb-2 text-xs font-semibold text-stone-500">
        Showing {rows.length} of {totalRows} events. Click a row for node details.
      </p>
      <div className="max-h-[520px] overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[1120px] text-left text-xs">
          <thead className="sticky top-0 bg-mist text-stone-600">
            <tr>
              <SortableHeader label="Timestamp" active={sortKey === "timestamp"} direction={sortDirection} onClick={() => onSort("timestamp")} />
              <SortableHeader label="Project" active={sortKey === "project"} direction={sortDirection} onClick={() => onSort("project")} />
              <SortableHeader label="User" active={sortKey === "user"} direction={sortDirection} onClick={() => onSort("user")} />
              <SortableHeader label="Workflow" active={sortKey === "workflow"} direction={sortDirection} onClick={() => onSort("workflow")} />
              <SortableHeader label="Credits" active={sortKey === "credits"} direction={sortDirection} onClick={() => onSort("credits")} />
              <SortableHeader label="Cost" active={sortKey === "usd"} direction={sortDirection} onClick={() => onSort("usd")} />
              <SortableHeader label="Status" active={sortKey === "status"} direction={sortDirection} onClick={() => onSort("status")} />
              <SortableHeader label="Resolution" active={sortKey === "resolution"} direction={sortDirection} onClick={() => onSort("resolution")} />
              <SortableHeader label="Duration" active={sortKey === "duration"} direction={sortDirection} onClick={() => onSort("duration")} />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length ? (
              rows.map((job) => (
                <tr
                  key={job.jobId}
                  onClick={() => onSelectJob(job.jobId)}
                  className={`cursor-pointer transition hover:bg-mist/60 ${selectedJobId === job.jobId ? "bg-teal-50" : "bg-white"}`}
                >
                  <td className="px-2 py-2 text-stone-500">{formatDateTime(job.timestamp)}</td>
                  <td className="px-2 py-2 font-semibold text-ink">{job.projectName}</td>
                  <td className="px-2 py-2 text-stone-600">{job.userName}</td>
                  <td className="px-2 py-2 text-stone-600">{job.modelName}</td>
                  <td className="px-2 py-2 font-bold text-ink">{formatCredits(job.credits)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatUsd(job.usd)}</td>
                  <td className="px-2 py-2"><StatusPill status={job.status} /></td>
                  <td className="px-2 py-2 text-stone-600">{job.resolution || "-"}</td>
                  <td className="px-2 py-2 text-stone-600">{formatDuration(job.runDurationSeconds)}</td>
                </tr>
              ))
            ) : (
              <EmptyRow colSpan={9} label="No matching credit events." />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <th className="px-2 py-2 font-bold">
      <button type="button" onClick={onClick} className="flex items-center gap-1 text-left">
        {label}
        <ArrowUpDown className={`h-3 w-3 ${active ? "text-accent" : "text-stone-400"}`} />
        {active ? <span className="text-[10px] text-accent">{direction}</span> : null}
      </button>
    </th>
  );
}

function SelectedRunBreakdown({ job, rows }: { job: BackendCreditDashboardRecentJob; rows: BackendCreditDashboardNodeRow[] }) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Selected run breakdown</p>
          <h3 className="mt-1 text-sm font-bold text-ink">{job.modelName}</h3>
          <p className="mt-1 text-xs font-semibold text-stone-500">
            {job.projectName} - {job.userName} - {job.jobId}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-right text-xs font-semibold text-stone-600 sm:grid-cols-4">
          <span><b className="block text-ink">{formatCredits(job.credits)}</b>credits</span>
          <span><b className="block text-ink">{formatUsd(job.usd)}</b>cost</span>
          <span><b className="block text-ink">{job.resolution || "-"}</b>resolution</span>
          <span><b className="block text-ink">{formatDuration(job.runDurationSeconds)}</b>duration</span>
        </div>
      </div>
      <div className="overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[780px] text-left text-xs">
          <thead className="bg-mist text-stone-600">
            <tr>
              <th className="px-2 py-2 font-bold">Node name</th>
              <th className="px-2 py-2 font-bold">Node class</th>
              <th className="px-2 py-2 font-bold">Credits</th>
              <th className="px-2 py-2 font-bold">Cost</th>
              <th className="px-2 py-2 font-bold">Source</th>
              <th className="px-2 py-2 font-bold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.rowKey}>
                  <td className="px-2 py-2 font-semibold text-ink">{row.nodeTitle || row.nodeId || "Node"}</td>
                  <td className="px-2 py-2 text-stone-600">{row.classType || "-"}</td>
                  <td className="px-2 py-2 font-bold text-ink">{formatCredits(row.credits)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatUsd(row.usd)}</td>
                  <td className="px-2 py-2 text-stone-600">{row.source || "-"}</td>
                  <td className="px-2 py-2 text-stone-600">{row.status || "-"}</td>
                </tr>
              ))
            ) : (
              <EmptyRow colSpan={6} label="This run did not report per-node credit rows." />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NodeRowsTable({ rows }: { rows: BackendCreditDashboardNodeRow[] }) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-stone-500">Per-node spend</p>
      <div className="max-h-80 overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="sticky top-0 bg-mist text-stone-600">
            <tr>
              <th className="px-2 py-2 font-bold">Node name</th>
              <th className="px-2 py-2 font-bold">Node class</th>
              <th className="px-2 py-2 font-bold">Workflow</th>
              <th className="px-2 py-2 font-bold">Credits</th>
              <th className="px-2 py-2 font-bold">Cost</th>
              <th className="px-2 py-2 font-bold">Timestamp</th>
              <th className="px-2 py-2 font-bold">Project</th>
              <th className="px-2 py-2 font-bold">Run ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length ? (
              rows.slice(0, 300).map((row) => (
                <tr key={row.rowKey}>
                  <td className="px-2 py-2 font-semibold text-ink">{row.nodeTitle || row.nodeId || "Node"}</td>
                  <td className="px-2 py-2 text-stone-600">{row.classType || "-"}</td>
                  <td className="px-2 py-2 text-stone-600">{row.modelName}</td>
                  <td className="px-2 py-2 font-bold text-ink">{formatCredits(row.credits)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatUsd(row.usd)}</td>
                  <td className="px-2 py-2 text-stone-600">{formatDateTime(row.createdAt)}</td>
                  <td className="px-2 py-2 text-stone-600">{row.projectName}</td>
                  <td className="px-2 py-2 font-mono text-[11px] text-stone-500">{row.jobId}</td>
                </tr>
              ))
            ) : (
              <EmptyRow colSpan={8} label="No per-node credit rows yet." />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : status === "failed" || status === "canceled"
        ? "bg-red-50 text-red-700"
        : "bg-amber-50 text-amber-700";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase ${tone}`}>{status}</span>;
}

function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td className="px-2 py-3 text-sm font-semibold text-stone-500" colSpan={colSpan}>{label}</td>
    </tr>
  );
}

type DisplayAnomaly = BackendCreditDashboardAnomaly | {
  id: string;
  type: "low_remaining";
  severity: "warning" | "critical";
  message: string;
  credits: number;
  threshold: number;
};

function buildDisplayAnomalies(anomalies: BackendCreditDashboardAnomaly[], creditsRemaining: number, burnRateCreditsPerDay: number): DisplayAnomaly[] {
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

function buildChartRows(days: BackendCreditDashboardDay[], events: BackendCreditDashboardRecentJob[], groupBy: ChartGroupBy) {
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
  for (const event of events) {
    if (event.credits <= 0) continue;
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
  const legend = [...topLabels, ...(hasOther ? ["Other"] : [])].map((label, index) => ({ label, color: chartColors[index % chartColors.length] }));

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
  if (groupBy === "project") return event.projectName || "Unknown project";
  if (groupBy === "user") return event.userName || "Unknown user";
  return event.modelName || "Unknown workflow";
}

function filterRecentJobs(rows: BackendCreditDashboardRecentJob[], search: string, statusFilter: string) {
  const query = search.trim().toLowerCase();
  return rows.filter((job) => {
    if (statusFilter !== "all" && job.status !== statusFilter) return false;
    if (!query) return true;
    return [
      job.jobId,
      job.projectName,
      job.userName,
      job.modelName,
      job.status,
      job.resolution,
    ].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

function sortRecentJobs(rows: BackendCreditDashboardRecentJob[], sortKey: SortKey, direction: SortDirection) {
  const sorted = [...rows].sort((a, b) => {
    const left = recentSortValue(a, sortKey);
    const right = recentSortValue(b, sortKey);
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right));
  });
  return direction === "desc" ? sorted.reverse() : sorted;
}

function recentSortValue(job: BackendCreditDashboardRecentJob, sortKey: SortKey) {
  if (sortKey === "timestamp") return new Date(job.timestamp).getTime() || 0;
  if (sortKey === "project") return job.projectName;
  if (sortKey === "user") return job.userName;
  if (sortKey === "workflow") return job.modelName;
  if (sortKey === "credits") return job.credits;
  if (sortKey === "usd") return job.usd;
  if (sortKey === "status") return job.status;
  if (sortKey === "resolution") return job.resolution;
  return job.runDurationSeconds ?? 0;
}

function exportRecentCsv(rows: BackendCreditDashboardRecentJob[]) {
  const headers = ["timestamp", "project", "user", "workflow", "credits", "cost", "status", "resolution", "duration_seconds", "job_id"];
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
  const csv = [headers, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
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

function formatCredits(value: number | undefined) {
  if (!Number.isFinite(value)) return "0";
  const safeValue = Number(value);
  if (Math.abs(safeValue) >= 1000) return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(safeValue);
  if (Number.isInteger(safeValue)) return String(safeValue);
  return safeValue.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

function formatUsd(value: number | undefined) {
  if (!Number.isFinite(value) || Number(value) <= 0) return "$0";
  return `$${Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatPercent(value: number | undefined) {
  if (!Number.isFinite(value)) return "0%";
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)}%`;
}

function formatExpectedDelta(row: BackendCreditDashboardGroup) {
  if (!row.expectedCredits) return "No expected price";
  const delta = row.actualVsExpectedCredits;
  const prefix = delta > 0 ? "+" : "";
  return `${formatCredits(row.expectedCredits)} expected / ${prefix}${formatCredits(delta)} cr`;
}

function formatDateTime(value?: string) {
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

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds) || !seconds) return "-";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatDays(days: number | null) {
  if (!Number.isFinite(days) || days == null) return "-";
  if (days < 1) return "<1 day";
  if (days > 365) return "365+ days";
  return `${Math.round(days)} days`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateInput(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
