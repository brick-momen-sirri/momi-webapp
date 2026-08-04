import { AlertTriangle } from "lucide-react";

import type { BackendCreditDashboardGroup } from "../../services/backendApi";
import { formatCredits, formatPercent, type DisplayAnomaly } from "../../features/credits/creditUsageDashboardUtils";

export function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-white p-3 shadow-sm">
      <p className="truncate text-[11px] font-bold uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-2 truncate text-xl font-bold text-ink">{value}</p>
      <p className="mt-1 truncate text-xs font-semibold text-stone-500">{sub}</p>
    </div>
  );
}

export function AnomalyPanel({ anomalies }: { anomalies: DisplayAnomaly[] }) {
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
              <span
                className={`text-xs font-bold uppercase ${anomaly.severity === "critical" ? "text-red-700" : "text-amber-700"}`}
              >
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

export function UserUsagePanel({ rows }: { rows: BackendCreditDashboardGroup[] }) {
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
