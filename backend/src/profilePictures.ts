import path from "node:path";

export const profilePictureFileNames = [
  "avatar-64.webp",
  "avatar-128.webp",
  "avatar-256.webp",
  "avatar-512.webp",
  "original.png",
] as const;

const profilePictureFileNameSet = new Set<string>(profilePictureFileNames);
const portraitIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

export function resolveProfilePicturePath(root: string, portraitId: string, fileName: string) {
  if (!portraitIdPattern.test(portraitId) || !profilePictureFileNameSet.has(fileName)) return undefined;
  return path.join(root, portraitId, fileName);
}

export function profilePictureContentType(fileName: string) {
  if (fileName.endsWith(".webp")) return "image/webp";
  if (fileName.endsWith(".png")) return "image/png";
  return undefined;
}
