import { AlertTriangle } from "lucide-react";
import { formatUsdTotal } from "../features/credits/creditUsageDashboardUtils";

export function SpendLimitBar({
  usdUsed,
  spendLimitUsd,
  variant = "full",
}: {
  usdUsed: number;
  spendLimitUsd?: number | null;
  variant?: "compact" | "full";
}) {
  if (!spendLimitUsd || spendLimitUsd <= 0) return null;

  const pct = Math.min(100, (usdUsed / spendLimitUsd) * 100);
  const overLimit = usdUsed >= spendLimitUsd;
  const nearLimit = !overLimit && pct >= 80;
  const barColor = overLimit ? "bg-red-500" : nearLimit ? "bg-amber-500" : "bg-accent";

  if (variant === "compact") {
    // The percentage rides along with the bar: a bare stripe on a card says
    // something is being measured without saying how close it is.
    return (
      <div className="flex items-center gap-2">
        <div className="h-1 w-full min-w-0 flex-1 overflow-hidden rounded-full bg-stone-100">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        {overLimit ? (
          <AlertTriangle className="h-3 w-3 shrink-0 text-red-600" aria-label="Spend limit reached" />
        ) : null}
        <span
          className={`shrink-0 text-[10px] font-semibold tabular-nums ${overLimit ? "text-red-600" : "text-stone-500"}`}
        >
          {Math.round(pct)}%
        </span>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-[11px] text-stone-500">
        <span>
          {formatUsdTotal(usdUsed)} of {formatUsdTotal(spendLimitUsd)}
        </span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-stone-100">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      {overLimit ? (
        <p
          role="status"
          className="mt-1.5 flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Spend limit reached
        </p>
      ) : null}
    </div>
  );
}
