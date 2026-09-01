import type { ThemeMode } from "../../components/ThemeToggle";
import { normalizeNanoBananaAspectRatio, normalizeSaveNumber, normalizeSeedanceRatio } from "../generation/generationUtils";
import { normalizeSeedanceVersion, type SeedanceVersionId } from "../generation/seedanceVersions";

const GENERATION_SETTINGS_STORAGE_KEY = "momi_generation_settings_v1";
const FAVORITE_JOB_IDS_STORAGE_KEY = "momi_favorite_job_ids_v1";
const THEME_STORAGE_KEY = "momi_theme_v1";

export type PersistedGenerationSettings = {
  selectedModelId?: string;
  selectedResolution?: string;
  selectedDurationSeconds?: number;
  selectedProjectId?: string;
  targetFolderId?: string;
  prompt?: string;
  saveNumber?: string;
  imageOutputCount?: 1 | 2;
  nanoBananaOutputCount?: 1 | 2;
  selectedNanoBananaAspectRatio?: string;
  selectedSeedanceRatio?: string;
  selectedSeedanceVersion?: SeedanceVersionId;
  seedanceVideoEditing?: boolean;
  imageToVideo16By9Cropping?: boolean;
};

export function readPersistedGenerationSettings(): PersistedGenerationSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GENERATION_SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedGenerationSettings>;
    return {
      selectedModelId: typeof parsed.selectedModelId === "string" ? parsed.selectedModelId : undefined,
      selectedResolution: typeof parsed.selectedResolution === "string" ? parsed.selectedResolution : undefined,
      selectedDurationSeconds:
        typeof parsed.selectedDurationSeconds === "number" && Number.isFinite(parsed.selectedDurationSeconds)
          ? parsed.selectedDurationSeconds
          : undefined,
      selectedProjectId: typeof parsed.selectedProjectId === "string" ? parsed.selectedProjectId : undefined,
      targetFolderId: typeof parsed.targetFolderId === "string" ? parsed.targetFolderId : undefined,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
      saveNumber: typeof parsed.saveNumber === "string" ? normalizeSaveNumber(parsed.saveNumber) : undefined,
      imageOutputCount: parsed.imageOutputCount === 2 || parsed.nanoBananaOutputCount === 2 ? 2 : 1,
      nanoBananaOutputCount: parsed.nanoBananaOutputCount === 2 ? 2 : undefined,
      selectedNanoBananaAspectRatio: normalizeNanoBananaAspectRatio(parsed.selectedNanoBananaAspectRatio),
      selectedSeedanceRatio: normalizeSeedanceRatio(parsed.selectedSeedanceRatio),
      selectedSeedanceVersion: normalizeSeedanceVersion(parsed.selectedSeedanceVersion),
      seedanceVideoEditing: parsed.seedanceVideoEditing === true,
      imageToVideo16By9Cropping:
        typeof parsed.imageToVideo16By9Cropping === "boolean" ? parsed.imageToVideo16By9Cropping : undefined,
    };
  } catch {
    return {};
  }
}

export function writePersistedGenerationSettings(settings: PersistedGenerationSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GENERATION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

export function readPersistedTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "dark" || raw === "light" ? raw : "light";
  } catch {
    return "light";
  }
}

export function writePersistedTheme(theme: ThemeMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

export function readFavoriteJobIds() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(FAVORITE_JOB_IDS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

export function writeFavoriteJobIds(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVORITE_JOB_IDS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}
