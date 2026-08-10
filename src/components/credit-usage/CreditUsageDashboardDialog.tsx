import { Loader2, RefreshCw, WalletCards, X } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import { addDays, formatDateTime, toDateInput, type TimePreset } from "../../features/credits/creditUsageDashboardUtils";
import { useCreditDashboard } from "../../features/credits/useCreditDashboard";
import type { BackendCreditDashboardGranularity } from "../../services/backendApi";
import { CreditUsageDashboardContent } from "./CreditUsageDashboardContent";

const timeFilters: Array<{ value: TimePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "custom", label: "Custom" },
];

type CreditUsageDashboardDialogProps = {
  creditsRemaining: number;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
};

export function CreditUsageDashboardDialog({ creditsRemaining, onOpenChange }: CreditUsageDashboardDialogProps) {
  const [rangePreset, setRangePreset] = useState<TimePreset>("last30");
  const [customFrom, setCustomFrom] = useState(() => toDateInput(addDays(new Date(), -29)));
  const [customTo, setCustomTo] = useState(() => toDateInput(new Date()));
  // null lets the server pick from the range width. Changing the range clears an
  // override, so Last 30 does not stay stuck on the Day bucket a Today view set.
  const [granularity, setGranularity] = useState<BackendCreditDashboardGranularity | null>(null);
  const {
    dashboard,
    loading,
    error,
    reload: loadDashboard,
  } = useCreditDashboard(true, rangePreset, customFrom, customTo, granularity);

  function handleRangeChange(next: TimePreset) {
    setRangePreset(next);
    setGranularity(null);
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange]);

  return (
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
                {dashboard
                  ? `${dashboard.range.label} - updated ${formatDateTime(dashboard.generatedAt)}`
                  : "Job-history dashboard"}
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
              onClick={() => onOpenChange(false)}
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
                onClick={() => handleRangeChange(filter.value)}
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

          {dashboard ? (
            <CreditUsageDashboardContent
              dashboard={dashboard}
              creditsRemaining={creditsRemaining}
              onGranularityChange={setGranularity}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
