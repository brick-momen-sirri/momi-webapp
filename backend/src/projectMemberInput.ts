// Turns a client-supplied member list into rows the project store can trust.
//
// The old path took `req.body.members` as-is on update and threw it away
// entirely on create, so a member naming a user id that does not exist was
// stored silently and the invite list from the create dialog never survived the
// request. Both failures were invisible: the caller got a 200 and a project
// nobody had been added to. Parsing here makes an unusable list an explicit
// 400 instead.

import type { ProjectMember } from "./types.js";

export type ProjectMemberInputContext = {
  // The project's owner, used as the fallback owner row when the submitted list
  // contains none, so a project can never end up with nobody who can manage it.
  // Only a fallback: a list that names a different owner is an ownership
  // transfer and is left alone.
  ownerId: string;
  actorId: string;
  now: string;
  userExists: (userId: string) => boolean;
};

export type ProjectMemberInputResult = {
  members: ProjectMember[];
  unknownUserIds: string[];
  invalidRoles: string[];
};

export function parseProjectMemberInput(input: unknown, context: ProjectMemberInputContext): ProjectMemberInputResult {
  const unknownUserIds: string[] = [];
  const invalidRoles: string[] = [];
  const byUserId = new Map<string, ProjectMember>();

  for (const entry of Array.isArray(input) ? input : []) {
    const userId = typeof (entry as ProjectMember)?.userId === "string" ? (entry as ProjectMember).userId.trim() : "";
    if (!userId) continue;

    const role = (entry as ProjectMember)?.role;
    if (!isProjectRole(role)) {
      invalidRoles.push(String(role));
      continue;
    }
    if (!context.userExists(userId)) {
      if (!unknownUserIds.includes(userId)) unknownUserIds.push(userId);
      continue;
    }

    byUserId.set(userId, {
      userId,
      role,
      addedAt: typeof (entry as ProjectMember).addedAt === "string" ? (entry as ProjectMember).addedAt : context.now,
      addedBy: typeof (entry as ProjectMember).addedBy === "string" ? (entry as ProjectMember).addedBy : context.actorId,
    });
  }

  if (!Array.from(byUserId.values()).some((member) => member.role === "owner")) {
    byUserId.set(context.ownerId, {
      userId: context.ownerId,
      role: "owner",
      addedAt: byUserId.get(context.ownerId)?.addedAt ?? context.now,
      addedBy: byUserId.get(context.ownerId)?.addedBy ?? context.actorId,
    });
  }

  return { members: Array.from(byUserId.values()), unknownUserIds, invalidRoles };
}

export function projectMemberInputError(result: ProjectMemberInputResult) {
  if (result.invalidRoles.length) {
    return "Project role must be owner, editor, or viewer.";
  }
  if (result.unknownUserIds.length) {
    return `No such user: ${result.unknownUserIds.join(", ")}.`;
  }
  return undefined;
}

function isProjectRole(role: unknown): role is ProjectMember["role"] {
  return role === "owner" || role === "editor" || role === "viewer";
}
