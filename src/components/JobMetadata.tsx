import { CalendarDays, CheckCircle2, Clock3, Coins, Folder, Gauge, Hash, ImageIcon, Maximize2, UserRound } from "lucide-react";
import type { Job, Project, User } from "../types";
import { getJobSaveNumber, getJobSaveNumberLabel } from "../utils/saveNumber";

type JobMetadataProps = {
  job: Job;
  project?: Project;
  user?: User;
};

export function JobMetadata({ job, project, user }: JobMetadataProps) {
  const hasSaveNumber = Boolean(job.workflowOptions?.save?.cameraNumber || job.workflowOptions?.save?.shotNumber);
  const saveNumber = job.source === "existing_project_media" && !hasSaveNumber ? "" : getJobSaveNumber(job);
  const items = [
    { icon: CheckCircle2, label: "Status", value: job.status },
    { icon: Gauge, label: "Model", value: job.modelType },
    { icon: ImageIcon, label: "Input", value: job.inputType.replaceAll("_", " ") },
    { icon: Hash, label: getJobSaveNumberLabel(job), value: saveNumber },
    { icon: Folder, label: "Project", value: project?.shortName ?? "Unknown" },
    { icon: UserRound, label: "User", value: user?.name ?? (job.source === "existing_project_media" ? "" : "Unknown") },
    { icon: Maximize2, label: "Resolution", value: formatResolution(job.outputResolution) },
    { icon: CalendarDays, label: "Created", value: formatDate(job.createdAt) },
    { icon: Clock3, label: "Time", value: job.generationTime ?? job.videoLength ?? "" },
    { icon: Coins, label: "Credits", value: job.creditsUsed == null && job.source === "existing_project_media" ? "" : formatCredits(job.creditsUsed ?? 0) },
  ].filter((item) => item.value !== "");

  return (
    <div className="grid gap-2 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-10">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="min-w-0 rounded-md bg-mist/70 px-2 py-1.5">
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              <Icon className="h-3 w-3" />
              {item.label}
            </span>
            <p className="mt-1 truncate text-xs font-semibold capitalize text-ink">{item.value}</p>
          </div>
        );
      })}
      <div className="min-w-0 rounded-md bg-mist/70 px-2 py-1.5 sm:col-span-2 lg:col-span-4 xl:col-span-10">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">Job ID</span>
        <p className="mt-1 truncate font-mono text-xs text-stone-700">{job.id}</p>
      </div>
      {job.errorMessage ? (
        <div className="min-w-0 rounded-md border border-red-100 bg-red-50 px-2 py-1.5 sm:col-span-2 lg:col-span-4 xl:col-span-10">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-red-500">Error</span>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-red-800">{job.errorMessage}</p>
        </div>
      ) : null}
    </div>
  );
}

function formatResolution(value: Job["outputResolution"]) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return "Unknown";
  const width = Math.round(value.width);
  const height = Math.round(value.height);
  if (width <= 0 || height <= 0) return "Unknown";
  return `${width} × ${height}`;
}

function formatCredits(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
