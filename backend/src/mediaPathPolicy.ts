import path from "node:path";

import { brickProjectsRoot, comfyRoot, localProjectsRoot, uploadedMediaRoot } from "./config.js";
import { hasParentPathSegment, isPathWithinRoot, resolveExistingPathWithinRoots } from "./pathContainment.js";

export function mediaPathRoots(options: { allowTemp?: boolean } = {}) {
  const roots = [
    brickProjectsRoot,
    localProjectsRoot,
    uploadedMediaRoot,
    path.join(comfyRoot, "output"),
    path.join(comfyRoot, "input"),
  ];
  if (options.allowTemp) {
    roots.push(path.join(comfyRoot, "temp"));
    roots.push("C:\\Comfy_pool\\instances");
  }
  return roots;
}

export function isAllowedMediaPath(filePath: string, options: { allowTemp?: boolean } = {}) {
  if (hasParentPathSegment(filePath)) return false;
  return mediaPathRoots(options).some((root) => isPathWithinRoot(filePath, root));
}

export async function resolveAllowedExistingMediaPath(filePath: string, options: { allowTemp?: boolean } = {}) {
  if (!isAllowedMediaPath(filePath, options)) return undefined;
  return resolveExistingPathWithinRoots(filePath, mediaPathRoots(options));
}
