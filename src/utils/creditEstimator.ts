import type { ModelType } from "../types";

/**
 * Settings that change the price but are not on the model.
 *
 * Seedance's rate depends on which model version runs, and that is a per-job choice
 * carried in workflowOptions rather than a property of the workflow file.
 */
export type CreditEstimateOptions = {
  seedanceVersion?: string;
};

export function estimateModelCredits(
  model: ModelType,
  durationSeconds?: number,
  resolution = "1080p",
  outputCount = 1,
  options: CreditEstimateOptions = {},
) {
  const key = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  const duration = durationOrDefault(durationSeconds, model.defaultDurationSeconds, key);

  if (key.includes("seedance")) {
    return seedanceCreditRange(key, duration, resolution, options.seedanceVersion).maxCredits;
  }

  if (key.includes("veo3") || key.includes("veo 3")) {
    return roundCredits(veo3CreditsPerSecond(key, resolution) * duration);
  }

  if (key.includes("kling") && (key.includes("o3") || key.includes("omni") || key.includes("video_edit"))) {
    return roundCredits(klingOmniEditCreditsPerSecond(resolution) * duration);
  }

  if (key.includes("kling") && (key.includes("v2.6") || key.includes("v2_6"))) {
    return roundCredits(creditsFromUsd(0.07) * duration);
  }

  if (key.includes("kling") && key.includes("v3")) {
    return roundCredits(klingV3NoAudioCreditsPerSecond(resolution) * duration);
  }

  if (key.includes("exteriorgrid") || key.includes("exterior grid")) {
    return exteriorGridGeneratorCredits();
  }

  if (key.includes("openai_gpt_image") || key.includes("openai gpt image") || key.includes("gpt_image")) {
    return openAiGptImage2UpperCredits("high") * normalizeOutputCount(outputCount);
  }

  if (key.includes("nano") && key.includes("banana")) {
    return nanoBanana2Credits(resolution) * normalizeOutputCount(outputCount);
  }

  if (key.includes("ref_transfer") || key.includes("ref transfer")) {
    return 4;
  }

  return Math.max(0, Math.round(model.cost));
}

export function estimateModelCreditLabel(
  model: ModelType,
  durationSeconds?: number,
  resolution = "1080p",
  outputCount = 1,
  options: CreditEstimateOptions = {},
) {
  const key = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  const duration = durationOrDefault(durationSeconds, model.defaultDurationSeconds, key);

  if (key.includes("seedance")) {
    const estimate = seedanceCreditRange(key, duration, resolution, options.seedanceVersion);
    if (estimate.minCredits !== estimate.maxCredits) {
      return `${formatCredits(estimate.minCredits)}-${formatCredits(estimate.maxCredits)} credits`;
    }
    return `${formatCredits(estimate.maxCredits)} credits`;
  }

  if (
    (key.includes("openai_gpt_image") || key.includes("openai gpt image") || key.includes("gpt_image")) &&
    !key.includes("exteriorgrid") &&
    !key.includes("exterior grid")
  ) {
    return normalizeOutputCount(outputCount) === 2 ? "70-282 credits (2 images)" : "35-141 credits";
  }

  const credits = estimateModelCredits(model, durationSeconds, resolution, outputCount);
  if (key.includes("nano") && key.includes("banana") && normalizeOutputCount(outputCount) === 2) {
    return `${credits} credits (2 images)`;
  }
  return `${credits} credits`;
}

const CREDITS_PER_USD = 211;

function creditsFromUsd(usd: number) {
  return usd * CREDITS_PER_USD;
}

function roundCredits(value: number) {
  return Math.max(0, Math.round(value));
}

function durationOrDefault(durationSeconds: number | undefined, defaultDurationSeconds: number | undefined, key: string) {
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return durationSeconds;
  }
  if (typeof defaultDurationSeconds === "number" && Number.isFinite(defaultDurationSeconds) && defaultDurationSeconds > 0) {
    return defaultDurationSeconds;
  }
  if (key.includes("kling") && (key.includes("o3") || key.includes("omni") || key.includes("video_edit"))) {
    return 5;
  }
  return 5;
}

function seedanceCreditRange(key: string, durationSeconds: number, resolution: string, version?: string) {
  const normalizedResolution = normalizeResolution(resolution);
  const tokensPerSecond = seedanceTokensPerSecond(normalizedResolution);
  const hasVideoInput = seedanceHasVideoInput(key);
  const pricePer1k =
    seedancePricePer1k(key, normalizedResolution, hasVideoInput) * seedanceVersionRate(version, normalizedResolution);

  if (hasVideoInput) {
    const minVideoUnits = Math.ceil((durationSeconds * 5) / 3);
    const maxVideoUnits = 15 + durationSeconds;
    return {
      minCredits: roundCredits(creditsFromUsd((minVideoUnits * tokensPerSecond * pricePer1k) / 1000)),
      maxCredits: roundCredits(creditsFromUsd((maxVideoUnits * tokensPerSecond * pricePer1k) / 1000)),
    };
  }

  const credits = roundCredits(creditsFromUsd((durationSeconds * tokensPerSecond * pricePer1k) / 1000));
  return {
    minCredits: credits,
    maxCredits: credits,
  };
}

