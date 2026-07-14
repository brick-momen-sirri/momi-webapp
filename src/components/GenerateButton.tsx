import { Loader2, Play, Timer, WalletCards } from "lucide-react";
import type { ModelType } from "../types";

type GenerateButtonProps = {
  selectedModel: ModelType;
  creditsRemaining: number;
  disabledReason?: string;
  isSubmitting: boolean;
  onGenerate: () => void;
};

export function GenerateButton({
  selectedModel,
  creditsRemaining,
  disabledReason,
  isSubmitting,
  onGenerate,
}: GenerateButtonProps) {
  const disabled = Boolean(disabledReason) || isSubmitting;
  const insufficient = creditsRemaining < selectedModel.cost;

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-mist/80 px-3 py-2">
          <span className="flex items-center gap-1 font-semibold text-stone-500">
            <WalletCards className="h-3.5 w-3.5" />
            Cost
          </span>
          <p className="mt-1 text-sm font-bold text-ink">{selectedModel.costLabel ?? `${selectedModel.cost} credits`}</p>
        </div>
        <div className="rounded-md bg-mist/80 px-3 py-2">
          <span className="flex items-center gap-1 font-semibold text-stone-500">
            <Timer className="h-3.5 w-3.5" />
            Estimate
          </span>
          <p className="mt-1 text-sm font-bold text-ink">{selectedModel.estimatedTime}</p>
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-stone-500">Available credits</span>
        <span className={`font-semibold ${insufficient ? "text-red-600" : "text-accent"}`}>
          {creditsRemaining}
        </span>
      </div>

      {disabledReason ? (
        <p className="mb-2 min-h-5 rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          {disabledReason}
        </p>
      ) : null}

      <button
        type="button"
        disabled={disabled}
        onClick={onGenerate}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-ember px-4 text-sm font-bold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-white"
      >
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {isSubmitting ? "Submitting job..." : "Generate"}
      </button>
    </section>
  );
}
