// Partner-API model families and their variants, for the Animation picker.
//
// The table is backend/src/data/partnerModels.json, read here the way
// seedanceVersions.json is: one copy of the truth, so the picker cannot offer a
// resolution, length or reference count the server will refuse, and the estimate
// on the Generate button is quoted from the same rates the server uses.
//
// Data only -- the two packages cannot import each other's code, so the pricing
// rule below mirrors partnerModelUsd in backend/src/partnerModels.ts and is
// asserted against it in partnerModels.test.ts.

import table from "../../../backend/src/data/partnerModels.json";
import type { ModelType } from "../../types";

export type PartnerModelResolution = {
  value: string;
  label: string;
  width: number;
  height: number;
  nodeValue?: string;
  sizePreset?: string;
  matchInput?: boolean;
  fallbackSizePreset?: string;
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
  pricing?: {
    perImageUsd?: Record<string, number>;
    perReferenceImageUsd?: number;
    perSecondUsd?: Record<string, number>;
    maxExtraUsd?: Record<string, number>;
  };
  draft?: { kind: string; resolution?: string };
};

export type PartnerModelFamily = {
  id: string;
  label: string;
  provider: string;
  variants: PartnerModelVariant[];
};

export const PARTNER_MODEL_FAMILIES = (table as unknown as { families: PartnerModelFamily[] }).families;

const entries = new Map(
  PARTNER_MODEL_FAMILIES.flatMap((family) => family.variants.map((variant) => [variant.modelId, { family, variant }] as const)),
);

export function partnerModelEntry(modelId: string | undefined) {
  return modelId ? entries.get(modelId) : undefined;
}

export function partnerModelVariant(modelId: string | undefined) {
  return partnerModelEntry(modelId)?.variant;
}

export function partnerModelFamily(modelId: string | undefined) {
  return partnerModelEntry(modelId)?.family;
}

/** The variant's entry for a resolution value, matched as the server matches it. */
export function partnerModelResolution(modelId: string | undefined, value: string | undefined) {
  if (!value) return undefined;
  const key = normalizeKey(value);
  return partnerModelVariant(modelId)?.resolutions?.find((resolution) => normalizeKey(resolution.value) === key);
}

export function partnerModelResolutions(modelId: string | undefined) {
  return partnerModelVariant(modelId)?.resolutions;
}

export function supportsPartnerTextOnly(modelId: string | undefined) {
  return partnerModelVariant(modelId)?.supportsTextOnly === true;
}

/**
 * The family members offered beside this model: the same family, the same task.
 *
 * MiniMax H3 has variants in three task categories; only the ones in the category
 * the artist is working in are versions of the model they picked.
 */
export function familyVariantModels(models: ModelType[], model: ModelType) {
  const family = partnerModelFamily(model.id);
  if (!family) return [];
  const byId = new Map(models.map((candidate) => [candidate.id, candidate]));
  return family.variants
    .map((variant) => byId.get(variant.modelId))
    .filter((candidate): candidate is ModelType => Boolean(candidate && candidate.backendCategory === model.backendCategory));
}

/** The member a family's card selects when the artist has not picked one of its versions. */
export function familyDefaultModel(models: ModelType[], familyMembers: ModelType[]) {
  const withDefault = familyMembers.find((member) => partnerModelVariant(member.id)?.default);
  return withDefault ?? familyMembers[0] ?? models[0];
}

/**
 * What one run is expected to cost, in USD. Undefined for a variant with no pricing,
 * so the caller keeps its own rule. Mirrors partnerModelUsd on the server.
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

function rateFor(rates: Record<string, number>, resolution: string) {
  const key = normalizeKey(resolution);
  const match = Object.entries(rates).find(([name]) => name !== "*" && normalizeKey(name) === key);
  return match ? match[1] : rates["*"];
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}
