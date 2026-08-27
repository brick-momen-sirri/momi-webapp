// The Still Images section as this browser left it.
//
// Nothing here used to survive a reload: useStillImagesForm was plain useState, and
// the results panel is unmounted every time the section is switched away from. So a
// refresh -- or a trip to Animation and back -- lost the prompt, every slider, the
// pinned seed, the destination folder, the camera number, and whatever the results
// list had been narrowed to. The Animation form has persisted its equivalent since
// it existed (features/preferences/appPreferences.ts); this is the same idea for the
// four presets.
//
// Two keys rather than one, because there are two writers. The form writes on every
// keystroke and the results panel writes on every filter change, so one key would
// mean each write clobbering the other's slice unless both read-merged first. Both
// are also separate from the Animation key for that same reason:
// writePersistedGenerationSettings replaces the whole object it is given.
//
// Images are deliberately not persisted. An uploaded file is a blob URL that dies
// with the tab, so the only slots that could come back are ones holding saved media,
// and restoring some inputs but not others is worse than restoring none: the panel
// would look ready to generate while a slot the artist had filled sat quietly empty.

import type { ResultLayout } from "../../components/ResultViewControls";
import { normalizeSaveNumber } from "../generation/generationUtils";
import {
  DEFAULT_STILL_IMAGE_RESULT_FILTERS,
  type StillImageResultFilters,
  type StillImageResultSort,
  type StillImageResultStatus,
} from "./resultFilters";
import { stillImageSettingsFromSaved } from "./savedSettings";
import { normalizeStillImageSeedInput } from "./seed";
import {
  createInitialStillImagesState,
  STILL_IMAGE_CATEGORIES,
  type StillImageCategoryId,
  type StillImagesState,
} from "./stillImageCategories";

const FORM_STORAGE_KEY = "momi_still_images_form_v1";
const RESULT_VIEW_STORAGE_KEY = "momi_still_images_results_v1";
const EDITOR_LAYOUT_STORAGE_KEY = "momi_still_images_editor_layout_v1";

/**
 * How wide the artist dragged the editor's layer rail, in CSS pixels.
 *
 * Its own key rather than a field on the form, because it is a property of the
 * workspace rather than of anything being generated -- it should survive a
 * change of preset, a new document, and a reload, and it should not be written
 * on every keystroke the way the form is.
 */
export const MIN_LAYERS_PANEL_WIDTH = 220;
export const MAX_LAYERS_PANEL_WIDTH = 560;
export const DEFAULT_LAYERS_PANEL_WIDTH = 288;

export function clampLayersPanelWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_LAYERS_PANEL_WIDTH;
  return Math.round(Math.min(MAX_LAYERS_PANEL_WIDTH, Math.max(MIN_LAYERS_PANEL_WIDTH, width)));
}

export function readPersistedLayersPanelWidth() {
  const stored = readJson(EDITOR_LAYOUT_STORAGE_KEY);
  const width = stored?.layersPanelWidth;
  return typeof width === "number" ? clampLayersPanelWidth(width) : DEFAULT_LAYERS_PANEL_WIDTH;
}

export function writePersistedLayersPanelWidth(width: number) {
  writeJson(EDITOR_LAYOUT_STORAGE_KEY, { layersPanelWidth: clampLayersPanelWidth(width) });
}

/** Everything the form holds across a reload, minus the images. */
export type PersistableStillImagesForm = {
  selectedCategoryId: StillImageCategoryId;
  stateByCategory: StillImagesState;
  targetFolderId: string;
  saveNumber: string;
};

/**
 * The form as it was left, or the defaults.
 *
 * Returns a complete, valid form state rather than the raw stored bag: settings are
 * re-checked against the catalogue through the same reader Reuse settings uses, so a
 * value stored by a build whose range has since narrowed is replaced by the default
 * instead of sitting in the panel waiting to be rejected at Generate.
 */
