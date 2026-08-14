import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Job, RunpodJobProgress } from "../types";

/**
 * What a running job is doing, from observed state only.
 *
 * Two real sources feed this: the phase our own pipeline is in, and whatever the
 * worker last reported ("Sampling tiles"). It is laid out as a trail -- finished
 * steps above, the current one highlighted -- because the single line it
 * replaced answered "what now?" but never "how far?", which is the question
 * someone waiting actually has.
 *
 * The trail is a record, never a forecast. The graph branches on the
 * enhancement, body and face toggles, so what comes next genuinely is not known
 * in advance; a checklist that guessed the remaining steps would mislead exactly
 * on the unusual runs. For the same reason there is no percentage: the worker
 * counts steps within a node, not nodes within the graph.
 */
const PHASE_LABEL: Record<RunpodJobProgress["phase"], string> = {
  preparing: "Preparing the workflow",
  submitting: "Sending to the pod",
  queued: "Waiting for a worker",
  running: "Processing on the worker",
  saving: "Saving the result",
};

const PHASE_DETAIL: Record<RunpodJobProgress["phase"], string> = {
  preparing: "Building the graph and staging the input images.",
  submitting: "Handing the job to the preset's RunPod endpoint.",
  queued: "Accepted and queued. A cold pod can take a minute to come up.",
  running: "The pod is rendering.",
  saving: "Fetching the render, building previews and filing it into the project.",
};

export function JobProgress({ job }: { job: Job }) {
  const progress = job.runpodProgress;
  const elapsed = useElapsedSeconds(progress?.phaseStartedAt);
  const phaseLabel = progress ? PHASE_LABEL[progress.phase] : fallbackLabel(job.status);
  const completed = progress?.completedSteps ?? [];

  return (
    <div className="w-full max-w-sm">
      {completed.length ? (
        <ol className="mb-2 space-y-1">
          {completed.map((stepLabel) => (
            <li key={stepLabel} className="flex items-center gap-2 text-xs font-medium text-stone-500">
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span className="truncate">{stepLabel}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex items-start gap-2">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{progress?.detail ?? phaseLabel}</p>
          {/* The item number is what makes a restarting step count read as
              progress: enhancement samples one tile at a time. */}
          {progress?.stepTotal ? (
            <p className="mt-0.5 text-xs font-semibold text-stone-500">
              {progress.item ? `tile ${progress.item} · ` : ""}
              step {progress.stepDone ?? 0}/{progress.stepTotal}
            </p>
          ) : null}
        </div>
      </div>

      {/* Indeterminate on purpose: it says "still alive", not "this far along". */}
      <div className="momi-indeterminate-track mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full w-1/3 animate-[momi-indeterminate_1.6s_ease-in-out_infinite] rounded-full bg-accent" />
      </div>

      <p className="mt-2 text-[11px] font-semibold text-stone-500">
        {progress?.detail ? `${phaseLabel} · ` : ""}
        {elapsed != null ? formatDuration(elapsed) : null}
        {progress?.delayMs != null ? ` · queued ${formatDuration(Math.round(progress.delayMs / 1000))}` : ""}
      </p>
      {!progress?.detail && progress ? (
        <p className="mt-1 text-xs font-medium leading-5 text-stone-500">{PHASE_DETAIL[progress.phase]}</p>
      ) : null}
    </div>
  );
}

function fallbackLabel(status: Job["status"]) {
  if (status === "queued") return "Queued";
  if (status === "sending") return "Sending to the pod";
  return "Working";
}

/** Seconds since `startedAt`, re-rendered once a second while mounted. */
function useElapsedSeconds(startedAt?: string) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return undefined;
  const began = new Date(startedAt).getTime();
  if (!Number.isFinite(began)) return undefined;
  // Clamped: a client clock behind the server's would otherwise count backwards.
  return Math.max(0, Math.round((now - began) / 1000));
}

function formatDuration(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
