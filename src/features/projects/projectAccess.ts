// Client-side mirror of the server's project permission rules.
//
// The backend gates media uploads and job creation on canCreateJobInProject
// (backend/src/jobPermissions.ts). Without the same rule here, a viewer gets a
// fully live generation form and only discovers the refusal after filling it in,
// as a 403 toast per attempt. These predicates let the workspace present the
// view-only state up front instead.
//
// Deliberately a faithful mirror, not an improvement on the server rule:
//   - a "team" project (the default) grants every account an implicit editor
//     grant, so no membership row is needed to work in it;
//   - an explicit viewer row outranks that grant, which is how a client review
//     account stays read-only on a team project;
//   - "private" means `members` is the whole access list, and group membership
//     grants nothing;
//   - `ownerId` alone is not enough for a private project -- the server wants an
//     owner/editor row in `members`, which projectService keeps in place for
//     every owner.
//
// The demo-account rule is the caller's: getDisabledReason reports that refusal
// before it consults these predicates, with a message of its own.

import type { AuthUser } from "../../services/api/types";
import type { Project, ProjectRole } from "../../types";

type AccessUser = Pick<AuthUser, "id" | "role"> | null | undefined;

export function projectRoleForUser(project: Project | undefined, userId: string): ProjectRole | undefined {
  return project?.members?.find((member) => member.userId === userId)?.role;
}

// Projects stored before visibility existed carry no value; mapProject fills in
// "team" on the way in, and resolving an absent value the same way here keeps
// the two paths from disagreeing.
export function grantsWorkspaceAccess(project?: Project) {
  return (project?.visibility ?? "team") !== "private";
}

export function canViewProject(user: AccessUser, project?: Project) {
  if (!user || !project) return false;
  if (user.role === "admin" || project.ownerId === user.id) return true;
  if (projectRoleForUser(project, user.id)) return true;
  return grantsWorkspaceAccess(project);
}

export function canCreateJobInProject(user: AccessUser, project?: Project) {
  if (!user || !project) return false;
  if (user.role === "admin") return true;
  const role = projectRoleForUser(project, user.id);
  if (role === "owner" || role === "editor") return true;
  if (role === "viewer") return false;
  return grantsWorkspaceAccess(project);
}

export function canManageProjectMembers(user: AccessUser, project?: Project) {
  if (!user || !project) return false;
  return user.role === "admin" || project.ownerId === user.id || projectRoleForUser(project, user.id) === "owner";
}

// False when no project is selected: "nothing chosen yet" is a different state
// from "chosen, and you may only look at it", and the caller reports it with its
// own message.
export function hasViewOnlyProjectAccess(user: AccessUser, project?: Project) {
  if (!user || !project) return false;
  return !canCreateJobInProject(user, project);
}
