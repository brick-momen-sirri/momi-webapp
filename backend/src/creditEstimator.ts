import { seedanceVersionIdFromOptions } from "./seedanceVersions.js";
import type { CreditUsageSummary, Resolution, WorkflowModel, WorkflowOptions } from "./types.js";

export function estimateWorkflowCredits(
  model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath" | "estimatedCredits" | "defaultDurationSeconds">,
  durationSeconds?: number,
  resolution?: Resolution,
  workflowOptions?: WorkflowOptions,
) {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  const resolutionLabel = resolution?.label ?? (resolution ? `${resolution.width}x${resolution.height}` : "1080p");
  const duration = durationOrDefault(durationSeconds, model.defaultDurationSeconds, key);

  if (key.includes("seedance")) {
    return seedanceCreditRange(key, duration, resolutionLabel, seedanceVersionIdFromOptions(workflowOptions)).maxCredits;
  }

  if (key.includes("flux3") || key.includes("flux 3")) {
    return roundCredits(flux3CreditsPerSecond(resolutionLabel) * duration);
  }

  if (key.includes("veo3") || key.includes("veo 3")) {
    return roundCredits(veo3CreditsPerSecond(key, resolutionLabel) * duration);
  }

  if (key.includes("kling") && (key.includes("o3") || key.includes("omni") || key.includes("video_edit"))) {
    return roundCredits(klingOmniEditCreditsPerSecond(resolutionLabel) * duration);
  }

  if (key.includes("kling") && (key.includes("v2.6") || key.includes("v2_6"))) {
    return roundCredits(creditsFromUsd(0.07) * duration);
  }

  if (key.includes("kling") && key.includes("v3")) {
    return roundCredits(klingV3NoAudioCreditsPerSecond(resolutionLabel) * duration);
  }

  if (key.includes("exteriorgrid") || key.includes("exterior grid")) {
    return exteriorGridGeneratorCredits();
  }

  if (key.includes("openai_gpt_image") || key.includes("openai gpt image") || key.includes("gpt_image")) {
    return openAiGptImage2UpperCredits("high") * gptImageOutputCount(workflowOptions);
  }

  if (key.includes("nano") && key.includes("banana")) {
    return nanoBanana2Credits(resolutionLabel) * nanoBananaOutputCount(workflowOptions);
  }

  if (key.includes("still_image-editing")) {
    return imageEditingStudioCredits(workflowOptions);
  }

  if (key.includes("ref_transfer") || key.includes("ref transfer")) {
    return 4;
  }

  return Math.max(0, Math.round(model.estimatedCredits ?? 0));
}

export function estimateFallbackCreditUsage(
  model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath" | "defaultDurationSeconds">,
  workflow: unknown,
  durationSeconds?: number,
  resolution?: Resolution,
): CreditUsageSummary | undefined {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  if (!key.includes("kling") && !workflowContainsClass(workflow, "kling")) {
    return undefined;
  }

  const duration = storyboardDurationSeconds(workflow) || durationOrDefault(durationSeconds, model.defaultDurationSeconds, key);
  const resolutionLabel = resolution?.label ?? (resolution ? `${resolution.width}x${resolution.height}` : "1080p");
  const usd = klingV3UsdPerSecond(resolutionLabel, workflowAudioEnabled(workflow)) * duration;
  const credits = creditsFromUsd(usd);

  return {
    total_estimated_credits: roundCredits(credits),
    total_estimated_usd: roundUsd(usd),
    source: "local_kling_estimate",
    rows: [
      {
        node_title: "Kling fallback estimate",
        class_type: "Kling",
        total_estimated_credits: roundCredits(credits),
        total_estimated_usd: roundUsd(usd),
        source: "local_kling_estimate",
      },
    ],
  };
}

const CREDITS_PER_USD = 211;

type CreditRange = {
  minCredits: number;
  maxCredits: number;
  minUsd: number;
  maxUsd: number;
};

function creditsFromUsd(usd: number) {
  return usd * CREDITS_PER_USD;
}

function roundCredits(value: number) {
  return Math.max(0, Math.round(value));
}

