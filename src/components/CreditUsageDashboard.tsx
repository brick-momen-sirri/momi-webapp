import { Coins } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { formatCredits } from "../features/credits/creditUsageDashboardUtils";
import { CreditUsageDashboardDialog } from "./credit-usage/CreditUsageDashboardDialog";

type CreditUsageDashboardProps = {
  creditsRemaining: number;
  monthlyCreditsSpent: number;
  monthlyCreditsLabel?: string;
};

export function CreditUsageDashboard({
  creditsRemaining,
  monthlyCreditsSpent,
  monthlyCreditsLabel = "spent this month",
}: CreditUsageDashboardProps) {
  const [open, setOpen] = useState(false);

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

      {open
        ? createPortal(<CreditUsageDashboardDialog creditsRemaining={creditsRemaining} onOpenChange={setOpen} />, document.body)
        : null}
    </>
  );
}
