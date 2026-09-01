// Putting an editing session back together from the jobs it left behind.
//
// The layer stack lives in the browser and dies with the tab, but nothing in it
// is actually lost: every generated layer is a job, and each of those jobs
// records the document it belonged to, the crop it occupied, the mask it was
// generated through, and the original it was painted on. `documentId` has been
// written on every edit job since the preset shipped and read by nothing.
//
// So this module is a reader, not a store. It groups those jobs, picks the take
// that survived for each layer, and hands back a stack the editor can open --
// which is what turns Finish from a wall into a checkpoint, and a reload from a
// lost afternoon into an inconvenience.
//
// What comes back is not quite what was there. The wire carries a layer's
// geometry, its mask, its opacity and its position, but nothing ever recorded
// whether it was hidden, whether its mask was switched off or unchained, or how
// it was feathered -- those are session state that only mattered while the
// composite was on screen. They come back at their defaults, and `restoredEdit`
// says so rather than pretending otherwise.

import { resolveMediaUrl } from "../../services/api/mediaAccess";
import type { Job, StillImageEditBaseLayer, StillImageEditWorkflow } from "../../types";
import { baseRevisionId } from "./imageEditLayers";
import { measuredJobSpend } from "./podRuntimeCost";
import type { MaskDrawing } from "./maskDrawing";
import type { StillImageEditLayer } from "./stillImageCategories";

export type RestoredEditDocument = {
  documentId: string;
  /** The untouched picture every layer sits on, as durable project media. */
  originalSourceUrl: string;
  layers: StillImageEditLayer[];
  /** Layers whose order could only be guessed at, for the UI to mention. */
  inferredOrder: boolean;
};

/**
 * Which document a job belongs to, whether it made a layer or flattened one.
 *
 * A generated layer records it on its edit metadata; the finalized composite is
 * not an edit at all and records it in its settings bag, which is the only
 * reason a Results card can be traced back to the session that produced it.
 */
export function editDocumentIdOfJob(job: Job): string | undefined {
  const stillImage = job.workflowOptions?.stillImage;
  if (stillImage?.edit?.documentId) return stillImage.edit.documentId;
  const finalized = stillImage?.settings?.documentId;
  return typeof finalized === "string" && finalized ? finalized : undefined;
}

/** Was this job the flattened composite rather than one of the layers? */
export function isFinalizedCompositeJob(job: Job) {
  return job.workflowOptions?.stillImage?.settings?.finalizedComposite === true;
}

