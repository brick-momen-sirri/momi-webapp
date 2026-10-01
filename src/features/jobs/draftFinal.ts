// Draft -> Review -> Final, from the result card.
//
// A draft job carries `draft` (written by the server when it completed). This
// works out what its final would be -- which registered model, at what size, for
// roughly how much -- so the card can offer it and the confirm dialog can say what
// it costs before anyone pays for it.
//
// The model id mirrors draftFinalModelId in backend/src/draftFinalModels.ts; the
// server checks the id against the draft and refuses a mismatch, so a drift here
// fails loudly rather than rendering the wrong thing.

import type { Job, JobDraft } from "../../types";
import { estimateDraftFinalCredits } from "../../utils/creditEstimator";

const KIND_SLUGS: Record<JobDraft["kind"], string> = {
  "seedance-2.5-draft": "seedance_2_5",
  "minimax-h3-768p": "minimax_h3_2k",
};

const CATEGORY_SLUGS: Record<string, string> = {
  image_to_video: "i2v",
  first_last_frame_to_video: "flf2v",
  video_editing: "r2v",
};

/** Mirrors SEEDANCE_DRAFT_SAFETY_MS on the server: refuse a little before BytePlus would. */
const SEEDANCE_SAFETY_MS = 30 * 60 * 1000;

export type DraftFinalPlan = {
  modelId: string;
  /** "1080p final" or "2K final": what the button says it will make. */
  label: string;
  credits: number;
  /** Why it cannot be rendered now, when it cannot. */
  refusal?: string;
  /**
   * When the final stops being offered, when the draft expires at all: the
   * provider's expiry less the safety margin, the same moment its countdown ends.
   */
  expiresAt?: string;
};

export function draftFinalModelId(kind: JobDraft["kind"], category: string | undefined) {
  const categorySlug = category ? CATEGORY_SLUGS[category] : undefined;
  if (!categorySlug) return undefined;
  return `draft_final_${KIND_SLUGS[kind]}_${categorySlug}`;
}

/** What rendering this job's final would involve, or undefined if it is not a draft. */
export function draftFinalPlan(job: Job, now = Date.now()): DraftFinalPlan | undefined {
  const draft = job.draft;
  if (!draft || job.workflowOptions?.draftFinal) return undefined;
  const modelId = draftFinalModelId(draft.kind, job.backendCategory);
  if (!modelId) return undefined;

  const label = draft.kind === "seedance-2.5-draft" ? "1080p final" : "2K final";
  const credits = estimateDraftFinalCredits(draft.kind, job.durationSeconds, job.backendCategory);
  const countdown = draftCountdown(draft, now);
  const plan: DraftFinalPlan = {
    modelId,
    label,
    credits,
    expiresAt: countdown ? new Date(countdown.deadline).toISOString() : draft.expiresAt,
  };

  if (job.status !== "completed") return { ...plan, refusal: "Only a completed draft can be finalized." };
  if (draft.kind === "seedance-2.5-draft") {
    if (!draft.taskId || !countdown) {
      return { ...plan, refusal: "This draft did not return a task id, so it cannot be finalized." };
    }
    if (countdown.phase === "expired") {
      return { ...plan, refusal: "Seedance drafts can be finalized for 7 days. Render a new draft." };
    }
  }
  return plan;
}

export type DraftCountdownPhase = "fresh" | "soon" | "urgent" | "expired";

export type DraftCountdown = {
  phase: DraftCountdownPhase;
  /** The last moment a final can be started: the provider's expiry less the safety margin. */
  deadline: number;
  remainingMs: number;
  /** The share of the draft's window still left: 1 when it has just finished, 0 at the deadline. */
  fraction: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

const HOUR_MS = 3_600_000;

/**
 * How long a Seedance draft has left, for the countdown on its card.
 *
 * It runs to the moment the button stops offering the final rather than to
 * BytePlus's own expiry, so the clock reaching zero and the button disabling are
 * the same event. Drafts that never expire (MiniMax) have no countdown.
 */
export function draftCountdown(draft: JobDraft | undefined, now = Date.now()): DraftCountdown | undefined {
  if (draft?.kind !== "seedance-2.5-draft") return undefined;
  const expiresAt = Date.parse(draft.expiresAt ?? "");
  if (!Number.isFinite(expiresAt)) return undefined;

  const deadline = expiresAt - SEEDANCE_SAFETY_MS;
  const start = Date.parse(draft.createdAt);
  const windowMs = Number.isFinite(start) && deadline > start ? deadline - start : 7 * 24 * HOUR_MS;
  const remainingMs = Math.max(0, deadline - now);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const phase: DraftCountdownPhase =
    remainingMs <= 0 ? "expired" : remainingMs < 24 * HOUR_MS ? "urgent" : remainingMs < 72 * HOUR_MS ? "soon" : "fresh";

  return {
    phase,
    deadline,
    remainingMs,
    fraction: Math.min(1, remainingMs / windowMs),
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor(totalSeconds / 3_600) % 24,
    minutes: Math.floor(totalSeconds / 60) % 60,
    seconds: totalSeconds % 60,
  };
}

/** Whether a job shows a countdown at all: a finished Seedance draft that is not itself a final. */
export function hasDraftCountdown(job: Job) {
  return job.status === "completed" && job.draft?.kind === "seedance-2.5-draft" && !job.workflowOptions?.draftFinal;
}

/** "6d 23h", "23h 41m", "41m": the countdown in the space a grid tile has. */
export function draftCountdownShortText(countdown: DraftCountdown) {
  if (countdown.phase === "expired") return "Expired";
  if (countdown.days > 0) return `${countdown.days}d ${countdown.hours}h`;
  if (countdown.hours > 0) return `${countdown.hours}h ${countdown.minutes}m`;
  return countdown.minutes > 0 ? `${countdown.minutes}m` : "<1m";
}

/** The finals already started from this draft, newest first, from the jobs in view. */
export function finalsForDraft(draft: Pick<Job, "id">, jobs: Job[]) {
  return jobs
    .filter((candidate) => candidate.workflowOptions?.draftFinal?.sourceJobId === draft.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** "expires in 3 days", "expires in 5 hours", for the button's tooltip. */
export function draftExpiryText(expiresAt: string | undefined, now = Date.now()) {
  const expires = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(expires)) return undefined;
  const hours = Math.max(0, Math.floor((expires - now) / 3_600_000));
  if (hours >= 48) return `expires in ${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "expires within the hour";
}