function seedanceHasVideoInput(key: string) {
  return (
    key.includes("r2v") ||
    key.includes("video_edit") ||
    key.includes("video editing") ||
    key.includes("reference_videos") ||
    key.includes("video-to-video")
  );
}

function seedanceTokensPerSecond(resolution: string) {
  if (resolution === "4k") return 195200;
  if (resolution === "1080p") return 48800;
  if (resolution === "720p") return 21600;
  // 480p, and the floor for anything unrecognised.
  return 10044;
}

function seedancePricePer1k(key: string, resolution: string, hasVideoInput: boolean) {
  const variant = seedanceVariant(key);
  if (hasVideoInput) {
    if (resolution === "4k") return 0.003432;
    if (resolution === "1080p") return 0.006721;
    if (variant === "mini") return 0.003003;
    if (variant === "fast") return 0.004719;
    return 0.006149;
  }

  if (resolution === "4k") return 0.00572;
  if (resolution === "1080p") return 0.011011;
  if (variant === "mini") return 0.005005;
  if (variant === "fast") return 0.008008;
  return 0.01001;
}

function seedanceVariant(key: string) {
  if (key.includes("mini")) return "mini";
  if (key.includes("fast")) return "fast";
  return "standard";
}

/**
 * What 2.5 costs relative to 2.0 at the same resolution and duration.
 *
 * The rates above are 2.0's. 2.5 bills the same shape -- per second of output video,
 * by resolution -- at a higher rate, so it is a factor rather than a second table.
 * Both figures are the ratio of the per-second rates fitted against
 * official_usage_events in the credit tracker: 0.3339479/0.2162085 at 720p and
 * 0.8215972/0.5351303 at 1080p. 2.5 has no 4K, so there is no third figure.
 *
 * Mirrors seedanceVersionRate in backend/src/creditEstimator.ts.
 */
function seedanceVersionRate(version: string | undefined, resolution: string) {
  if (version !== "2.5") return 1;
  // Measured against a real 5s 480p run, not extrapolated -- see the backend copy.
  if (resolution === "480p") return 1.4743;
  return resolution === "720p" ? 1.5446 : 1.5353;
}

function klingV3NoAudioCreditsPerSecond(resolution: string) {
  const rates: Record<string, number> = {
    "720p": 0.084,
    "1080p": 0.112,
    "4k": 0.42,
  };
  return creditsFromUsd(rates[normalizeResolution(resolution)] ?? rates["1080p"]);
}

function klingOmniEditCreditsPerSecond(resolution: string) {
  return creditsFromUsd(normalizeResolution(resolution) === "720p" ? 0.126 : 0.168);
}

function veo3CreditsPerSecond(key: string, resolution: string) {
  const normalizedResolution = normalizeResolution(resolution);
  const hasAudio = false;

  if (key.includes("lite")) {
    return creditsFromUsd(normalizedResolution === "1080p" ? (hasAudio ? 0.08 : 0.05) : hasAudio ? 0.05 : 0.03);
  }
  if (key.includes("fast")) {
    if (normalizedResolution === "4k") return creditsFromUsd(hasAudio ? 0.3 : 0.25);
    if (normalizedResolution === "1080p") return creditsFromUsd(hasAudio ? 0.12 : 0.1);
    return creditsFromUsd(hasAudio ? 0.1 : 0.08);
  }
  if (normalizedResolution === "4k") {
    return creditsFromUsd(hasAudio ? 0.6 : 0.4);
  }
  return creditsFromUsd(hasAudio ? 0.4 : 0.2);
}

function openAiGptImage2UpperCredits(quality: "low" | "medium" | "high") {
  const maxUsd = {
    low: 0.019,
    medium: 0.168,
    high: 0.67,
  }[quality];
  return roundCredits(creditsFromUsd(maxUsd));
}

function exteriorGridGeneratorCredits() {
  return 6;
}

function nanoBanana2Credits(resolution: string) {
  const prices: Record<string, number> = {
    "1k": 0.0696,
    "2k": 0.0696,
    "720p": 0.0696,
    "1080p": 0.0696,
    "4k": 0.154,
  };
  return roundCredits(creditsFromUsd(prices[normalizeResolution(resolution)] ?? prices["1080p"]));
}

function normalizeOutputCount(value: number) {
  return value === 2 ? 2 : 1;
}

function normalizeResolution(value: string) {
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  if (normalized === "1k" || normalized === "1024x1024") return "1k";
  if (normalized === "2k" || normalized === "2048x2048") return "2k";
  if (normalized === "4k" || normalized === "3840x2160") return "4k";
  if (normalized === "480p" || normalized === "854x480") return "480p";
  if (normalized === "720p" || normalized === "1280x720") return "720p";
  return "1080p";
}

function formatCredits(value: number) {
  return Math.round(value).toLocaleString("en-US");
}
