import { useEffect, useState } from "react";
import { Calendar, Check, ChevronDown, ChevronUp, Film, Hash, Images, Loader2, Pencil, UserRound, X } from "lucide-react";
import type { Job, Project, User } from "../types";
import { cn } from "../utils/classNames";
import { getJobSaveNumber, getJobSaveNumberLabel } from "../utils/saveNumber";
import { JobActions } from "./JobActions";
import { JobMetadata } from "./JobMetadata";
import { JobPreview } from "./JobPreview";

type JobCardProps = {
  job: Job;
  project?: Project;
  user?: User;
  isFavorite: boolean;
  canReuseSettings: boolean;
  archiveView: boolean;
  onDownload: (job: Job) => void;
  onCopyImage: (job: Job) => void;
  onReuseSettings: (job: Job) => void;
  onRetry: (job: Job) => void;
  onToggleFavorite: (job: Job) => void;
  onMove: (job: Job, destinationFolderId: string | null) => Promise<boolean>;
  onArchive: (job: Job) => void;
  onRestore: (job: Job) => void;
  onDeletePermanently: (job: Job) => void;
  canEditSaveNumber: boolean;
  onUpdateSaveNumber: (job: Job, saveNumber: string) => void;
};

export function JobCard({
  job,
  project,
  user,
  isFavorite,
  canReuseSettings,
  archiveView,
  onDownload,
  onCopyImage,
  onReuseSettings,
  onRetry,
  onToggleFavorite,
  onMove,
  onArchive,
  onRestore,
  onDeletePermanently,
  canEditSaveNumber,
  onUpdateSaveNumber,
}: JobCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingSaveNumber, setEditingSaveNumber] = useState(false);
  const isLong = job.prompt.length > 130;
  const hasSaveNumber = Boolean(job.workflowOptions?.save?.cameraNumber || job.workflowOptions?.save?.shotNumber);
  const showSaveNumber = job.source !== "existing_project_media" || hasSaveNumber || canEditSaveNumber;
  const saveNumberLabel = getJobSaveNumberLabel(job);
  const saveNumber = getJobSaveNumber(job);
  const [saveDraft, setSaveDraft] = useState(saveNumber);
  const displayTitle = job.modelType || job.title?.trim() || "Unknown workflow";

  function submitSaveNumber() {
    const digits = saveDraft.replace(/\D/g, "").slice(0, 4);
    if (!digits) return;
    onUpdateSaveNumber(job, digits);
    setEditingSaveNumber(false);
  }

  return (
    <article
      className={cn(
        "rounded-lg border bg-white p-4 shadow-card",
        job.status === "completed" ? "border-teal-200" : "border-line",
      )}
    >
      <div className="flex flex-col gap-3 border-b border-line pb-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={job.status} />
            <h2 className="text-sm font-bold">{displayTitle}</h2>
            {displayTitle !== job.modelType ? (
              <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
                {job.modelType}
              </span>
            ) : null}
            {job.missingMetadata?.length ? (
              <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700">
                Missing metadata
              </span>
            ) : null}
            {job.hasUnsavedRemoteMedia ? (
              <span
                className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700"
                title="This result is still on the generation service and has not been saved to the project drive yet. The backend retries automatically; if this persists, check backend disk space and logs."
              >
                Not saved locally
              </span>
            ) : null}
            {job.source === "existing_project_media" ? (
              <span className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700">
                Existing media
              </span>
            ) : null}
            {archiveView ? (
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-semibold text-zinc-700">
                Archived
              </span>
            ) : null}
            <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
              {project?.name ?? "Unknown project"}
            </span>
            {job.folderName ? (
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">
                {job.folderName}
              </span>
            ) : null}
            {showSaveNumber && editingSaveNumber ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-200 bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">
                <Hash className="h-3 w-3" />
                <span>{saveNumberLabel}</span>
                <input
                  value={saveDraft}
                  onChange={(event) => setSaveDraft(event.target.value.replace(/\D/g, "").slice(0, 4))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitSaveNumber();
                    if (event.key === "Escape") {
                      setSaveDraft(saveNumber);
                      setEditingSaveNumber(false);
                    }
                  }}
                  inputMode="numeric"
                  maxLength={4}
                  className="h-6 w-14 rounded border border-cyan-200 bg-white px-1.5 font-mono text-[11px] font-bold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  aria-label={`${saveNumberLabel} number`}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={submitSaveNumber}
                  className="flex h-5 w-5 items-center justify-center rounded text-teal-700 transition hover:bg-white"
                  title="Save shot/camera"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSaveDraft(saveNumber);
                    setEditingSaveNumber(false);
                  }}
                  className="flex h-5 w-5 items-center justify-center rounded text-stone-500 transition hover:bg-white"
                  title="Cancel"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : showSaveNumber ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">
                <Hash className="h-3 w-3" />
                {saveNumberLabel} {saveNumber}
                {canEditSaveNumber ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSaveDraft(saveNumber);
                      setEditingSaveNumber(true);
                    }}
                    className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-cyan-700 transition hover:bg-white"
                    title="Edit shot/camera"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-stone-500">
            <span className="flex items-center gap-1">
              <UserRound className="h-3.5 w-3.5" />
              {user?.name ?? "Unknown user"}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {new Intl.DateTimeFormat("en", {
                month: "short",
                day: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(job.createdAt))}
            </span>
            {archiveView && job.archivedAt ? (
              <span className="flex items-center gap-1">
                Archived{" "}
                {new Intl.DateTimeFormat("en", {
                  month: "short",
                  day: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(job.archivedAt))}
              </span>
            ) : null}
          </div>
        </div>
        <JobActions
          job={job}
          project={project}
          isFavorite={isFavorite}
          canReuseSettings={canReuseSettings}
          archiveView={archiveView}
          onDownload={onDownload}
          onCopyImage={onCopyImage}
          onReuseSettings={onReuseSettings}
          onRetry={onRetry}
          onToggleFavorite={onToggleFavorite}
          onMove={onMove}
          onArchive={onArchive}
          onRestore={onRestore}
          onDeletePermanently={onDeletePermanently}
        />
      </div>

      <div className="py-4">
        <section className="input-section rounded-lg border border-line bg-white/60 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-stone-500">
            <Images className="h-3.5 w-3.5" />
            Input preview
          </div>

          <div className="flex flex-wrap gap-3">
            {job.inputImages.length ? (
              <div className="flex flex-wrap gap-2">
                {job.inputImages.map((image, index) => (
                  <div
                    key={`${job.id}-${image}`}
                    className="relative h-20 w-32 overflow-hidden rounded-md border border-line bg-stone-100"
                  >
                    <img src={image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    {job.inputImages.length > 1 ? (
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold">
                        {job.inputType === "start_end_frames" ? (index === 0 ? "Start frame" : "End frame") : `Input ${index + 1}`}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {job.inputVideo ? (
              <div className="relative h-20 w-32 overflow-hidden rounded-md border border-line bg-stone-100">
                <video src={job.inputVideo} className="h-full w-full object-cover" preload="metadata" muted />
                <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold">
                  <Film className="h-3 w-3" />
                  Video
                </span>
              </div>
            ) : null}

            {!job.inputImages.length && !job.inputVideo && job.source === "existing_project_media" ? (
              <div className="flex h-20 w-32 items-center justify-center rounded-md border border-line bg-mist/70 px-2 text-center text-xs font-semibold text-stone-500">
                No input media
              </div>
            ) : null}

            {!job.inputImages.length && !job.inputVideo && job.source !== "existing_project_media" ? (
              <div className="flex h-20 w-32 items-center justify-center rounded-md border border-dashed border-line bg-mist/70 text-xs font-semibold text-stone-500">
                Text only
              </div>
            ) : null}

            <div className="min-w-[260px] flex-1">
              {job.fileName ? <p className="mb-1 truncate font-mono text-xs text-stone-500">{job.fileName}</p> : null}
              <p
                className={`text-sm leading-6 text-stone-800 ${
                  expanded
                    ? ""
                    : "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
                }`}
              >
                {job.prompt}
              </p>
              {isLong ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-2 flex items-center gap-1 text-xs font-semibold text-stone-500 transition hover:text-ink"
                >
                  {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          </div>
        </section>

        {IN_FLIGHT_STATUSES.includes(job.status) ? <InFlightProgress job={job} /> : null}

        <section className="result-section mt-4 flex justify-center">
          <div className="w-full max-w-5xl">
          <JobPreview job={job} />
        </div>
        </section>
      </div>

      <JobMetadata job={job} project={project} user={user} />
    </article>
  );
}

const IN_FLIGHT_STATUSES: Job["status"][] = ["queued", "sending", "running"];

const inFlightLabels: Record<string, string> = {
  queued: "Waiting in queue",
  sending: "Sending to backend",
  running: "Generating",
};

function StatusBadge({ status }: { status: Job["status"] }) {
  const classes = {
    queued: "bg-stone-100 text-stone-700",
    sending: "bg-cyan-50 text-cyan-700",
    running: "bg-blue-50 text-blue-700",
    completed: "bg-teal-50 text-teal-700",
    failed: "bg-red-50 text-red-700",
    canceled: "bg-zinc-100 text-zinc-600",
  }[status];

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold capitalize ${classes}`}>
      {IN_FLIGHT_STATUSES.includes(status) ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {status}
    </span>
  );
}

function InFlightProgress({ job }: { job: Job }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const startText = job.startedAt ?? job.createdAt;
  const startMs = startText ? new Date(startText).getTime() : Number.NaN;
  const elapsedMs = Number.isFinite(startMs) ? Math.max(0, now - startMs) : 0;
  const label = inFlightLabels[job.status] ?? "Working";

  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs font-semibold text-blue-700">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span>{label}</span>
      <span className="ml-auto tabular-nums text-blue-600">{formatElapsed(elapsedMs)} elapsed</span>
    </div>
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
