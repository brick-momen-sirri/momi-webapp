// These predicates decide whether the workspace offers a live generation form or
// a view-only one, so the cases that matter are the ones where the client and the
// server could disagree -- a disagreement shows up as a 403 after the artist has
// already filled the form in.

import { describe, expect, it } from "vitest";
import {
  canCreateJobInProject,
  canManageProjectMembers,
  canViewProject,
  hasViewOnlyProjectAccess,
  projectRoleForUser,
} from "./projectAccess";
import type { Project, ProjectMember, ProjectRole } from "../../types";

function member(userId: string, role: ProjectRole): ProjectMember {
  return { userId, role, addedAt: "2026-08-10T09:00:00.000Z", addedBy: "usr_owner" };
}

// Private by default so each membership case below is actually exercising the
// members list. A team project grants access without any row at all, which has
// its own describe block.
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    name: "Azari project",
    shortName: "7982",
    ownerId: "usr_owner",
    members: [member("usr_owner", "owner")],
    groupMembers: [],
    jobCount: 0,
    memberCount: 1,
    createdAt: "2026-08-10T09:00:00.000Z",
    visibility: "private",
    ...overrides,
  };
}

const artist = { id: "usr_artist", role: "user" as const };
const admin = { id: "usr_admin", role: "admin" as const };

describe("projectRoleForUser", () => {
  it("reads the caller's own membership row", () => {
    const target = project({ members: [member("usr_owner", "owner"), member("usr_artist", "editor")] });
    expect(projectRoleForUser(target, "usr_artist")).toBe("editor");
  });

  it("returns undefined for a non-member", () => {
    expect(projectRoleForUser(project(), "usr_stranger")).toBeUndefined();
  });
});

describe("canCreateJobInProject", () => {
  it("allows an editor", () => {
    const target = project({ members: [member("usr_owner", "owner"), member("usr_artist", "editor")] });
    expect(canCreateJobInProject(artist, target)).toBe(true);
  });

  it("allows a project owner", () => {
    const target = project({ ownerId: "usr_artist", members: [member("usr_artist", "owner")] });
    expect(canCreateJobInProject(artist, target)).toBe(true);
  });

  it("refuses a viewer", () => {
    // The case behind the 403s: added to the project, but with the default role.
    const target = project({ members: [member("usr_owner", "owner"), member("usr_artist", "viewer")] });
    expect(canCreateJobInProject(artist, target)).toBe(false);
  });

  it("allows a workspace admin who is not a member at all", () => {
    expect(canCreateJobInProject(admin, project())).toBe(true);
  });

  it("does not treat group membership as write access, matching the server", () => {
    const target = project({
      groupMembers: [{ groupId: "grp_1", role: "editor", addedAt: "2026-08-10T09:00:00.000Z", addedBy: "usr_owner" }],
    });
    expect(canCreateJobInProject(artist, target)).toBe(false);
  });

  it("refuses an owner recorded only on ownerId", () => {
    // The server reads `members`, not `ownerId`, so claiming access here would
    // put the form in a state the upload endpoint refuses.
    const target = project({ ownerId: "usr_artist", members: [] });
    expect(canCreateJobInProject(artist, target)).toBe(false);
  });
});

describe("team visibility", () => {
  it("lets any account generate in a team project with no membership row", () => {
    // The case the whole change exists for: a project you were never added to is
    // still usable, so a forgotten invite list is no longer a blocker.
    expect(canCreateJobInProject(artist, project({ visibility: "team" }))).toBe(true);
    expect(hasViewOnlyProjectAccess(artist, project({ visibility: "team" }))).toBe(false);
  });

  it("keeps an explicit viewer row read-only on a team project", () => {
    const target = project({ visibility: "team", members: [member("usr_artist", "viewer")] });
    expect(canViewProject(artist, target)).toBe(true);
    expect(canCreateJobInProject(artist, target)).toBe(false);
  });

  it("treats a project with no stored visibility as a team project", () => {
    const target = { ...project(), visibility: undefined } as unknown as Project;
    expect(canCreateJobInProject(artist, target)).toBe(true);
  });

  it("does not let team visibility grant membership management", () => {
    expect(canManageProjectMembers(artist, project({ visibility: "team" }))).toBe(false);
    expect(canManageProjectMembers(admin, project({ visibility: "team" }))).toBe(true);
    expect(canManageProjectMembers(artist, project({ ownerId: "usr_artist" }))).toBe(true);
  });
});

describe("hasViewOnlyProjectAccess", () => {
  it("is true for a viewer", () => {
    const target = project({ members: [member("usr_artist", "viewer")] });
    expect(hasViewOnlyProjectAccess(artist, target)).toBe(true);
  });

  it("is false with no project selected", () => {
    // "All projects" is not a view-only project; the caller reports that state
    // with its own message, and reporting both at once would contradict.
    expect(hasViewOnlyProjectAccess(artist, undefined)).toBe(false);
  });

  it("is false before the session resolves", () => {
    expect(hasViewOnlyProjectAccess(null, project())).toBe(false);
  });
});
