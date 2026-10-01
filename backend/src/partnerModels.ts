import table from "./data/partnerModels.json" with { type: "json" };
import type { WorkflowModel, WorkflowOptions } from "./types.js";

/**
 * Partner-API model families, and the variants each one offers.
 *
 * The data is backend/src/data/partnerModels.json, shared with the frontend the way
 * seedanceVersions.json is; see the comment at the top of that file for what each
 * field means and where the numbers come from.
 *
 * A variant is one workflow file. workflowService still discovers it by scanning
 * workflow/ and still infers everything the file can tell it; this module only
 * layers on what the file cannot say. That keeps a family's older members -- GPT
 * Image 2, Nano Banana 2 -- exactly as they were, while a new member declares its
 * own limits instead of adding another file-name heuristic.
 */

export type PartnerModelResolution = {
  /** What the picker offers and sends as resolution.label. */
  value: string;
  label: string;
  width: number;
  height: number;
  /** The value the node's `resolution` combo takes, when it differs from `value`. */
  nodeValue?: string;
  /** Seedream's `size_preset` label; "Custom" sends width and height instead. */
  sizePreset?: string;
  /** Size a Custom request to the first input's aspect at width*height pixels. */
  matchInput?: boolean;
  /** The preset a matchInput request falls back to when there is no input to match. */
  fallbackSizePreset?: string;
};

export type PartnerModelPricing = {
  perImageUsd?: Record<string, number>;
  perReferenceImageUsd?: number;
  perSecondUsd?: Record<string, number>;
  maxExtraUsd?: Record<string, number>;
};

export type PartnerModelDraft = {
  kind: string;
  /** The output resolution that counts as a draft. Absent means any. */
  resolution?: string;
};

export type PartnerModelVariant = {
  modelId: string;
  label: string;
  hint: string;
  name?: string;
  description?: string;
  default?: boolean;
  maxReferenceImages?: number;
  supportsTextOnly?: boolean;
  randomizeSeed?: boolean;
  defaultResolution?: string;
  resolutions?: PartnerModelResolution[];
  durations?: { min: number; max: number; default: number };
  pricing?: PartnerModelPricing;
  draft?: PartnerModelDraft;
};

export type PartnerModelFamily = {
  id: string;
  label: string;
  provider: string;
  variants: PartnerModelVariant[];
};

type TableShape = { families: PartnerModelFamily[] };

/**
 * Validated at load, like the Seedance table: a malformed row would otherwise
 * surface as a refused submission or a job that fails inside ComfyUI.
 */
export const partnerModelFamilies: readonly PartnerModelFamily[] = assertTableShape(table as unknown as TableShape);

const variantsByModelId = new Map<string, { family: PartnerModelFamily; variant: PartnerModelVariant }>(
  partnerModelFamilies.flatMap((family) => family.variants.map((variant) => [variant.modelId, { family, variant }] as const)),
);

