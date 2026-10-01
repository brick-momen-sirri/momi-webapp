// The models a Draft -> Final render runs as.
//
// A final is never picked from the model list. It is offered on an approved
// draft's card, and it takes everything from that draft -- prompt, inputs,
// duration -- so it is registered here rather than scanned from workflow/, the
// way the Video Enhancer is. One model per (kind, task category): a job's category
// comes from its model, and a final belongs in the same history section as the
// draft it renders.
//
// Kept free of imports beyond types and config so the credit estimator can read
// it without a cycle through draftFinal.ts, which does the real work.

import path from "node:path";

import { draftFinalWorkflowRoot } from "./config.js";
import type { ModelCategory, WorkflowModel } from "./types.js";

export type DraftFinalKind = "seedance-2.5-draft" | "minimax-h3-768p";

type KindDefinition = {
  slug: string;
  name: string;
  description: string;
  workflowFile: string;
  resolution: { width: number; height: number; label: string };
  durations: { min: number; max: number };
  estimatedTime: string;
};

const KINDS: Readonly<Record<DraftFinalKind, KindDefinition>> = {
  "seedance-2.5-draft": {
    slug: "seedance_2_5",
    name: "Seedance 2.5 Final (1080p)",
    description:
      "Renders the 1080p Seedance 2.5 final of an approved 480p draft. It keeps the draft's scene and motion and reuses " +
      "its prompt, references, duration, aspect ratio and audio setting. A draft can be finalized for 7 days.",
    workflowFile: "seedance-2-5-draft-to-final.json",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durations: { min: 4, max: 30 },
    estimatedTime: "3-8 min",
  },
  "minimax-h3-768p": {
    slug: "minimax_h3_2k",
    name: "MiniMax H3 Final (2K)",
    description:
      "Re-renders an approved MiniMax H3 768P result at 2K with the same prompt and inputs, keeping its motion.",
    workflowFile: "minimax-h3-regenerate-2k.json",
    resolution: { width: 2560, height: 1440, label: "2K" },
    durations: { min: 4, max: 15 },
    estimatedTime: "3-8 min",
  },
};

export const DRAFT_FINAL_KINDS = Object.keys(KINDS) as DraftFinalKind[];

const CATEGORY_SLUGS: Readonly<Partial<Record<ModelCategory, string>>> = {
  image_to_video: "i2v",
  first_last_frame_to_video: "flf2v",
  video_editing: "r2v",
};

const PREFIX = "draft_final_";

export function isDraftFinalKind(value: unknown): value is DraftFinalKind {
  return typeof value === "string" && value in KINDS;
}

export function draftFinalModelId(kind: DraftFinalKind, category: ModelCategory) {
  const categorySlug = CATEGORY_SLUGS[category];
  if (!categorySlug) throw new Error(`A ${category} job cannot have a Draft -> Final render.`);
  return `${PREFIX}${KINDS[kind].slug}_${categorySlug}`;
}

export function parseDraftFinalModelId(modelId: string | undefined) {
  if (!modelId?.startsWith(PREFIX)) return undefined;
  for (const kind of DRAFT_FINAL_KINDS) {
    for (const [category, categorySlug] of Object.entries(CATEGORY_SLUGS) as Array<[ModelCategory, string]>) {
      if (modelId === `${PREFIX}${KINDS[kind].slug}_${categorySlug}`) return { kind, category };
    }
  }
  return undefined;
}

export function isDraftFinalModelId(modelId: string | undefined) {
  return parseDraftFinalModelId(modelId) !== undefined;
}

export function draftFinalKindFromModelId(modelId: string | undefined) {
  return parseDraftFinalModelId(modelId)?.kind;
}

export function draftFinalResolution(kind: DraftFinalKind) {
  return { ...KINDS[kind].resolution };
}

export function draftFinalWorkflowPath(kind: DraftFinalKind) {
  return path.join(draftFinalWorkflowRoot, KINDS[kind].workflowFile);
}

const cache = new Map<string, WorkflowModel>();

/** The registered model for a final id, or undefined for any other id. */
export function draftFinalWorkflowModel(modelId: string): WorkflowModel | undefined {
  const parsed = parseDraftFinalModelId(modelId);
  if (!parsed) return undefined;
  const cached = cache.get(modelId);
  if (cached) return cached;

  const kind = KINDS[parsed.kind];
  const model: WorkflowModel = {
    id: modelId,
    name: kind.name,
    category: parsed.category,
    workflowPath: draftFinalWorkflowPath(parsed.kind),
    description: kind.description,
    // Everything comes from the draft, resolved on the server. The route refuses a
    // final that tries to bring its own prompt or media.
    requiredInputs: [],
    supportedResolutions: [kind.resolution.label],
    defaultResolution: kind.resolution.label,
    supportedDurations: Array.from({ length: kind.durations.max - kind.durations.min + 1 }, (_, index) => kind.durations.min + index),
    defaultDurationSeconds: 5,
    requiresPrompt: false,
    requiresImage: false,
    requiresStartEndFrames: false,
    imageSlotCount: 0,
    outputType: "video",
    estimatedTime: kind.estimatedTime,
  };
  cache.set(modelId, model);
  return model;
}
