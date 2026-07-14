import { ChevronDown, Monitor, TriangleAlert } from "lucide-react";
import type { ModelType } from "../types";

type ResolutionSelectorProps = {
  selectedModel: ModelType;
  value: string;
  onChange: (value: string) => void;
  imageOutputCount?: 1 | 2;
  onImageOutputCountChange?: (value: 1 | 2) => void;
};

const resolutionOptions = [
  { value: "auto", label: "Auto", width: 1024, height: 1024 },
  { value: "1K", label: "1K", width: 1024, height: 1024 },
  { value: "2K", label: "2K", width: 2048, height: 2048 },
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

  const warnings = (() => {
    const messages: string[] = [];
    const shortSide = parsedValue ? Math.min(parsedValue.width, parsedValue.height) : 1080;

    if (selectedModel.requiresLandscape && !isLandscapeChoice(selectedValue)) {
      messages.push("This model requires a 16:9 landscape resolution.");
    }

    if ((selectedModel.category === "video" || selectedModel.category === "upscale") && shortSide < 720) {
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

      <div className="relative">
        <select
          className="h-10 w-full appearance-none rounded-md border border-line bg-stone-50 px-3 pr-9 text-sm font-semibold text-ink outline-none transition hover:border-stone-400 focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20"
          aria-label="Resolution"
          name="resolution"
          value={selectedValue}
          onChange={(event) => onChange(event.target.value)}
        >
          {visibleOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
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
                    checked
                      ? "bg-ink text-white"
                      : "cursor-pointer text-stone-500 hover:bg-stone-50 hover:text-ink"
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
