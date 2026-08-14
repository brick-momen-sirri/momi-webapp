import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Job, RunpodJobProgress } from "../types";

/**
 * What a running job is doing, from observed state only.
 *
 * Two real sources feed this: the phase our own pipeline is in, and whatever the
 * worker last reported over its progress stream ("Sampling tiles"). The worker's
 * own words win when it has any, because that is what someone staring at a slow
 * render actually wants to know.
 *
 * There is still no percentage, and that is deliberate. The stream says which
 * node is running, never how far through the graph it is; momi-forge turns that
 * into a bar by assigning each node a hardcoded ratio, which is an estimate
 * wearing a measurement's clothes and reads worst on exactly the slow jobs
 * people watch hardest.
 *
 * The elapsed time ticks here rather than being written by the server, so a
 * long render costs no database traffic to display.
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
  queued: "The job is accepted and queued. A cold pod can take a minute to come up.",
  running: "The pod is rendering. This preset reports no step detail while it works.",
  saving: "Fetching the render, building previews and filing it into the project folder.",
};

export function JobProgress({ job }: { job: Job }) {
  const progress = job.runpodProgress;
  const elapsed = useElapsedSeconds(progress?.phaseStartedAt);

  // Falls back to the job's own status for anything that has not reported a
  // phase yet -- an older job, or one still queued behind the dispatcher.
  const label = progress ? PHASE_LABEL[progress.phase] : fallbackLabel(job.status);
  // What the worker itself last said, when it says anything. Preferred over the
  // generic phase blurb: "Sampling tiles" is the answer to what someone staring
  // at a slow render actually wants to know.
  const detail = progress?.detail ?? (progress ? PHASE_DETAIL[progress.phase] : undefined);

  return (
    <div className="w-full max-w-md text-center">
      <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent" />
      <p className="mt-3 text-sm font-bold text-ink">{progress?.detail ?? label}</p>
      {progress?.detail ? (
        <p className="mt-1 text-xs font-medium leading-5 text-stone-500">{label}</p>
      ) : detail ? (
        <p className="mt-1 text-xs font-medium leading-5 text-stone-500">{detail}</p>
      ) : null}

      {/* Indeterminate on purpose: it says "still alive", not "this far along". */}
      <div className="momi-indeterminate-track mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full w-1/3 animate-[momi-indeterminate_1.6s_ease-in-out_infinite] rounded-full bg-accent" />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] font-semibold text-stone-500">
        {elapsed != null ? <span>{formatDuration(elapsed)} in this stage</span> : null}
        {progress?.delayMs != null ? <span>queued {formatDuration(Math.round(progress.delayMs / 1000))}</span> : null}
        {progress?.workerId ? <span className="font-mono">worker {progress.workerId.slice(0, 8)}</span> : null}
        {progress?.runpodStatus ? <span className="font-mono">{progress.runpodStatus}</span> : null}
      </div>
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
