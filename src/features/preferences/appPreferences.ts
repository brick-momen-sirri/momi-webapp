import type { ThemeMode } from "../../components/ThemeToggle";
import { normalizeNanoBananaAspectRatio, normalizeSaveNumber, normalizeSeedanceRatio } from "../generation/generationUtils";
import { normalizeSeedanceVersion, type SeedanceVersionId } from "../generation/seedanceVersions";

const GENERATION_SETTINGS_STORAGE_KEY = "momi_generation_settings_v1";
const FAVORITE_JOB_IDS_STORAGE_KEY = "momi_favorite_job_ids_v1";
const THEME_STORAGE_KEY = "momi_theme_v1";
const RESULT_FOLDER_BY_PROJECT_STORAGE_KEY = "momi_result_folder_by_project_v1";

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
  seedanceGenerateAudio?: boolean;
  klingCameraStabilization?: boolean;
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
      // Anything other than an explicit true reads as off, so a stored preference
      // from before this switch existed starts silent rather than inheriting the
      // node's own default.
      seedanceGenerateAudio: parsed.seedanceGenerateAudio === true,
      // The opposite way round: only an explicit false turns it off, so a stored
      // preference from before the switch starts stabilized.
      klingCameraStabilization: parsed.klingCameraStabilization !== false,
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

/**
 * The result folder last chosen in each project, keyed by project id.
 *
 * Switching project used to send the destination back to Root, and it stayed there
 * on the way back -- so an artist who looked at another project came home to find
 * their next render landing in the project root instead of their own folder. An
 * empty value (Root) is stored as no entry, so the map only holds real choices.
 */
export function readRememberedResultFolder(projectId: string) {
  return readResultFolderMap()[projectId] ?? "";
}

export function rememberResultFolder(projectId: string, folderId: string) {
  if (typeof window === "undefined") return;
  const current = readResultFolderMap();
  if ((current[projectId] ?? "") === folderId) return;
  const next = { ...current };
  if (folderId) next[projectId] = folderId;
  else delete next[projectId];
  try {
    window.localStorage.setItem(RESULT_FOLDER_BY_PROJECT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

function readResultFolderMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RESULT_FOLDER_BY_PROJECT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""),
    );
  } catch {
    return {};
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