function roundUsd(value: number) {
  return Math.max(0, Math.round(value * 10000) / 10000);
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

export function estimateSeedanceCreditRange(
  model: Pick<WorkflowModel, "id" | "name" | "category" | "workflowPath" | "defaultDurationSeconds">,
  durationSeconds?: number,
  resolution?: Resolution,
  workflowOptions?: WorkflowOptions,
): CreditRange {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  const resolutionLabel = resolution?.label ?? (resolution ? `${resolution.width}x${resolution.height}` : "1080p");
  const duration = durationOrDefault(durationSeconds, model.defaultDurationSeconds, key);
  return seedanceCreditRange(key, duration, resolutionLabel, seedanceVersionIdFromOptions(workflowOptions));
}

function seedanceCreditRange(key: string, durationSeconds: number, resolution: string, version: string): CreditRange {
  const normalizedResolution = normalizeResolution(resolution);
  const tokensPerSecond = seedanceTokensPerSecond(normalizedResolution);
  const hasVideoInput = seedanceHasVideoInput(key);
  const pricePer1k =
    seedancePricePer1k(key, normalizedResolution, hasVideoInput) * seedanceVersionRate(version, normalizedResolution);

  if (hasVideoInput) {
    const minVideoUnits = Math.ceil((durationSeconds * 5) / 3);
    const maxVideoUnits = 15 + durationSeconds;
    const minUsd = (minVideoUnits * tokensPerSecond * pricePer1k) / 1000;
    const maxUsd = (maxVideoUnits * tokensPerSecond * pricePer1k) / 1000;
    return {
      minCredits: roundCredits(creditsFromUsd(minUsd)),
      maxCredits: roundCredits(creditsFromUsd(maxUsd)),
      minUsd: roundUsd(minUsd),
      maxUsd: roundUsd(maxUsd),
    };
  }

  const usd = (durationSeconds * tokensPerSecond * pricePer1k) / 1000;
  const credits = roundCredits(creditsFromUsd(usd));
  return {
    minCredits: credits,
    maxCredits: credits,
    minUsd: roundUsd(usd),
    maxUsd: roundUsd(usd),
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
 * The rates above are 2.0's, and reproduce its official billing to within a
 * fraction of a percent. 2.5 bills the same shape -- per second of output video,
 * by resolution -- at a higher rate, so it is expressed as a factor rather than a
 * second copy of the table.
 *
 * Both figures are the ratio of the per-second rates fitted against
 * official_usage_events in the credit tracker (_SEEDANCE_USD in auto_tracker.py):
 * 0.3339479/0.2162085 at 720p and 0.8215972/0.5351303 at 1080p. 2.5 has no 4K, so
 * there is no third figure to have.
 */
function seedanceVersionRate(version: string, resolution: string) {
  if (version !== "2.5") return 1;
  // Measured, not extrapolated. The credit tracker had no 480p sample for 2.5 and
  // guessed the same ~1.54x it sees at 720p and 1080p; a 5s 480p run on 2026-08-31
  // billed $0.7411 (156.38 credits), which is $0.14822/s against 2.0's attested
  // $0.1005371/s -- a ratio of 1.4743. 2.5's premium is smaller at 480p than higher
  // up, so the flat extrapolation over-quoted it by 4.2%.
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

function flux3CreditsPerSecond(resolution: string) {
  const usdPerSecond = normalizeResolution(resolution) === "720p" ? 0.2431 : 0.4147;
  return creditsFromUsd(usdPerSecond);
}

function klingV3UsdPerSecond(resolution: string, audioEnabled: boolean) {
  const normalized = normalizeResolution(resolution);
  if (normalized === "4k") return 0.42;
  if (normalized === "720p") return audioEnabled ? 0.126 : 0.084;
  return audioEnabled ? 0.168 : 0.112;
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

/** The Quality the request asked for, defaulting the way the graph does. */
function gptImageQuality(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "high" ? value : "medium";
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

/**
 * What one Image Editing Studio edit is expected to cost.
 *
 * The preset is the only one whose provider can be chosen per job, so the flat
 * `estimatedCredits` on the model cannot answer this: it is one number for two
 * engines whose rates differ by several times over. Reading the engine off the
 * job's own settings is what keeps the figure attached to what actually ran.
 *
 * Rates are the tracker's measured means from official_usage_events rather than
 * list prices -- the same source that prices the run afterwards, so the estimate
 * and the eventual charge are quoted in the same terms.
 *
 * Deliberately not routed through nanoBanana2Credits. That function serves the
 * Animation models and still holds the pre-2026-08-08 rates, which understate
 * Nano Banana by around 20% and price 2K at the 1K rate; borrowing it here would
 * spread a known-stale number into a new place.
 */
function imageEditingStudioCredits(workflowOptions: WorkflowOptions | undefined) {
  const settings = workflowOptions?.stillImage?.settings ?? {};
  const engine = typeof settings.engine === "string" ? settings.engine : "nano-banana";

  if (engine === "gpt-image") {
    // Priced off Quality, not off the size the graph asks for.
    //
    // The first version of this used the tracker's mean for Custom renders,
    // $0.29031, as though it were a rate. It is not: across 38 measured Custom
    // runs the charge ranges from $0.0142 to $0.7394, a fifty-fold spread that no
    // single figure represents, and the other sizes scatter just as widely
    // ($0.0131-$0.4674 over 25 runs at 2048x1152). Resolution does not predict
    // what OpenAI bills. The observed range instead brackets the per-quality
    // bounds below almost exactly, which is the signal worth estimating from.
    //
    // These are upper bounds, so the quote leans high rather than surprising
    // anyone: one measured Balanced render at Custom 1600x1200 came back at
    // $0.0898 against the $0.168 bound. Reused rather than re-tabulated -- the
    // same numbers already price the Animation GPT model.
    return openAiGptImage2UpperCredits(gptImageQuality(settings.quality));
  }

  const resolution = typeof settings.resolution === "string" ? settings.resolution : "1K";
  const usd: Record<string, number> = { "1k": 0.083062, "2k": 0.124611, "4k": 0.183589 };
  return roundCredits(creditsFromUsd(usd[resolution.toLowerCase()] ?? usd["1k"]));
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

function nanoBananaOutputCount(workflowOptions: WorkflowOptions | undefined) {
  return workflowOptions?.nanoBanana?.outputCount === 2 ? 2 : 1;
}

function gptImageOutputCount(workflowOptions: WorkflowOptions | undefined) {
  return workflowOptions?.gptImage?.outputCount === 2 ? 2 : 1;
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

function storyboardDurationSeconds(workflow: unknown) {
  const durations: number[] = [];
  walkEntries(workflow, (value, key) => {
    if (!key || !/^storyboard_\d+_duration$/i.test(key)) return;
    const duration = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
    if (duration && Number.isFinite(duration) && duration > 0) {
      durations.push(duration);
    }
  });
  return durations.reduce((sum, value) => sum + value, 0);
}

function workflowAudioEnabled(workflow: unknown) {
  let enabled = false;
  walkEntries(workflow, (value, key, parent) => {
    const lowerKey = key.toLowerCase();
    if (typeof value === "boolean" && value && lowerKey.includes("audio")) {
      enabled = true;
    }
    const classType = String(
      (parent as Record<string, unknown> | undefined)?.type ?? (parent as Record<string, unknown> | undefined)?.class_type ?? "",
    ).toLowerCase();
    const widgets = (parent as Record<string, unknown> | undefined)?.widgets_values;
    if (classType.includes("withaudio") && Array.isArray(widgets)) {
      enabled = widgets.some((item) => item === true);
    }
  });
  return enabled;
}

function workflowContainsClass(workflow: unknown, needle: string) {
  let found = false;
  walkEntries(workflow, (value, key) => {
    if ((key === "type" || key === "class_type") && typeof value === "string" && value.toLowerCase().includes(needle)) {
      found = true;
    }
  });
  return found;
}

function walkEntries(
  value: unknown,
  visitor: (value: unknown, key: string, parent?: unknown) => void,
  key = "",
  parent?: unknown,
) {
  visitor(value, key, parent);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkEntries(item, visitor, String(index), value));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    walkEntries(entryValue, visitor, entryKey, value);
  }
}
