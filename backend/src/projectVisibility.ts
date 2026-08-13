// Whether a project needs membership rows at all.
//
// "team" is the studio's normal case: any workspace account may generate into a
// live project, so listing every artist on every project was pure ceremony --
// and the step people kept forgetting, which left the project unusable for
// everyone but its creator. Team projects therefore grant an implicit editor
// grant to every account, and `members` is only there to record owners and to
// pin someone down to viewer.
//
// "private" is the opt-in exception for client-sensitive work: no implicit
// grant, `members` is the whole access list.
//
// "public" predates this rule and is stored on nothing yet; there is no
// anonymous surface in this app, so it is treated exactly like "team" rather
// than given a third meaning. Projects stored before visibility existed have no
// value at all, and the frontend has always displayed those as "Team" -- so an
// absent value resolves to "team" and reality now matches the badge.

import type { Project, ProjectVisibility } from "./types.js";

export const DEFAULT_PROJECT_VISIBILITY: ProjectVisibility = "team";

export function normalizeProjectVisibility(value: unknown): ProjectVisibility {
  return value === "private" || value === "team" || value === "public" ? value : DEFAULT_PROJECT_VISIBILITY;
}

export function isProjectVisibility(value: unknown): value is ProjectVisibility {
  return value === "private" || value === "team" || value === "public";
}

// True when every workspace account reaches this project without a members row.
export function grantsWorkspaceAccess(project: Pick<Project, "visibility">) {
  return normalizeProjectVisibility(project.visibility) !== "private";
}
