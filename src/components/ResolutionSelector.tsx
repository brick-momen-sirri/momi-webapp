import { ChevronDown, Monitor, TriangleAlert } from "lucide-react";
import {
  DEFAULT_SEEDANCE_VERSION,
  seedanceSupportsRatio,
  seedanceVersion,
  type SeedanceVersionId,
} from "../features/generation/seedanceVersions";
import { isSeedanceWorkflowModel } from "../services/promptRules";
import type { ModelType } from "../types";

type ResolutionSelectorProps = {
  selectedModel: ModelType;
  value: string;
  onChange: (value: string) => void;
  allowSeedance4K?: boolean;
  aspectRatio?: string;
  onAspectRatioChange?: (value: string) => void;
  seedanceRatio?: string;
  onSeedanceRatioChange?: (value: string) => void;
  seedanceVersionId?: SeedanceVersionId;
  imageOutputCount?: 1 | 2;
  onImageOutputCountChange?: (value: 1 | 2) => void;
};

const resolutionOptions = [
  { value: "auto", label: "Auto", width: 1024, height: 1024 },
  { value: "1K", label: "1K", width: 1024, height: 1024 },
  { value: "2K", label: "2K", width: 2048, height: 2048 },
  { value: "480p", label: "480p", width: 854, height: 480 },
  { value: "720p", label: "720p", width: 1280, height: 720 },
  { value: "1080p", label: "1080p", width: 1920, height: 1080 },
  { value: "4K", label: "4K", width: 3840, height: 2160 },
  { value: "1024x1024", label: "1024x1024", width: 1024, height: 1024 },
  { value: "1024x1536", label: "1024x1536", width: 1024, height: 1536 },
  { value: "1536x1024", label: "1536x1024", width: 1536, height: 1024 },
  { value: "2048x2048", label: "2048x2048", width: 2048, height: 2048 },
  { value: "2048x1152", label: "2048x1152", width: 2048, height: 1152 },
  { value: "1152x2048", label: "1152x2048", width: 1152, height: 2048 },
  { value: "3840x2160", label: "3840x2160", width: 3840, height: 2160 },
  { value: "2160x3840", label: "2160x3840", width: 2160, height: 3840 },
];