export function assertTableShape(shape: TableShape): PartnerModelFamily[] {
  const families = shape.families;
  if (!Array.isArray(families)) throw new Error("partnerModels.json has no families list.");
  const familyIds = new Set<string>();
  const modelIds = new Set<string>();

  for (const family of families) {
    if (!family.id || !family.label || !family.provider) {
      throw new Error("partnerModels.json has a family without an id, label or provider.");
    }
    if (familyIds.has(family.id)) throw new Error(`partnerModels.json lists family ${family.id} twice.`);
    familyIds.add(family.id);
    if (!Array.isArray(family.variants) || !family.variants.length) {
      throw new Error(`partnerModels.json gives family ${family.id} no variants.`);
    }

    for (const variant of family.variants) {
      const where = `partnerModels.json variant ${variant.modelId || "(no modelId)"}`;
      if (!variant.modelId || !variant.label || !variant.hint) throw new Error(`${where} needs a modelId, label and hint.`);
      if (!/^[a-z0-9_]+$/.test(variant.modelId)) {
        throw new Error(`${where} is not a workflow slug; it must match what workflowService derives from the file name.`);
      }
      if (modelIds.has(variant.modelId)) throw new Error(`${where} is listed twice.`);
      modelIds.add(variant.modelId);

      if (variant.resolutions) {
        const values = new Set<string>();
        for (const resolution of variant.resolutions) {
          if (!resolution.value || !resolution.label) throw new Error(`${where} has a resolution without a value or label.`);
          if (!positiveInteger(resolution.width) || !positiveInteger(resolution.height)) {
            throw new Error(`${where} gives resolution ${resolution.value} an impossible size.`);
          }
          if (values.has(normalizeKey(resolution.value))) throw new Error(`${where} lists resolution ${resolution.value} twice.`);
          values.add(normalizeKey(resolution.value));
          if (resolution.matchInput && !resolution.fallbackSizePreset) {
            throw new Error(`${where} resolution ${resolution.value} matches the input but has no fallback preset.`);
          }
        }
        if (variant.defaultResolution && !values.has(normalizeKey(variant.defaultResolution))) {
          throw new Error(`${where} has a defaultResolution it does not list.`);
        }
      }

      if (variant.durations) {
        const { min, max, default: fallback } = variant.durations;
        if (!positiveInteger(min) || !positiveInteger(max) || max < min) {
          throw new Error(`${where} has an impossible duration range.`);
        }
        if (!Number.isInteger(fallback) || fallback < min || fallback > max) {
          throw new Error(`${where} has a default duration outside its range.`);
        }
      }

      if (variant.maxReferenceImages != null && !positiveInteger(variant.maxReferenceImages)) {
        throw new Error(`${where} has an impossible maxReferenceImages.`);
      }

      const pricing = variant.pricing;
      if (pricing) {
        for (const rates of [pricing.perImageUsd, pricing.perSecondUsd, pricing.maxExtraUsd]) {
          if (!rates) continue;
          if (!("*" in rates)) throw new Error(`${where} has a rate table with no "*" fallback.`);
          if (!Object.values(rates).every((rate) => Number.isFinite(rate) && rate >= 0)) {
            throw new Error(`${where} has a negative or non-numeric rate.`);
          }
        }
        if (pricing.perImageUsd && pricing.perSecondUsd) {
          throw new Error(`${where} is priced both per image and per second.`);
        }
        if (pricing.perReferenceImageUsd != null && !(Number.isFinite(pricing.perReferenceImageUsd) && pricing.perReferenceImageUsd >= 0)) {
          throw new Error(`${where} has an impossible perReferenceImageUsd.`);
        }
      }

      if (variant.draft && !variant.draft.kind) throw new Error(`${where} has a draft without a kind.`);
    }
  }

  return families;
}

export function partnerModelEntry(modelId: string | undefined) {
  return modelId ? variantsByModelId.get(modelId) : undefined;
}

export function partnerModelVariant(modelId: string | undefined) {
  return partnerModelEntry(modelId)?.variant;
}

/**
 * The model with the variant's declared limits in place of the inferred ones.
 *
 * Only the fields the variant sets are replaced, so a variant that is in the
 * table purely for grouping comes back unchanged.
 */
export function applyPartnerModelCapabilities<T extends WorkflowModel>(model: T): T {
  const variant = partnerModelVariant(model.id);
  if (!variant) return model;

  const next: T = { ...model };
  if (variant.name) next.name = variant.name;
  if (variant.description) next.description = variant.description;
  if (variant.resolutions?.length) {
    next.supportedResolutions = variant.resolutions.map((resolution) => resolution.value);
    next.defaultResolution = variant.defaultResolution ?? variant.resolutions[0].value;
  }
  if (variant.durations) {
    const { min, max, default: fallback } = variant.durations;
    next.supportedDurations = Array.from({ length: max - min + 1 }, (_, index) => min + index);
    next.defaultDurationSeconds = fallback;
  }
  if (variant.maxReferenceImages) next.imageSlotCount = variant.maxReferenceImages;
  return next;
}

