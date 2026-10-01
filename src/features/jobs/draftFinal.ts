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
  /** When the provider stops accepting the draft, when it expires at all. */
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
  const plan: DraftFinalPlan = { modelId, label, credits, expiresAt: draft.expiresAt };

  if (job.status !== "completed") return { ...plan, refusal: "Only a completed draft can be finalized." };
  if (draft.kind === "seedance-2.5-draft") {
    const expiresAt = Date.parse(draft.expiresAt ?? "");
    if (!draft.taskId || !Number.isFinite(expiresAt)) {
      return { ...plan, refusal: "This draft did not return a task id, so it cannot be finalized." };
    }
    if (now > expiresAt - SEEDANCE_SAFETY_MS) {
      return { ...plan, refusal: "Seedance drafts can be finalized for 7 days. Render a new draft." };
    }
  }
  return plan;
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
