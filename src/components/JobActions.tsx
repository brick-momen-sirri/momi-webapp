import { Archive, Copy, Download, RefreshCw, RotateCcw, RotateCw, Sparkles, Star, Trash2, XCircle } from "lucide-react";
import type { Job, Project, User } from "../types";
import { canCancelJob } from "../features/jobs/cancellation";
import { draftExpiryText, draftFinalPlan } from "../features/jobs/draftFinal";
import { useNow } from "../utils/useNow";
import { MoveResultMenu } from "./MoveResultMenu";

type JobActionsProps = {
  job: Job;
  project?: Project;
  /** The signed-in account. Required so no surface can forget it and show Cancel to everyone. */
  viewer: Pick<User, "id" | "role"> | undefined;
  isFavorite: boolean;
  canReuseSettings: boolean;
  archiveView: boolean;
  onDownload: (job: Job) => void;
  onCopyImage: (job: Job) => void;
  onReuseSettings: (job: Job) => void;
  onRetry: (job: Job) => void;
  onCancel: (job: Job) => void;
  /** Render an approved draft's final. Absent where finals are not offered. */
  onRenderDraftFinal?: (job: Job) => void;
  /** The newest final of this draft, if one has been started. */
  draftFinalStatus?: Job["status"];
  onToggleFavorite: (job: Job) => void;
  onMove: (job: Job, destinationFolderId: string | null) => Promise<boolean>;
  onArchive: (job: Job) => void;
  onRestore: (job: Job) => void;
  onDeletePermanently: (job: Job) => void;
};

export function JobActions({
  job,
  project,
  viewer,
  isFavorite,
  canReuseSettings,
  archiveView,
  onDownload,
  onCopyImage,
  onReuseSettings,
  onRetry,
  onCancel,
  onRenderDraftFinal,
  draftFinalStatus,
  onToggleFavorite,
  onMove,
  onArchive,
  onRestore,
  onDeletePermanently,
}: JobActionsProps) {
  const result = job.resultUrl ?? job.thumbnailUrl;
  // Draft -> Review -> Final: an approved preview offers its expensive render here.
  // An expired or id-less draft still shows the button, disabled, so the reason is
  // visible on hover instead of the option silently disappearing.
  // Refreshed each minute on an expiring draft, so the button turns off when its countdown ends.
  const now = useNow(60_000, Boolean(job.draft?.expiresAt));
  const finalPlan = !archiveView && onRenderDraftFinal ? draftFinalPlan(job, now) : undefined;
  const finalInFlight = draftFinalStatus === "queued" || draftFinalStatus === "sending" || draftFinalStatus === "running";
  const finalTitle = finalPlan
    ? (finalPlan.refusal ??
      [
        `Render the ${finalPlan.label} from this draft (~${finalPlan.credits.toLocaleString()} credits)`,
        draftFinalStatus === "completed" ? "a final is already in Results" : finalInFlight ? "a final is already on its way" : "",
        draftExpiryText(finalPlan.expiresAt, now) ?? "",
      ]
        .filter(Boolean)
        .join(" · "))
    : undefined;
  const canRetry = !archiveView && (job.status === "failed" || job.status === "canceled");
  // Still working, so there is still GPU time left to save by stopping it -- and
  // only by whoever submitted it or an admin. The server refuses anyone else;
  // hiding it here keeps other artists from meeting that refusal as a toast.
  const canCancel =
    !archiveView &&
    canCancelJob(viewer, job) &&
    (job.status === "queued" || job.status === "sending" || job.status === "running");
  const canceling = canCancel && job.cancelRequested === true;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Sits with Retry at the front of the toolbar: both are about the run
          rather than the result, and only one of them is ever available. The
          dispatcher settles the request on its next poll, so the button stays
          visible as a disabled "Canceling" instead of vanishing on click. */}
      {canCancel ? (
        <button
          type="button"
          onClick={() => onCancel(job)}
          disabled={canceling}
          className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition ${
            canceling
              ? "cursor-not-allowed border-line bg-stone-50 text-stone-400"
              : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
          }`}
          title={canceling ? "Cancel requested; stopping on the pod" : "Stop this job and its remote render"}
        >
          <XCircle className="h-3.5 w-3.5" />
          {canceling ? "Canceling" : "Cancel"}
        </button>
      ) : null}
      {canRetry ? (
        <button
          type="button"
          onClick={() => onRetry(job)}
          className="flex h-8 items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
          title="Retry this job with the same settings"
        >
          <RotateCw className="h-3.5 w-3.5" />
          Retry
        </button>
      ) : null}
      {finalPlan && onRenderDraftFinal ? (
        <button
          type="button"
          onClick={() => onRenderDraftFinal(job)}
          disabled={Boolean(finalPlan.refusal)}
          className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition ${
            finalPlan.refusal
              ? "cursor-not-allowed border-line bg-stone-50 text-stone-400"
              : "border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100"
          }`}
          title={finalTitle}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {draftFinalStatus === "completed" ? `Render ${finalPlan.label} again` : `Render ${finalPlan.label}`}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onDownload(job)}
        disabled={!result}
        className={`flex h-8 w-8 items-center justify-center rounded-md border border-line transition ${
          result ? "text-stone-600 hover:bg-stone-50" : "cursor-not-allowed text-stone-300"
        }`}
        title={job.outputType === "video" || job.outputType === "sequence" ? "Download result" : "Download image"}
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onCopyImage(job)}
        disabled={!result || job.outputType === "video" || job.outputType === "sequence"}
        className={`flex h-8 w-8 items-center justify-center rounded-md border border-line transition ${
          result && job.outputType !== "video" && job.outputType !== "sequence"
            ? "text-stone-600 hover:bg-stone-50"
            : "cursor-not-allowed text-stone-300"
        }`}
        title="Copy image to clipboard"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onReuseSettings(job)}
        disabled={!canReuseSettings}
        className={`flex h-8 w-8 items-center justify-center rounded-md border border-line transition ${
          canReuseSettings ? "text-stone-600 hover:bg-stone-50" : "cursor-not-allowed text-stone-300"
        }`}
        title={canReuseSettings ? "Reuse settings" : "No reusable settings saved"}
        aria-label="Reuse settings"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
      {archiveView ? (
        <>
          <button
            type="button"
            onClick={() => onRestore(job)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-teal-50 hover:text-teal-700"
            title="Restore result"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDeletePermanently(job)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-red-50 hover:text-red-600"
            title="Delete permanently"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <>
          <MoveResultMenu job={job} project={project} onMove={onMove} />
          <button
            type="button"
            onClick={() => onToggleFavorite(job)}
            className={`flex h-8 w-8 items-center justify-center rounded-md border border-line transition ${
              isFavorite ? "bg-amber-50 text-amber-600 hover:bg-amber-100" : "text-stone-600 hover:bg-stone-50"
            }`}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star className={`h-3.5 w-3.5 ${isFavorite ? "fill-current" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => onArchive(job)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-cyan-50 hover:text-cyan-700"
            title="Archive result"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