export function readPersistedStillImagesForm(): PersistableStillImagesForm {
  const stateByCategory = createInitialStillImagesState();
  const fallback: PersistableStillImagesForm = {
    selectedCategoryId: "general-enhancement",
    stateByCategory,
    targetFolderId: "",
    saveNumber: normalizeSaveNumber(undefined),
  };
  const stored = readJson(FORM_STORAGE_KEY);
  if (!stored) return fallback;

  const storedCategories = plainRecord(stored.categories);
  for (const category of STILL_IMAGE_CATEGORIES) {
    const saved = plainRecord(storedCategories?.[category.id]);
    if (!saved) continue;
    stateByCategory[category.id] = {
      // Never restored: see the note at the top of this file.
      images: [],
      prompt: typeof saved.prompt === "string" ? saved.prompt : "",
      seed: typeof saved.seed === "string" ? normalizeStillImageSeedInput(saved.seed) : "",
      settings: stillImageSettingsFromSaved(category, plainRecord(saved.settings)),
    };
  }

  return {
    selectedCategoryId: isCategoryId(stored.selectedCategoryId) ? stored.selectedCategoryId : fallback.selectedCategoryId,
    stateByCategory,
    // Not checked against the project here. App prunes a folder that has gone away
    // once the project's folder list arrives, which is what it already does for the
    // Animation form's persisted destination.
    targetFolderId: typeof stored.targetFolderId === "string" ? stored.targetFolderId : "",
    saveNumber: typeof stored.saveNumber === "string" ? normalizeSaveNumber(stored.saveNumber) : fallback.saveNumber,
  };
}

export function writePersistedStillImagesForm(form: PersistableStillImagesForm) {
  writeJson(FORM_STORAGE_KEY, {
    selectedCategoryId: form.selectedCategoryId,
    targetFolderId: form.targetFolderId,
    saveNumber: form.saveNumber,
    // Stripped of images on the way out. Storing a blob URL would bring back a slot
    // pointing at bytes the browser released when the tab closed.
    categories: Object.fromEntries(
      STILL_IMAGE_CATEGORIES.map((category) => {
        const state = form.stateByCategory[category.id];
        return [category.id, { prompt: state.prompt, seed: state.seed, settings: state.settings }];
      }),
    ),
  });
}

/** What the results panel is showing: how it is narrowed, and in what shape. */
export type PersistedStillImageResultView = {
  filters: StillImageResultFilters;
  layout: ResultLayout;
};

export function readPersistedStillImageResultView(): PersistedStillImageResultView {
  const fallback: PersistedStillImageResultView = { filters: DEFAULT_STILL_IMAGE_RESULT_FILTERS, layout: "list" };
  const stored = readJson(RESULT_VIEW_STORAGE_KEY);
  if (!stored) return fallback;

  const filters = plainRecord(stored.filters);
  return {
    filters: {
      ...DEFAULT_STILL_IMAGE_RESULT_FILTERS,
      presetId: isCategoryId(filters?.presetId) || filters?.presetId === "all" ? filters.presetId : "all",
      status: isResultStatus(filters?.status) ? filters.status : "all",
      // A folder that has since been deleted or archived narrows the list to nothing
      // rather than being pruned here: the panel says "0 of 12" with a Clear button,
      // and this module has no project to check an id against.
      folderId: typeof filters?.folderId === "string" ? filters.folderId : "all",
      favoritesOnly: filters?.favoritesOnly === true,
      mineOnly: filters?.mineOnly === true,
      sort: isResultSort(filters?.sort) ? filters.sort : "newest",
    },
    layout: stored.layout === "grid" ? "grid" : "list",
  };
}

export function writePersistedStillImageResultView(view: PersistedStillImageResultView) {
  writeJson(RESULT_VIEW_STORAGE_KEY, {
    // The search box is not carried across, which is why it is cleared on the way out
    // rather than ignored on the way in: a preset or a status is a standing way of
    // working, while a typed query is a one-off lookup, and finding one still in the
    // box tomorrow reads as results having gone missing.
    filters: { ...view.filters, query: "" },
    layout: view.layout,
  });
}

function readJson(key: string): Record<string, unknown> | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? plainRecord(JSON.parse(raw)) : undefined;
  } catch {
    // Unreadable or unparseable storage is the same as none. The defaults are a
    // working panel, and a half-restored one is not worth rescuing.
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isCategoryId(value: unknown): value is StillImageCategoryId {
  return typeof value === "string" && STILL_IMAGE_CATEGORIES.some((category) => category.id === value);
}

function isResultStatus(value: unknown): value is StillImageResultStatus {
  return value === "all" || value === "completed" || value === "working" || value === "failed";
}

function isResultSort(value: unknown): value is StillImageResultSort {
  return value === "newest" || value === "oldest" || value === "cost";
}
