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

export type FolderTreeEntry<T extends FolderNode> = { folder: T; depth: number; path: string };

/** "Parent / Child", walked from the folder up. Stops on a missing parent or a cycle. */
export function folderPathLabel(folder: FolderNode, folders: readonly FolderNode[]) {
  return pathOf(folder, new Map(folders.map((item) => [item.folderId, item])));
}

/**
 * The project's live folders in tree order: each folder, then its subfolders, with
 * siblings ordered by name.
 *
 * A folder whose parent is archived or missing is listed at the top level rather
 * than dropped, so nothing live can vanish from a picker because of its parent.
 */
export function folderTreeEntries<T extends FolderNode>(folders: readonly T[]): FolderTreeEntry<T>[] {
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
  const visit = (parentKey: string, depth: number) => {
    const children = [...(childrenByParent.get(parentKey) ?? [])].sort((left, right) =>
      compareFolderNames(left.name, right.name),
    );
    for (const folder of children) {
      if (visited.has(folder.folderId)) continue;
      visited.add(folder.folderId);
      entries.push({ folder, depth, path: pathOf(folder, byId) });
      visit(folder.folderId, depth + 1);
    }
  };
  visit("", 0);
  // Only a parent cycle can leave a live folder unvisited. List it anyway.
  for (const folder of active) {
    if (!visited.has(folder.folderId)) entries.push({ folder, depth: 0, path: pathOf(folder, byId) });
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
