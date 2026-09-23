import path from "node:path";

import { brickProjectsRoot, comfyRoot, localProjectsRoot, uploadedMediaRoot } from "./config.js";
import { hasParentPathSegment, isPathWithinRoot, resolveExistingPathWithinRoots } from "./pathContainment.js";

export function mediaPathRoots(options: { allowTemp?: boolean } = {}) {
  const roots = [
    brickProjectsRoot,
    localProjectsRoot,
    uploadedMediaRoot,
    // Deliberately NOT comfyOutputRoot. ComfyUI's output now sits at the root of
    // \\...\Momi, whose siblings include \Momi\backups -- 370 app-state SQLite
    // snapshots. Allowlisting the output root would make the user database
    // fetchable through /api/media?path=. Project media is already covered by
    // brickProjectsRoot (\Momi\projects); a bare ComfyUI save outside a project
    // is not referenced by the app, so it stays unservable on purpose.
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
