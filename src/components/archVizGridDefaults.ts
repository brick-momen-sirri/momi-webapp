// Non-component exports lifted out of ArchVizGridControls.tsx.
//
// Vite's fast refresh only re-renders a module in place when it exports nothing
// but components; a single value export makes the whole module reload, losing
// component state on every edit. App.tsx needs defaultArchVizGridOptions, and the
// control needs the presets and the padding helper, so they live here and the
// component file exports only the component.

import type { ArchVizGridOptions } from "../types";

export const smartDefaults: Record<ArchVizGridOptions["slotCount"], string[]> = {
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

export function paddedCameraSlots(values: string[]) {
  const fallback = "Professional regular archviz view";
  return Array.from({ length: 9 }, (_, index) => values[index] ?? fallback);
}

export function defaultArchVizGridOptions(): ArchVizGridOptions {
  return {
    slotCount: "4",
    useSmartDefaults: true,
    cameraSlots: paddedCameraSlots(smartDefaults["4"]),
  };
}
