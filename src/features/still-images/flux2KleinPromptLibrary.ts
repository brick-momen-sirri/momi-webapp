import library from "../../data/flux2KleinPromptLibrary.json";

export type Flux2KleinPromptCategory = { id: string; title: string };
export type Flux2KleinPromptPreset = {
  id: string;
  title: string;
  category: string;
  description: string;
  prompt: string;
  tags: string[];
};

export const FLUX2_KLEIN_PROMPT_CATEGORIES = library.categories as Flux2KleinPromptCategory[];
export const FLUX2_KLEIN_PROMPT_PRESETS = library.presets as Flux2KleinPromptPreset[];

export function flux2KleinPromptPresetsForCategory(categoryId: string) {
  return categoryId === "all"
    ? FLUX2_KLEIN_PROMPT_PRESETS
    : FLUX2_KLEIN_PROMPT_PRESETS.filter((preset) => preset.category === categoryId);
}

export function getFlux2KleinPromptPreset(presetId: string) {
  return FLUX2_KLEIN_PROMPT_PRESETS.find((preset) => preset.id === presetId);
}
