import { Grid2X2, SlidersHorizontal } from "lucide-react";
import type { ArchVizGridOptions } from "../types";

type ArchVizGridControlsProps = {
  value: ArchVizGridOptions;
  onChange: (value: ArchVizGridOptions) => void;
};

const slotOptions: Array<{ value: ArchVizGridOptions["slotCount"]; label: string; layout: string }> = [
  { value: "1", label: "1 image", layout: "1x1" },
  { value: "2", label: "2 images", layout: "1x2" },
  { value: "4", label: "4 images", layout: "2x2" },
  { value: "6", label: "6 images", layout: "3x2" },
  { value: "8", label: "8 images", layout: "4x2" },
  { value: "9", label: "9 images", layout: "3x3" },
];

const smartDefaults: Record<ArchVizGridOptions["slotCount"], string[]> = {
  "1": ["Professional regular archviz view"],
  "2": ["Clean front architectural view", "Oblique 45-degree corner view"],
  "4": ["Clean front architectural view", "Oblique 45-degree corner view", "Low-angle hero view", "Elevated contextual view"],
  "6": [
    "Clean front architectural view",
    "Oblique 45-degree corner view",
    "Low-angle hero view",
    "Elevated contextual view",
    "Wide establishing view",
    "Close-up facade detail view",
  ],
  "8": [
    "Aerial top-down contextual view",
    "Clean front architectural view",
    "Oblique 45-degree corner view",
    "Low-angle hero view",
    "Elevated contextual view",
    "Wide establishing view",
    "Close-up facade detail view",
    "Professional regular archviz view",
  ],
  "9": [
    "Aerial top-down contextual view",
    "Clean front architectural view",
    "Close-up facade detail view",
    "Oblique 45-degree corner view",
    "Roofline and upper-volume view",
    "Wide-angle dynamic view",
    "Low foreground landscape view",
    "Low-angle hero view",
    "Professional regular archviz view",
  ],
};

export const archVizCameraPresets = [
  "Clean front architectural view",
  "Oblique 45-degree corner view",
  "Low-angle hero view",
  "Elevated contextual view",
  "Wide establishing view",
  "Close-up facade detail view",
  "Entrance approach view",
  "Side elevation view",
  "Rear architectural view",
  "Aerial top-down contextual view",
  "Bird's-eye oblique view",
  "Street-level perspective",
  "Long lens compressed view",
  "Wide-angle dynamic view",
  "Symmetrical centered composition",
  "Diagonal approach view",
  "Courtyard or inner-facing view",
  "Roofline and upper-volume view",
  "Low foreground landscape view",
  "Professional regular archviz view",
];

export function defaultArchVizGridOptions(): ArchVizGridOptions {
  return {
    slotCount: "4",
    useSmartDefaults: true,
    cameraSlots: paddedCameraSlots(smartDefaults["4"]),
  };
}

export function ArchVizGridControls({ value, onChange }: ArchVizGridControlsProps) {
  const activeCount = Number(value.slotCount);
  const selectedSlot = slotOptions.find((option) => option.value === value.slotCount) ?? slotOptions[2];

  function patch(updates: Partial<ArchVizGridOptions>) {
    onChange({ ...value, ...updates });
  }

  function handleSlotCount(nextSlotCount: ArchVizGridOptions["slotCount"]) {
    const cameraSlots = value.useSmartDefaults
      ? paddedCameraSlots(smartDefaults[nextSlotCount])
      : paddedCameraSlots(value.cameraSlots);
    onChange({ ...value, slotCount: nextSlotCount, cameraSlots });
  }

  function handleSmartDefaults(enabled: boolean) {
    onChange({
      ...value,
      useSmartDefaults: enabled,
      cameraSlots: enabled ? paddedCameraSlots(smartDefaults[value.slotCount]) : paddedCameraSlots(value.cameraSlots),
    });
  }

  function updateCameraSlot(index: number, preset: string) {
    const cameraSlots = paddedCameraSlots(value.cameraSlots);
    cameraSlots[index] = preset;
    onChange({ ...value, useSmartDefaults: false, cameraSlots });
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Grid2X2 className="h-4 w-4 text-accent" />
        ArchViz grid
      </div>

      <div className="grid gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">Grid count</span>
          <select
            value={value.slotCount}
            onChange={(event) => handleSlotCount(event.target.value as ArchVizGridOptions["slotCount"])}
            className="h-10 w-full rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            {slotOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} - {option.layout}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-3 rounded-md border border-line bg-mist/60 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-stone-600">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Smart camera defaults
          </span>
          <input
            type="checkbox"
            checked={value.useSmartDefaults}
            onChange={(event) => handleSmartDefaults(event.target.checked)}
            className="h-4 w-4 rounded border-line accent-accent"
          />
        </label>

        <div className="rounded-md border border-line bg-mist/40 p-2">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Camera positions
          </p>
          <div className="grid gap-2">
            {Array.from({ length: activeCount }, (_, index) => (
              <label key={index} className="grid gap-1">
                <span className="text-[11px] font-semibold text-stone-500">Slot {index + 1}</span>
                <select
                  value={value.cameraSlots[index] ?? "Professional regular archviz view"}
                  disabled={value.useSmartDefaults}
                  onChange={(event) => updateCameraSlot(index, event.target.value)}
                  className="h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-stone-100 disabled:text-stone-500"
                >
                  {archVizCameraPresets.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {value.useSmartDefaults ? (
            <p className="mt-2 text-xs leading-5 text-stone-500">
              Disable smart defaults to customize each camera slot.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function paddedCameraSlots(values: string[]) {
  const fallback = "Professional regular archviz view";
  return Array.from({ length: 9 }, (_, index) => values[index] ?? fallback);
}