const defaultVideoResolutionOptions = ["720p", "1080p", "4K"];
const nanoBananaAspectRatioOptions = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function parseResolution(value: string) {
  const option = resolutionOptions.find((item) => item.value.toLowerCase() === value.toLowerCase());
  if (option) {
    return { width: option.width, height: option.height };
  }

  const match = value.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) {
    return null;
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

function isLandscapeRatio(width: number, height: number) {
  return Math.abs(width / height - 16 / 9) < 0.02;
}

function isLandscapeChoice(value: string) {
  const parsed = parseResolution(value);
  return parsed ? isLandscapeRatio(parsed.width, parsed.height) : false;
}

function normalizeResolutionValue(value: string) {
  const exactMatch = resolutionOptions.find((option) => option.value.toLowerCase() === value.toLowerCase());
  if (exactMatch) {
    return exactMatch.value;
  }

  const parsed = parseResolution(value);
  if (!parsed) {
    return "1080p";
  }

  const match = resolutionOptions.find((option) => option.width === parsed.width && option.height === parsed.height);
  return match?.value ?? "1080p";
}

export function ResolutionSelector({
  selectedModel,
  value,
  onChange,
  allowSeedance4K = false,
  aspectRatio = "auto",
  onAspectRatioChange,
  seedanceRatio = "16:9",
  onSeedanceRatioChange,
  seedanceVersionId = DEFAULT_SEEDANCE_VERSION,
  imageOutputCount,
  onImageOutputCountChange,
}: ResolutionSelectorProps) {
  if (!usesResolutionControl(selectedModel)) {
    return null;
  }

  const parsedValue = parseResolution(value);
  const selectedValue = normalizeResolutionValue(value);
  const supportedResolutions = selectedModel.supportedResolutions?.length
    ? selectedModel.supportedResolutions
    : defaultVideoResolutionOptions;
  const visibleOptions = supportedResolutions
    .map((resolution) => resolutionOptions.find((option) => option.value.toLowerCase() === resolution.toLowerCase()))
    .filter((option): option is (typeof resolutionOptions)[number] => Boolean(option));
  const showOutputCount = supportsImageOutputCount(selectedModel) && imageOutputCount && onImageOutputCountChange;
  // Only one of the two ever applies: Nano Banana is an image model, Seedance a video one.
  const ratioControl = ratioControlForModel(selectedModel, {
    aspectRatio,
    onAspectRatioChange,
    seedanceRatio,
    onSeedanceRatioChange,
    seedanceVersionId,
  });
  const disableSeedance4K = isSeedanceWorkflowModel(selectedModel) && !allowSeedance4K;

  const warnings = (() => {
    const messages: string[] = [];
    const shortSide = parsedValue ? Math.min(parsedValue.width, parsedValue.height) : 1080;

    if (selectedModel.requiresLandscape && !isLandscapeChoice(selectedValue)) {
      messages.push("This model requires a 16:9 landscape resolution.");
    }

    // Only for a value this model does not actually offer -- one left over from
    // another model, a reused job or a stored preference. A resolution that is in the
    // list above was chosen deliberately from what the model supports, so flagging it
    // would be second-guessing the picker's own options: Seedance offers 480p.
    const offered = supportedResolutions.some((resolution) => resolution.toLowerCase() === selectedValue.toLowerCase());
    if ((selectedModel.category === "video" || selectedModel.category === "upscale") && shortSide < 720 && !offered) {
      messages.push("This resolution is low for the selected model.");
    }

    return messages;
  })();

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center gap-2">
        <Monitor className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold">Resolution</h2>
      </div>

      <div className={ratioControl ? "grid grid-cols-2 gap-2" : ""}>
        <div className="relative min-w-0">
          <select
            className="h-10 w-full appearance-none rounded-md border border-line bg-stone-50 px-3 pr-9 text-sm font-semibold text-ink outline-none transition hover:border-stone-400 focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20"
            aria-label="Resolution"
            name="resolution"
            value={selectedValue}
            onChange={(event) => onChange(event.target.value)}
          >
            {visibleOptions.map((option) => {
              const disabled = disableSeedance4K && is4KResolution(option.value);
              return (
                <option key={option.value} value={option.value} disabled={disabled}>
                  {disabled ? `${option.label} (Admin only)` : option.label}
                </option>
              );
            })}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
        </div>

        {ratioControl ? (
          <div className="relative min-w-0">
            <select
              id={ratioControl.id}
              className="h-10 w-full appearance-none rounded-md border border-line bg-stone-50 px-3 pr-9 text-sm font-semibold text-ink outline-none transition hover:border-stone-400 focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20"
              aria-label="Aspect ratio"
              name={ratioControl.name}
              value={ratioControl.value}
              onChange={(event) => ratioControl.onChange(event.target.value)}
            >
              {ratioControl.options.map((option) => (
                <option key={option} value={option}>
                  {option === "adaptive" ? "adaptive (match input)" : option}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
          </div>
        ) : null}
      </div>

      {showOutputCount ? (
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="text-xs font-semibold text-stone-600">Outputs</span>
          <div className="flex rounded-md border border-line bg-white p-0.5" role="radiogroup" aria-label="Image output count">
            {([1, 2] as const).map((count) => {
              const checked = imageOutputCount === count;
              return (
                <label
                  key={count}
                  title={`${count} ${count === 1 ? "image" : "images"}`}
                  className={`flex h-7 min-w-10 items-center justify-center rounded text-xs font-bold transition ${
                    checked ? "bg-ink text-white" : "cursor-pointer text-stone-500 hover:bg-stone-50 hover:text-ink"
                  }`}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="image-output-count"
                    value={count}
                    checked={checked}
                    onChange={() => onImageOutputCountChange(count)}
                  />
                  {count}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      {warnings.length ? (
        <div className="mt-3 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          {warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function usesResolutionControl(model: ModelType) {
  if (isNanoBananaModel(model)) return true;
  if (isGptImageModel(model)) return true;
  return model.category === "video" && model.backendCategory?.toLowerCase() !== "image_editing";
}

function isNanoBananaModel(model: ModelType) {
  const key = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("nano") && key.includes("banana");
}

function isGptImageModel(model: ModelType) {
  const key = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return (key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid");
}

function supportsImageOutputCount(model: ModelType) {
  return isNanoBananaModel(model) || isGptImageModel(model);
}

function ratioControlForModel(
  model: ModelType,
  props: Pick<
    ResolutionSelectorProps,
    "aspectRatio" | "onAspectRatioChange" | "seedanceRatio" | "onSeedanceRatioChange" | "seedanceVersionId"
  >,
) {
  if (isNanoBananaModel(model) && props.onAspectRatioChange) {
    return {
      id: "nano-banana-aspect-ratio",
      name: "aspect_ratio",
      options: nanoBananaAspectRatioOptions,
      value: nanoBananaAspectRatioOptions.includes(props.aspectRatio ?? "") ? (props.aspectRatio as string) : "auto",
      onChange: props.onAspectRatioChange,
    };
  }
  if (isSeedanceWorkflowModel(model) && props.onSeedanceRatioChange) {
    // 2.5's first-last-frame node has no ratio input at all, so there is nothing to
    // control: the picker hides rather than offering a setting that would be dropped.
    const version = seedanceVersion(props.seedanceVersionId);
    if (!seedanceSupportsRatio(model, version)) return undefined;
    return {
      id: "seedance-ratio",
      name: "seedance_ratio",
      options: version.ratios,
      value: version.ratios.includes(props.seedanceRatio ?? "") ? (props.seedanceRatio as string) : version.defaultRatio,
      onChange: props.onSeedanceRatioChange,
    };
  }
  return undefined;
}

function is4KResolution(value: string) {
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  return normalized === "4k" || normalized === "3840x2160";
}