/** The variant's entry for a resolution label, matched the way submission matches it. */
export function partnerModelResolution(modelId: string | undefined, label: string | undefined) {
  if (!label) return undefined;
  const key = normalizeKey(label);
  return partnerModelVariant(modelId)?.resolutions?.find((resolution) => normalizeKey(resolution.value) === key);
}

export function supportsPartnerTextOnly(modelId: string | undefined) {
  return partnerModelVariant(modelId)?.supportsTextOnly === true;
}

export function partnerModelRandomizesSeed(modelId: string | undefined) {
  return partnerModelVariant(modelId)?.randomizeSeed === true;
}

export function partnerModelDraft(modelId: string | undefined) {
  return partnerModelVariant(modelId)?.draft;
}

/**
 * What one run of a priced variant is expected to cost, in USD.
 *
 * Undefined for a variant with no pricing, so the caller keeps its own rule --
 * which is how GPT Image 2 and Nano Banana 2 keep the estimates they had.
 */
export function partnerModelUsd(
  modelId: string | undefined,
  options: {
    resolutionLabel?: string;
    durationSeconds?: number;
    referenceImageCount?: number;
    outputCount?: number;
    hasReferenceVideo?: boolean;
  },
) {
  const pricing = partnerModelVariant(modelId)?.pricing;
  if (!pricing) return undefined;

  const resolution = options.resolutionLabel ?? "";
  const outputCount = options.outputCount && options.outputCount > 1 ? options.outputCount : 1;
  const references = Math.max(0, options.referenceImageCount ?? 0) * (pricing.perReferenceImageUsd ?? 0);

  if (pricing.perImageUsd) {
    return (rateFor(pricing.perImageUsd, resolution) + references) * outputCount;
  }
  if (pricing.perSecondUsd) {
    const seconds = options.durationSeconds && options.durationSeconds > 0 ? options.durationSeconds : 5;
    const extra = pricing.maxExtraUsd && options.hasReferenceVideo !== false ? rateFor(pricing.maxExtraUsd, resolution) : 0;
    return rateFor(pricing.perSecondUsd, resolution) * seconds + extra + references;
  }
  return undefined;
}

/**
 * A Custom Seedream size at a pixel budget, shaped like the source.
 *
 * The node's width and height each take 1024-4514 in steps of 2, and the output must
 * be 0.92-4.62MP, so the shape is clamped into that box rather than trusted: a very
 * wide panorama keeps its short side at 1024 and loses some length instead.
 */
export function seedreamMatchedSize(budgetPixels: number, aspect: number) {
  const MIN_SIDE = 1024;
  const MAX_SIDE = 4514;
  const MAX_PIXELS = 4_624_220;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const pixels = Math.min(budgetPixels, MAX_PIXELS);

  let width = Math.sqrt(pixels * safeAspect);
  let height = width / safeAspect;
  if (height < MIN_SIDE) {
    height = MIN_SIDE;
    width = Math.min(MAX_SIDE, pixels / MIN_SIDE);
  }
  if (width < MIN_SIDE) {
    width = MIN_SIDE;
    height = Math.min(MAX_SIDE, pixels / MIN_SIDE);
  }
  width = Math.min(width, MAX_SIDE);
  height = Math.min(height, MAX_SIDE);

  const even = (value: number) => Math.max(MIN_SIDE, Math.floor(value / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Whether the request asks for more output images than one, per the family's option. */
export function partnerModelOutputCount(modelId: string | undefined, workflowOptions: WorkflowOptions | undefined) {
  const family = partnerModelEntry(modelId)?.family.id;
  if (family === "gpt-image") return workflowOptions?.gptImage?.outputCount === 2 ? 2 : 1;
  if (family === "nano-banana") return workflowOptions?.nanoBanana?.outputCount === 2 ? 2 : 1;
  return 1;
}

function rateFor(rates: Record<string, number>, resolution: string) {
  const key = normalizeKey(resolution);
  const match = Object.entries(rates).find(([name]) => name !== "*" && normalizeKey(name) === key);
  return match ? match[1] : rates["*"];
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
