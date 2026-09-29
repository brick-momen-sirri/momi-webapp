import test from "node:test";
import assert from "node:assert/strict";

import { canChangeProjectFolder, canCreateProjectFolder } from "./folderPermissions.js";
import type { Project, ProjectFolder, User } from "./types.js";

// The training layout: a folder per artist at the first level (made by an admin),
// and artists adding their own shot folders inside.

function user(overrides: Partial<User> = {}): User {
  return { id: "usr_sara", name: "Sara", email: "sara@brickvisual.com", role: "user", active: true, ...overrides } as User;
}

function folder(folderId: string, parentId: string | null, createdBy: string, archived = false): ProjectFolder {
  return { folderId, parentId, name: folderId, slug: folderId, diskName: folderId, createdAt: "", updatedAt: "", createdBy, archived };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    name: "Animation-Training",
    shortName: "2345",
    ownerId: "usr_admin",
    visibility: "team",
    members: [],
    folders: [
      folder("fld_sara", null, "usr_admin"),
      folder("fld_sara_0100", "fld_sara", "usr_sara"),
      folder("fld_sara_0200", "fld_sara", "usr_omar"),
      folder("fld_gone", "fld_sara", "usr_sara", true),
    ],
    ...overrides,
  } as Project;
}

test("an artist can add a subfolder inside an existing folder, but not at the first level", () => {
  assert.equal(canCreateProjectFolder(user(), project(), "fld_sara"), true);
  assert.equal(canCreateProjectFolder(user(), project(), "fld_sara_0100"), true);
  assert.equal(canCreateProjectFolder(user(), project(), null), false);
});

test("an artist cannot add a subfolder under a missing or archived folder", () => {
  assert.equal(canCreateProjectFolder(user(), project(), "fld_nope"), false);
  assert.equal(canCreateProjectFolder(user(), project(), "fld_gone"), false);
});

test("an artist can rename or delete only a subfolder they created", () => {
  assert.equal(canChangeProjectFolder(user(), project(), "fld_sara_0100"), true);
  assert.equal(canChangeProjectFolder(user(), project(), "fld_sara_0200"), false);
  // Their own top-level folder was made by an admin, and the first level is the admin's.
  assert.equal(canChangeProjectFolder(user(), project(), "fld_sara"), false);
  assert.equal(canChangeProjectFolder(user(), project(), "fld_gone"), false);
});

test("an admin can do everything", () => {
  const admin = user({ id: "usr_admin", role: "admin" });
  assert.equal(canCreateProjectFolder(admin, project(), null), true);
  assert.equal(canChangeProjectFolder(admin, project(), "fld_sara"), true);
  assert.equal(canChangeProjectFolder(admin, project(), "fld_sara_0200"), true);
});

test("someone who cannot generate in the project cannot change its folders", () => {
  const viewerProject = project({ members: [{ userId: "usr_sara", role: "viewer" }] as Project["members"] });
  assert.equal(canCreateProjectFolder(user(), viewerProject, "fld_sara"), false);
  assert.equal(canChangeProjectFolder(user(), viewerProject, "fld_sara_0100"), false);

  const privateProject = project({ visibility: "private" });
  assert.equal(canCreateProjectFolder(user(), privateProject, "fld_sara"), false);
});
