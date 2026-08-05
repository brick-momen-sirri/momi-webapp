import { Loader2, Play, Square, Timer, WalletCards } from "lucide-react";
import type { SubmissionPhase } from "../features/jobs/useJobSubmission";
import type { ModelType } from "../types";

type GenerateButtonProps = {
  selectedModel: ModelType;
  creditsRemaining: number;
  disabledReason?: string;
  isSubmitting: boolean;
  submissionPhase: SubmissionPhase;
  hasRecoverableSubmission: boolean;
  onGenerate: () => void;
  onCancelSubmission: () => void;
};

export function GenerateButton({
  selectedModel,
  creditsRemaining,
  disabledReason,
  isSubmitting,
  submissionPhase,
  hasRecoverableSubmission,
  onGenerate,
  onCancelSubmission,
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
        <span className={`font-semibold ${insufficient ? "text-red-600" : "text-accent"}`}>{creditsRemaining}</span>
      </div>

      {disabledReason ? (
        <p className="mb-2 min-h-5 rounded-md bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{disabledReason}</p>
      ) : null}

      <div className={isSubmitting ? "grid grid-cols-[1fr_auto] gap-2" : undefined}>
        <button
          type="button"
          disabled={disabled}
          onClick={onGenerate}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-ember px-4 text-sm font-bold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-white"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {isSubmitting ? submissionPhaseLabel(submissionPhase) : hasRecoverableSubmission ? "Retry safely" : "Generate"}
        </button>
        {isSubmitting ? (
          <button
            type="button"
            onClick={onCancelSubmission}
            aria-label="Cancel submission"
            className="flex h-12 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-bold text-stone-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-700"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            Cancel
          </button>
        ) : null}
      </div>
      <p className="mt-2 min-h-5 text-xs leading-5 text-stone-500" role="status" aria-live="polite">
        {isSubmitting
          ? submissionPhaseDescription(submissionPhase)
          : hasRecoverableSubmission
            ? "A previous response was interrupted. Retrying reuses its protected request key."
            : "Your job is charged only after the server accepts it."}
      </p>
    </section>
  );
}

function submissionPhaseLabel(phase: SubmissionPhase) {
  if (phase === "uploading") return "Uploading media...";
  if (phase === "creating") return "Creating job...";
  if (phase === "recovering") return "Recovering job...";
  return "Preparing...";
}

function submissionPhaseDescription(phase: SubmissionPhase) {
  if (phase === "uploading") return "Uploading selected inputs. You can cancel before job creation completes.";
  if (phase === "creating") return "Waiting for the server to confirm one protected job.";
  if (phase === "recovering") return "Checking the prior request without creating a duplicate.";
  return "Validating the request and preparing its protected submission key.";
}
