import { ArrowUpDown, Download, Search } from "lucide-react";

import type {
  BackendCreditDashboardGroup,
  BackendCreditDashboardNodeRow,
  BackendCreditDashboardRecentJob,
} from "../../services/backendApi";
import {
  exportRecentCsv,
  formatCredits,
  formatDateTime,
  formatDuration,
  formatExpectedDelta,
  formatPercent,
  formatUsd,
  type SortDirection,
  type SortKey,
} from "../../features/credits/creditUsageDashboardUtils";

export function ProjectStatsTable({ rows }: { rows: BackendCreditDashboardGroup[] }) {
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
                    {row.mostExpensiveWorkflow
                      ? `${row.mostExpensiveWorkflow} (${formatCredits(row.mostExpensiveWorkflowCredits ?? 0)} cr)`
                      : "-"}
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

export function WorkflowStatsTable({ rows }: { rows: BackendCreditDashboardGroup[] }) {
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
                  <td className="px-2 py-2 text-stone-600">
                    {formatCredits(row.minCredits)} / {formatCredits(row.maxCredits)}
                  </td>
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

export function RecentJobsTable({
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
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : status}
              </option>
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
              <SortableHeader
                label="Timestamp"
                active={sortKey === "timestamp"}
                direction={sortDirection}
                onClick={() => onSort("timestamp")}
              />
              <SortableHeader
                label="Project"
                active={sortKey === "project"}
                direction={sortDirection}
                onClick={() => onSort("project")}
              />
              <SortableHeader label="User" active={sortKey === "user"} direction={sortDirection} onClick={() => onSort("user")} />
              <SortableHeader
                label="Workflow"
                active={sortKey === "workflow"}
                direction={sortDirection}
                onClick={() => onSort("workflow")}
              />
              <SortableHeader
                label="Credits"
                active={sortKey === "credits"}
                direction={sortDirection}
                onClick={() => onSort("credits")}
              />
              <SortableHeader label="Cost" active={sortKey === "usd"} direction={sortDirection} onClick={() => onSort("usd")} />
              <SortableHeader
                label="Status"
                active={sortKey === "status"}
                direction={sortDirection}
                onClick={() => onSort("status")}
              />
              <SortableHeader
                label="Resolution"
                active={sortKey === "resolution"}
                direction={sortDirection}
                onClick={() => onSort("resolution")}
              />
              <SortableHeader
                label="Duration"
                active={sortKey === "duration"}
                direction={sortDirection}
                onClick={() => onSort("duration")}
              />
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
                  <td className="px-2 py-2">
                    <StatusPill status={job.status} />
                  </td>
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

export function SelectedRunBreakdown({
  job,
  rows,
}: {
  job: BackendCreditDashboardRecentJob;
  rows: BackendCreditDashboardNodeRow[];
}) {
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
          <span>
            <b className="block text-ink">{formatCredits(job.credits)}</b>credits
          </span>
          <span>
            <b className="block text-ink">{formatUsd(job.usd)}</b>cost
          </span>
          <span>
            <b className="block text-ink">{job.resolution || "-"}</b>resolution
          </span>
          <span>
            <b className="block text-ink">{formatDuration(job.runDurationSeconds)}</b>duration
          </span>
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

export function NodeRowsTable({ rows }: { rows: BackendCreditDashboardNodeRow[] }) {
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
      <td className="px-2 py-3 text-sm font-semibold text-stone-500" colSpan={colSpan}>
        {label}
      </td>
    </tr>
  );
}
