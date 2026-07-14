import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import type { ModelType } from "../types";

type DurationSelectorProps = {
  selectedModel: ModelType;
  value: number;
  onChange: (seconds: number) => void;
};

export function DurationSelector({ selectedModel, value, onChange }: DurationSelectorProps) {
  const isVideoModel = selectedModel.category === "video";
  const options = isVideoModel ? selectedModel.supportedDurations ?? [5, 8, 10] : [];
  const fallbackValue = selectedModel.defaultDurationSeconds && options.includes(selectedModel.defaultDurationSeconds)
    ? selectedModel.defaultDurationSeconds
    : options[0] ?? value;
  const normalizedValue = options.includes(value) ? value : fallbackValue;
  const [selectedValue, setSelectedValue] = useState(normalizedValue);
  const displayValue = options.includes(selectedValue) ? selectedValue : normalizedValue;
  const selectedIndex = Math.max(0, options.indexOf(displayValue));
  const isContiguous = options.every((option, index) => index === 0 || option - options[index - 1] === 1);
  const sliderKey = `${selectedModel.id}-${options.join("-")}`;

  useEffect(() => {
    setSelectedValue(normalizedValue);
  }, [normalizedValue, selectedModel.id]);

  if (!isVideoModel) {
    return null;
  }

  function selectDuration(seconds: number) {
    setSelectedValue(seconds);
    onChange(seconds);
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Duration</h2>
        </div>
        <span className="text-sm font-bold text-ink">{options.length ? `${displayValue}s` : "Auto"}</span>
      </div>

      {options.length === 0 ? (
        <div className="rounded-md border border-line bg-stone-50 px-3 py-2 text-xs font-semibold leading-5 text-stone-600">
          This workflow uses the source video length.
        </div>
      ) : options.length === 1 ? (
        <div className="flex h-9 items-center justify-center rounded-md border border-line bg-stone-50 text-sm font-semibold text-stone-600">
          {options[0]} seconds
        </div>
      ) : (
        <div>
          {isContiguous ? (
            <input
              key={sliderKey}
              type="range"
              min={options[0]}
              max={options[options.length - 1]}
              step={1}
              value={displayValue}
              onChange={(event) => selectDuration(Number(event.target.value))}
              aria-label="Duration"
              aria-valuetext={`${displayValue} seconds`}
              className="h-2 w-full cursor-pointer accent-accent"
            />
          ) : (
            <input
              key={sliderKey}
              type="range"
              min={0}
              max={options.length - 1}
              step={1}
              value={selectedIndex}
              onChange={(event) => {
                const nextOption = options[Number(event.target.value)];
                if (typeof nextOption === "number") {
                  selectDuration(nextOption);
                }
              }}
              aria-label="Duration"
              aria-valuetext={`${displayValue} seconds`}
              className="h-2 w-full cursor-pointer accent-accent"
            />
          )}
          {options.length <= 6 ? (
            <div className="mt-2 flex justify-between text-[11px] font-semibold text-stone-500">
              {options.map((option) => (
                <span key={option}>{option}s</span>
              ))}
            </div>
          ) : (
            <div className="mt-2 flex justify-between text-[11px] font-semibold text-stone-500">
              <span>{options[0]}s</span>
              <span>{options[options.length - 1]}s</span>
            </div>
          )}
          <p className="mt-2 text-[11px] font-medium text-stone-500">
            Valid: {isContiguous ? `${options[0]}-${options[options.length - 1]}s` : options.map((option) => `${option}s`).join(" / ")}
          </p>
        </div>
      )}
    </section>
  );
}
