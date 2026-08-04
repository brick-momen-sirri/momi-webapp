import path from "node:path";

export function chooseRunpodImageInputNames(inputImages: string[], jobId: string, expectedNames?: string[]) {
  const usedNames = new Set<string>();

  return inputImages.map((value, index) => {
    const expectedName = expectedNames?.[index]?.trim();
    const fallbackName = fallbackRunpodImageName(value, jobId, index);
    const preferredName = expectedName && !usedNames.has(runpodInputNameKey(expectedName)) ? expectedName : fallbackName;
    return uniqueRunpodInputName(preferredName, usedNames);
  });
}

export function fallbackRunpodVideoName(value: string, jobId: string) {
  const extension = extensionFromVideoInput(value) ?? ".mp4";
  return `${jobId}_video${extension}`;
}

export function videoExtension(subtype: string) {
  const normalized = subtype.toLowerCase();
  if (normalized === "quicktime") return "mov";
  if (normalized === "x-msvideo") return "avi";
  if (normalized === "x-matroska") return "mkv";
  return normalized.replace(/[^a-z0-9]+/g, "") || "mp4";
}

function uniqueRunpodInputName(preferredName: string, usedNames: Set<string>) {
  const extension = path.extname(preferredName);
  const base = extension ? preferredName.slice(0, -extension.length) : preferredName;
  let candidate = preferredName;
  let suffix = 2;
  while (usedNames.has(runpodInputNameKey(candidate))) {
    candidate = `${base}_${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(runpodInputNameKey(candidate));
  return candidate;
}

function runpodInputNameKey(value: string) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function fallbackRunpodImageName(value: string, jobId: string, index: number) {
  const extension = extensionFromImageInput(value) ?? ".png";
  return `${jobId}_${index + 1}${extension}`;
}

function extensionFromImageInput(value: string) {
  const dataUrlMatch = value.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
  if (dataUrlMatch) return `.${dataUrlMatch[1].toLowerCase().replace("jpeg", "jpg")}`;
  return extensionFromUrlOrPath(value);
}

function extensionFromVideoInput(value: string) {
  const dataUrlMatch = value.match(/^data:video\/([a-zA-Z0-9+.-]+);base64,/);
  if (dataUrlMatch) return `.${videoExtension(dataUrlMatch[1])}`;
  return extensionFromUrlOrPath(value);
}

function extensionFromUrlOrPath(value: string) {
  try {
    const url = new URL(value);
    const filename = url.searchParams.get("filename") ?? path.basename(url.pathname);
    return path.extname(filename) || undefined;
  } catch {
    return path.extname(value) || undefined;
  }
}