/** Every document present in a job list, newest first, for a picker or a resume. */
export function editDocumentsFromJobs(jobs: Job[]) {
  const byDocument = new Map<string, { documentId: string; jobs: Job[]; updatedAt: string }>();
  for (const job of jobs) {
    const documentId = editDocumentIdOfJob(job);
    if (!documentId) continue;
    const entry = byDocument.get(documentId) ?? { documentId, jobs: [], updatedAt: "" };
    entry.jobs.push(job);
    const at = jobTime(job);
    if (at > entry.updatedAt) entry.updatedAt = at;
    byDocument.set(documentId, entry);
  }
  return [...byDocument.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The spend a finalized composite carries, stamped when it was flattened.
 *
 * Preferred over adding up jobs in the browser, which can only see the page it
 * has loaded: this figure was computed on the server at the one moment every job
 * of the session was reachable, so it stays right forever. Absent on composites
 * finished before it was recorded, and absent is shown as nothing rather than as
 * a total that might be missing half a session.
 */
export function finalizedSessionSpend(job: Job) {
  const settings = job.workflowOptions?.stillImage?.settings;
  if (!settings?.finalizedComposite) return undefined;
  const generations = settings.sessionGenerations;
  const podUsd = settings.sessionPodUsd;
  const podCredits = settings.sessionPodCredits;
  const comfyUsd = settings.sessionComfyUsd;
  const comfyCredits = settings.sessionComfyCredits;
  if (
    typeof generations !== "number" ||
    typeof podUsd !== "number" ||
    typeof podCredits !== "number" ||
    typeof comfyUsd !== "number" ||
    typeof comfyCredits !== "number"
  ) {
    return undefined;
  }
  // Totals are derived, never stored: a stored one could drift from its parts.
  return {
    generations,
    podUsd,
    podCredits,
    comfyUsd,
    comfyCredits,
    usd: podUsd + comfyUsd,
    credits: Math.round((podCredits + comfyCredits) * 100) / 100,
  };
}

export type EditSessionCost = {
  /** Generations that were paid for, including takes that were replaced. */
  generations: number;
  /** Layers those generations produced, which is fewer once anything was redone. */
  layers: number;
  /** RunPod worker time, rented by the second. */
  podUsd: number;
  podCredits: number;
  /** Comfy credits: the partner API nodes the graph called. */
  comfyUsd: number;
  comfyCredits: number;
  usd: number;
  credits: number;
  /** Generations whose spend could not be measured, so the total is a floor. */
  unmeasured: number;
};

/**
 * What one editing session has cost so far.
 *
 * Counts **every** generation the document has paid for, not the layers that
 * survived: a regenerated layer was billed twice and a deleted one was still
 * billed once. A total that quietly dropped the takes an artist discarded would
 * be answering "what is on screen" when the question is "what has this cost".
 *
 * `unmeasured` is the honesty valve. A run whose worker time RunPod never
 * reported cannot be priced, so it is counted separately rather than as zero,
 * and a session containing one is a floor rather than a figure.
 */
export function editSessionCost(jobs: Job[], documentId: string | undefined): EditSessionCost {
  const cost: EditSessionCost = {
    generations: 0,
    layers: 0,
    podUsd: 0,
    podCredits: 0,
    comfyUsd: 0,
    comfyCredits: 0,
    usd: 0,
    credits: 0,
    unmeasured: 0,
  };
  if (!documentId) return cost;

  const layers = new Set<string>();
  for (const job of jobs) {
    const edit = job.workflowOptions?.stillImage?.edit;
    if (edit?.documentId !== documentId) continue;
    // A job still queued or running has not been priced yet, and a failed one
    // never produced anything -- neither belongs in a spend figure.
    if (job.status !== "completed") continue;

    cost.generations += 1;
    if (edit.generatedCropUrl) layers.add(edit.layerId);

    const spend = measuredJobSpend(job);
    if (!spend) {
      cost.unmeasured += 1;
      continue;
    }
    cost.podUsd += spend.podUsd;
    cost.podCredits += spend.podCredits;
    cost.comfyUsd += spend.comfyUsd;
    cost.comfyCredits += spend.comfyCredits;
  }

  cost.layers = layers.size;
  cost.podCredits = Math.round(cost.podCredits * 100) / 100;
  cost.comfyCredits = Math.round(cost.comfyCredits * 100) / 100;
  cost.usd = cost.podUsd + cost.comfyUsd;
  cost.credits = Math.round((cost.podCredits + cost.comfyCredits) * 100) / 100;
  return cost;
}

/**
 * Rebuild one document's layer stack.
 *
 * Undefined when nothing in the list generated a layer for it -- a document
 * whose only job is the flattened composite has a picture but no stack, and
 * offering to reopen it would open an empty editor.
 */
export function restoreEditDocument(jobs: Job[], documentId: string): RestoredEditDocument | undefined {
  const takes = latestTakePerLayer(jobs, documentId);
  if (!takes.length) return undefined;

  const originalSourceUrl = takes[0].edit.originalSourceUrl;
  const placements = placementsFromBases(takes);
  const ordering = layerOrdering(takes);

  const layers = takes
    .map((take) => restoredLayer(take, placements.get(take.edit.layerId)))
    .sort((a, b) => ordering.indexOf(a.id) - ordering.indexOf(b.id))
    .map((layer, order) => ({ ...layer, order }));

  return { documentId, originalSourceUrl, layers, inferredOrder: !recordedOrderCovers(takes, ordering) };
}

type Take = { job: Job; edit: StillImageEditWorkflow };

/**
 * One take per layer: the newest job that produced a usable crop for it.
 *
 * A regeneration creates a second job for the same layerId, and a failed one
 * creates a job with no crop at all. Reopening should land on the picture the
 * artist last saw, which is the newest job that actually produced pixels.
 */
function latestTakePerLayer(jobs: Job[], documentId: string): Take[] {
  const byLayer = new Map<string, Take>();
  for (const job of jobs) {
    const edit = job.workflowOptions?.stillImage?.edit;
    if (!edit || edit.documentId !== documentId || !edit.generatedCropUrl) continue;
    const existing = byLayer.get(edit.layerId);
    if (!existing || jobTime(job) > jobTime(existing.job)) byLayer.set(edit.layerId, { job, edit });
  }
  return [...byLayer.values()].sort((a, b) => jobTime(a.job).localeCompare(jobTime(b.job)));
}

/**
 * Opacity and position, recovered from whoever was generated on top.
 *
 * A layer's own job cannot carry them -- they are set after it exists. But the
 * next generation freezes the stack beneath it as `baseLayers`, and those
 * entries carry both. Newest first, so the last state anything observed wins.
 */
function placementsFromBases(takes: Take[]) {
  const placements = new Map<string, StillImageEditBaseLayer>();
  for (const take of [...takes].reverse()) {
    for (const base of take.edit.baseLayers) {
      if (!placements.has(base.layerId)) placements.set(base.layerId, base);
    }
  }
  return placements;
}

/**
 * The stack order, as far as anything recorded it.
 *
 * The newest generation froze the layers beneath it in order, so that list is a
 * real record of the stack at that moment -- including any reordering the artist
 * had done by then. Layers it does not mention (hidden at the time, or created
 * after it) fall back to creation order on top of it, which is where a new edit
 * would have gone anyway.
 */
function layerOrdering(takes: Take[]) {
  const known = new Set(takes.map((take) => take.edit.layerId));
  const newest = takes[takes.length - 1];
  const order = newest.edit.baseLayerIds.filter((layerId) => known.has(layerId));
  for (const take of takes) {
    if (!order.includes(take.edit.layerId)) order.push(take.edit.layerId);
  }
  return order;
}

/** Did a real record cover every layer, or did creation order fill gaps? */
function recordedOrderCovers(takes: Take[], ordering: string[]) {
  if (takes.length < 2) return true;
  const recorded = new Set(takes[takes.length - 1].edit.baseLayerIds);
  // The newest layer is on top by definition, so it needs no record of its own.
  return ordering.slice(0, -1).every((layerId) => recorded.has(layerId));
}

function restoredLayer(take: Take, placement: StillImageEditBaseLayer | undefined): StillImageEditLayer {
  const { job, edit } = take;
  return {
    id: edit.layerId,
    name: layerName(edit.layerId, job.prompt),
    mask: edit.mask as MaskDrawing,
    crop: edit.crop,
    prompt: job.prompt ?? "",
    mode: edit.mode,
    references: edit.referenceSourceUrls.map((sourceUrl, index) => ({
      id: `${edit.layerId}_ref_${index + 1}`,
      name: `Reference ${index + 1}`,
      sourceUrl,
    })),
    documentId: edit.documentId,
    originalSourceUrl: edit.originalSourceUrl,
    jobId: job.id,
    createdAt: job.createdAt,
    updatedAt: jobTime(job),
    // Never recorded, because they only ever mattered on screen.
    visible: true,
    maskEnabled: true,
    maskLinked: true,
    maskFeather: 0,
    opacity: placement?.opacity ?? 100,
    offset: placement?.offset ?? { x: 0, y: 0 },
    order: 0,
    revision: 0,
    status: job.status,
    errorMessage: job.errorMessage,
    resultUrl: job.resultUrl,
    generatedCropSourceUrl: edit.generatedCropUrl,
    generatedCropUrl: edit.generatedCropUrl ? resolveMediaUrl(edit.generatedCropUrl) : undefined,
    maskSourceUrl: edit.maskSourceUrl,
    baseLayers: edit.baseLayers,
    baseRevisionId: baseRevisionId(edit.baseLayers),
    generation: {
      jobId: job.id,
      workflow: job.workflowOptions?.stillImage?.categoryId === "general-enhancement" ? "general-enhancement" : "image-editing",
      workflowPath: job.workflowPath,
      modelId: job.modelId,
      seed: job.workflowOptions?.stillImage?.seed,
      settings: job.workflowOptions?.stillImage?.settings ?? {},
    },
  };
}

/**
 * A name for a layer whose name was never stored.
 *
 * The prompt is what an artist recognises a layer by, so a short one becomes the
 * name outright and a long one is trimmed at a word. Only a promptless enhance
 * layer falls back to a number.
 */
function layerName(layerId: string, prompt: string | undefined) {
  const trimmed = (prompt ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return `Edit ${layerId.slice(-4)}`;
  if (trimmed.length <= 32) return trimmed;
  const cut = trimmed.slice(0, 32);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 12 ? cut.slice(0, lastSpace) : cut}…`;
}

function jobTime(job: Job) {
  return job.completedAt ?? job.startedAt ?? job.createdAt ?? "";
}
