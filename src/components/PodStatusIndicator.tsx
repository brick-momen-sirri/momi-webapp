import { Activity, AlertTriangle, Circle, Clock3, Loader2, PauseCircle, PlayCircle, Power, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { PodDisplayStatus, PodStatusResponse } from "../services/backendApi";

type PodStatusIndicatorProps = {
  status?: PodStatusResponse;
};

export function PodStatusIndicator({ status }: PodStatusIndicatorProps) {
  if (!status) {
    return (
      <section className="rounded-lg border border-line bg-white p-2 shadow-panel" aria-label="Pod status loading">
        <div className="flex items-center justify-between">
          <Server className="h-4 w-4 text-stone-500" />
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        </div>
      </section>
    );
  }

  const activePods = status.pods.filter((pod) => pod.currentJob);
  const activeJob = activePods[0]?.currentJob ?? status.queue.activeJobs[0];
  const unavailableTotal = status.stopped + status.unavailable;
  const hasSecondaryIcons = Boolean(activeJob || status.runpod?.healthError);

  return (
    <section className="rounded-lg border border-line bg-white p-2 shadow-panel" aria-label="Pod status">
      <div className="flex items-center justify-between gap-1.5">
        <IconStat
          icon={<Server className="h-4 w-4" />}
          value={status.available}
          title={`Available pods: ${status.available}`}
          className="text-accent"
        />
        <IconStat
          icon={<Activity className="h-4 w-4" />}
          value={status.running}
          title={`Running pods: ${status.running}`}
          className="text-emerald-600"
        />
        <IconStat
          icon={<PauseCircle className="h-4 w-4" />}
          value={status.idle}
          title={`Idle pods: ${status.idle}`}
          className="text-teal-600"
        />
        <IconStat
          icon={<Power className="h-4 w-4" />}
          value={unavailableTotal}
          title={`Stopped or unavailable pods: ${unavailableTotal}`}
          className="text-stone-500"
        />
        <IconStat
          icon={<Clock3 className="h-4 w-4" />}
          value={status.queue.queued}
          title={`Queued tasks: ${status.queue.queued}`}
          className={status.hasQueuedTasks ? "text-amber-600" : "text-stone-400"}
        />
        <span
          className="flex h-7 w-7 items-center justify-center rounded-md bg-mist/70"
          title={`Status: ${status.status}`}
          aria-label={`Status: ${status.status}`}
        >
          <Circle className={`h-3 w-3 fill-current ${statusIconClass(status.status)}`} />
        </span>
      </div>

      {hasSecondaryIcons ? (
        <div className="mt-1.5 flex items-center justify-end gap-1">
          {activeJob ? (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-50 text-emerald-700"
              title={`Processing: ${activeJob.modelName}`}
              aria-label={`Processing: ${activeJob.modelName}`}
            >
              <PlayCircle className="h-3.5 w-3.5" />
            </span>
          ) : null}
          {status.runpod?.healthError ? (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-50 text-amber-700"
              title={status.runpod.healthError}
              aria-label="RunPod health unavailable"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function IconStat({
  icon,
  value,
  title,
  className,
}: {
  icon: ReactNode;
  value: number;
  title: string;
  className: string;
}) {
  return (
    <div
      className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md bg-mist/70 px-1.5 text-[11px] font-bold ${className}`}
      title={title}
      aria-label={title}
    >
      {icon}
      <span className="text-ink">{value}</span>
    </div>
  );
}

function statusIconClass(status: PodDisplayStatus) {
  if (status === "running") return "text-emerald-500";
  if (status === "queued") return "text-amber-500";
  if (status === "idle") return "text-teal-500";
  if (status === "error") return "text-red-500";
  return "text-stone-400";
}
