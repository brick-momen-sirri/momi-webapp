// Where a folder sits in its project, for every surface that names or filters by one.
//
// Folders nest (parentId), but the pickers used to list them flat by bare name and
// the folder filter matched a job's own folder only. That holds while folders are
// shots ("1400", "4105"), and falls apart once a project gives every artist a folder
// with the same exercise subfolders inside: the picker then offers twenty identical
// "01 Camera Moves" entries with no way to tell whose is whose, and selecting
// "Sara Haddad" shows nothing she saved in her subfolders.
//
// So every picker labels a folder with its full path ("Sara Haddad / 01 Camera
// Moves") in tree order, and selecting a folder takes in everything beneath it.
// backend/src/jobFilters.ts applies the same scope to the paged fetch, so the page
// the server sends and the list the browser narrows agree.

import { compareFolderNames } from "./folderSort";

type FolderNode = { folderId: string; parentId: string | null; name: string; archived?: boolean };

const PATH_SEPARATOR = " / ";

/**
 * `pinned` marks a pinned top-level folder and everything beneath it, so a picker
 * can group that branch apart from the rest.
 */
export type FolderTreeEntry<T extends FolderNode> = { folder: T; depth: number; path: string; pinned: boolean };

/**
 * How an account's pins name a folder. Folder ids are only unique within a
 * project, so the project is part of the key. backend/src/routes/authSessionRoutes.ts
 * builds the same key to check a pin names a real top-level folder.
 */
export function folderPinKey(projectId: string, folderId: string) {
  return `${projectId}:${folderId}`;
}

/** The folder ids an account has pinned in one project. */
export function pinnedFolderIdsIn(projectId: string | undefined, pinnedFolderKeys: readonly string[] = []) {
  const prefix = `${projectId}:`;
  return new Set(
    projectId ? pinnedFolderKeys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)) : [],
  );
}

/**
 * Top-level folders with the pinned ones first, each group by name. Only the
 * first level is pinnable: it is where each artist's own folder sits.
 */
export function orderTopLevelFolders<T extends { folderId: string; name: string }>(
  folders: readonly T[],
  pinnedFolderIds: ReadonlySet<string> = new Set(),
) {
  return [...folders].sort(
    (left, right) =>
      Number(pinnedFolderIds.has(right.folderId)) - Number(pinnedFolderIds.has(left.folderId)) ||
      compareFolderNames(left.name, right.name),
  );
}

/**
 * Where a result sits, as its full folder path ("Sara Haddad / Shot 0100"). Falls
 * back to the name stored on the job -- "Root", or a folder the project no longer
 * lists.
 */
export function jobFolderLabel(
  job: { folderId?: string | null; folderName?: string },
  folders: readonly FolderNode[] = [],
) {
  const folder = job.folderId ? folders.find((item) => item.folderId === job.folderId) : undefined;
  return folder ? folderPathLabel(folder, folders) : job.folderName;
}

/** "Parent / Child", walked from the folder up. Stops on a missing parent or a cycle. */
export function folderPathLabel(folder: FolderNode, folders: readonly FolderNode[]) {
  return pathOf(folder, new Map(folders.map((item) => [item.folderId, item])));
}

/**
 * The project's live folders in tree order: each folder, then its subfolders, with
 * siblings ordered by name -- except that pinned top-level folders come first.
 *
 * A folder whose parent is archived or missing is listed at the top level rather
 * than dropped, so nothing live can vanish from a picker because of its parent.
 */
export function folderTreeEntries<T extends FolderNode>(
  folders: readonly T[],
  pinnedFolderIds: ReadonlySet<string> = new Set(),
): FolderTreeEntry<T>[] {
  const byId = new Map<string, FolderNode>(folders.map((folder) => [folder.folderId, folder]));
  const active = folders.filter((folder) => !folder.archived);
  const activeIds = new Set(active.map((folder) => folder.folderId));
  const childrenByParent = new Map<string, T[]>();
  for (const folder of active) {
    const key = folder.parentId && activeIds.has(folder.parentId) ? folder.parentId : "";
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), folder]);
  }

  const entries: FolderTreeEntry<T>[] = [];
  const visited = new Set<string>();
  const visit = (parentKey: string, depth: number, inPinnedBranch: boolean) => {
    const siblings = childrenByParent.get(parentKey) ?? [];
    const children =
      depth === 0
        ? orderTopLevelFolders(siblings, pinnedFolderIds)
        : [...siblings].sort((left, right) => compareFolderNames(left.name, right.name));
    for (const folder of children) {
      if (visited.has(folder.folderId)) continue;
      visited.add(folder.folderId);
      const pinned = inPinnedBranch || (depth === 0 && pinnedFolderIds.has(folder.folderId));
      entries.push({ folder, depth, path: pathOf(folder, byId), pinned });
      visit(folder.folderId, depth + 1, pinned);
    }
  };
  visit("", 0, false);
  // Only a parent cycle can leave a live folder unvisited. List it anyway.
  for (const folder of active) {
    if (!visited.has(folder.folderId)) entries.push({ folder, depth: 0, path: pathOf(folder, byId), pinned: false });
  }
  return entries;
}

/** What a folder selection lets through: everything, the project root only, or a set of folder ids. */
export type FolderScope = "all" | "root" | ReadonlySet<string>;

/**
 * The selected folder and every folder beneath it, archived ones included -- a
 * result does not stop belonging under "Sara Haddad" because a subfolder of hers
 * was archived.
 */
export function folderFilterScope(selectedFolderId: string, folders: readonly FolderNode[] = []): FolderScope {
  if (selectedFolderId === "all" || selectedFolderId === "root") return selectedFolderId;
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    childrenByParent.set(folder.parentId, [...(childrenByParent.get(folder.parentId) ?? []), folder.folderId]);
  }
  const scope = new Set<string>();
  const pending = [selectedFolderId];
  while (pending.length) {
    const folderId = pending.pop() as string;
    if (scope.has(folderId)) continue;
    scope.add(folderId);
    pending.push(...(childrenByParent.get(folderId) ?? []));
  }
  return scope;
}

export function isInFolderScope(folderId: string | null | undefined, scope: FolderScope) {
  if (scope === "all") return true;
  if (scope === "root") return !folderId;
  return Boolean(folderId && scope.has(folderId));
}

function pathOf(folder: FolderNode, byId: ReadonlyMap<string, FolderNode>) {
  const names = [folder.name];
  const visited = new Set([folder.folderId]);
  let parentId = folder.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(PATH_SEPARATOR);
}
