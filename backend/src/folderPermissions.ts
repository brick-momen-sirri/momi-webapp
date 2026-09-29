// Who may change a project's folder tree.
//
// Folders used to be admin-only end to end. That fits shot folders an admin lays
// out for a production, and not a project with a folder per artist, where each
// artist wants to organise their own takes ("Sara Haddad / Shot 0100") without
// asking an admin for every subfolder.
//
// So: admins can do everything. Anyone who can generate in the project can add a
// subfolder inside an existing folder, and can rename or delete a subfolder they
// created themselves. The first level -- one folder per artist -- stays admin-only,
// so that list cannot drift. Delete still refuses a folder that holds anything
// (projectMetadataService.deleteProjectFolder), so no one can lose results by it.

import { canCreateJobInProject, isDemoAccount } from "./jobPermissions.js";
import type { Project, User } from "./types.js";

export function canCreateProjectFolder(user: User, project: Project, parentId: string | null) {
  if (user.role === "admin") return true;
  if (!parentId || !canEditFolders(user, project)) return false;
  return (project.folders ?? []).some((folder) => folder.folderId === parentId && !folder.archived);
}

export function canChangeProjectFolder(user: User, project: Project, folderId: string) {
  if (user.role === "admin") return true;
  if (!canEditFolders(user, project)) return false;
  const folder = (project.folders ?? []).find((item) => item.folderId === folderId && !item.archived);
  return Boolean(folder?.parentId && folder.createdBy === user.id);
}

function canEditFolders(user: User, project: Project) {
  return !isDemoAccount(user) && canCreateJobInProject(user, project);
}
