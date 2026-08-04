import fs from "node:fs/promises";
import path from "node:path";

type PathApi = typeof path.win32;

/**
 * Select Windows semantics for the Windows host and for explicitly Windows-shaped
 * paths in cross-platform tests. Otherwise retain the host's POSIX semantics.
 */
function pathApiFor(candidate: string, root: string): PathApi {
  if (process.platform === "win32") return path.win32;
  const windowsAbsolute = /^(?:[a-z]:[\\/]|\\\\)/i;
  return windowsAbsolute.test(candidate) && windowsAbsolute.test(root) ? path.win32 : path.posix;
}

function validPathText(value: string) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

/** Return true only for the root itself or a separator-bounded descendant. */
export function isPathWithinRoot(candidate: string, root: string) {
  if (!validPathText(candidate) || !validPathText(root)) return false;

  const pathApi = pathApiFor(candidate, root);
  const normalizeCase = (value: string) => (pathApi === path.win32 ? value.toLowerCase() : value);
  const resolvedCandidate = normalizeCase(pathApi.resolve(candidate));
  const resolvedRoot = normalizeCase(pathApi.resolve(root));
  const relative = pathApi.relative(resolvedRoot, resolvedCandidate);

  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

/** Raw parent segments are rejected at URL/filesystem trust boundaries. */
export function hasParentPathSegment(value: string) {
  if (!validPathText(value)) return true;
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

/**
 * Resolve filesystem links for a path that is about to be opened. The lexical
 * check prevents probing arbitrary paths; the realpath check prevents a child
 * symlink or Windows junction from escaping an allowed root.
 */
export async function resolveExistingPathWithinRoots(candidate: string, roots: string[]) {
  if (!validPathText(candidate)) return undefined;
  const lexicalRoots = roots.filter((root) => isPathWithinRoot(candidate, root));
  if (!lexicalRoots.length) return undefined;

  const realCandidate = await fs.realpath(candidate).catch(() => undefined);
  if (!realCandidate) return undefined;

  for (const root of lexicalRoots) {
    const realRoot = await fs.realpath(root).catch(() => undefined);
    if (realRoot && isPathWithinRoot(realCandidate, realRoot)) {
      return realCandidate;
    }
  }
  return undefined;
}
