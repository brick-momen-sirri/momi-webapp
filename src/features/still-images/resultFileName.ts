import type { Project } from "../../types";

/**
 * What the backend will actually name a Still Images result.
 *
 * MUST stay in step with the stem builders in backend/src/serverlessArtifactService.ts
 * (imageStem, projectCode, normalizeModelPrefix, normalizeCameraNumber,
 * normalizedSaveNumber, todayCompact). This is a preview shown before a render is
 * paid for, so its whole value is being right -- an invented format is worse than
 * showing nothing, because it quietly teaches the wrong naming.
 *
 * The previous preview produced
 *   SHORT_Project_Name_Pro_Upscaler_CAM0042.png
 * where the backend writes
 *   20260813_pro-upscaler_9999_cam-42_v001.png
 * which shares not one component. It went unnoticed because until the first live
 * dispatcher run, nothing had ever written a real file to compare against.
 *
 * The version suffix stays a placeholder: the backend reserves it from a
 * per-project counter at save time, so it cannot be known here.
 */
export function stillImageResultFileName(input: {
  project?: Pick<Project, "folderName" | "folderPath" | "name">;
  /** The backend WorkflowModel.name for the preset, which equals the UI label. */
  modelName: string;
  saveNumber: string;
  /** Injectable so tests are not tied to the day they run. */
  today?: Date;
}) {
  const folderName = projectFolderNameOf(input.project);
  const prefix = normalizeModelPrefix(input.modelName);
  const camera = normalizeCameraNumber(normalizedSaveNumber(input.saveNumber));
  const stem = `${projectCode(folderName)}_${camera}_v###`;
  const date = compactDate(input.today ?? new Date());
  return `${prefix ? `${date}_${prefix}_${stem}` : `${date}_${stem}`}.png`;
}

/** basename for a Windows path, since folderPath comes from the render host. */
function projectFolderNameOf(project?: Pick<Project, "folderName" | "folderPath" | "name">) {
  if (!project) return "";
  const fromPath = (project.folderPath ?? "").split(/[\\/]/).filter(Boolean).pop();
  return project.folderName || fromPath || project.name || "";
}

/** First run of four or more digits, else any four digits, else padded letters. */
function projectCode(projectName: string) {
  const leadingDigits = projectName.match(/\D*(\d{4,})/);
  if (leadingDigits) return leadingDigits[1].slice(0, 4);

  const anyDigits = projectName.replace(/\D/g, "");
  if (anyDigits.length >= 4) return anyDigits.slice(0, 4);

  const alnum = sanitizeForFilename(projectName, "PROJ")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return (alnum.slice(0, 4) || "PROJ").padEnd(4, "0");
}

function normalizeModelPrefix(value: string) {
  return sanitizeForFilename(value, "", 48)
    .replace(/\s+/g, "-")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[ ._-]+|[ ._-]+$/g, "")
    .toLowerCase();
}

// The backend's illegal set. Space and hyphen are deliberately absent: spaces
// become hyphens in normalizeModelPrefix afterwards, which is what turns
// "Pro Upscaler" into "pro-upscaler" rather than "pro_upscaler". Control codes are
// tested by code point rather than written into a regex, so this file stays ASCII.
const ILLEGAL_FILENAME_CHARS = '<>:"/\\|?*';

function sanitizeForFilename(value: string, fallback = "", maxLength = 140) {
  const clean = Array.from(value.trim())
    .map((char) => (ILLEGAL_FILENAME_CHARS.includes(char) || char.charCodeAt(0) <= 0x1f ? "_" : char))
    .join("")
    .trim();
  return (clean || fallback).slice(0, maxLength);
}

function normalizedSaveNumber(value: string | number | undefined) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 4);
  return Number(digits || "0");
}

function normalizeCameraNumber(value: number) {
  return `cam-${Math.max(0, Math.floor(value)).toString().padStart(2, "0")}`;
}

function compactDate(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}
