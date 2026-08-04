import test from "node:test";
import assert from "node:assert/strict";

import {
  canCreateJobInProject,
  canManageProject,
  canViewProject,
  filterJobsForUser,
  getProjectRole,
  isDemoAccount,
} from "./jobPermissions.js";
import type { Job, Project, User } from "./types.js";

// These predicates decide what one artist can see of another's work. They were
// buried in index.ts among the routes that called them and had no tests; the
// point of pulling them into their own module was to be able to write these.

function user(overrides: Partial<User> = {}): User {
  return {
    id: "usr_a",
    name: "a",
    email: "a@brickvisual.com",
    role: "user",
    active: true,
    ...overrides,
  } as User;
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: "proj_1", name: "Tower", shortName: "TWR", ownerId: "usr_owner", members: [], ...overrides } as Project;
}

function job(overrides: Partial<Job> = {}): Job {
  return { id: "job_1", projectId: "proj_1", userId: "usr_a", ...overrides } as Job;
}

test("getProjectRole returns the member's role, or undefined for a non-member", () => {
  const p = project({ members: [{ userId: "usr_a", role: "editor" }] as Project["members"] });
  assert.equal(getProjectRole(p, "usr_a"), "editor");
  assert.equal(getProjectRole(p, "usr_b"), undefined);
});

test("getProjectRole tolerates a project with no members array", () => {
  assert.equal(getProjectRole({ id: "p" } as Project, "usr_a"), undefined);
});

test("canViewProject: admin, owner, or any member", () => {
  const p = project({ ownerId: "usr_owner", members: [{ userId: "usr_viewer", role: "viewer" }] as Project["members"] });
  assert.equal(canViewProject(user({ role: "admin", id: "usr_nobody" }), p), true, "admin");
  assert.equal(canViewProject(user({ id: "usr_owner" }), p), true, "owner");
  assert.equal(canViewProject(user({ id: "usr_viewer" }), p), true, "member with the weakest role");
  assert.equal(canViewProject(user({ id: "usr_stranger" }), p), false, "unrelated user is denied");
});

test("canCreateJobInProject: admin, owner or editor -- not a viewer", () => {
  const asRole = (role: string) =>
    project({ ownerId: "usr_owner", members: [{ userId: "usr_a", role }] as unknown as Project["members"] });

  assert.equal(canCreateJobInProject(user({ role: "admin" }), asRole("viewer")), true);
  assert.equal(canCreateJobInProject(user(), asRole("owner")), true);
  assert.equal(canCreateJobInProject(user(), asRole("editor")), true);
  // The one that matters: a viewer must not be able to spend credits.
  assert.equal(canCreateJobInProject(user(), asRole("viewer")), false);
  assert.equal(canCreateJobInProject(user(), project()), false, "non-member");
});

test("canCreateJobInProject does not treat the project ownerId field as sufficient", () => {
  // canViewProject accepts project.ownerId; canCreateJobInProject deliberately
  // checks the members list instead. Pinned because the asymmetry looks like a
  // bug until you notice owners are always also members.
  const p = project({ ownerId: "usr_a", members: [] as Project["members"] });
  assert.equal(canViewProject(user({ id: "usr_a" }), p), true);
  assert.equal(canCreateJobInProject(user({ id: "usr_a" }), p), false);
});

test("canManageProject: admin, the ownerId, or a member with the owner role", () => {
  assert.equal(canManageProject(user({ role: "admin" }), project()), true);
  assert.equal(canManageProject(user({ id: "usr_owner" }), project()), true);
  assert.equal(
    canManageProject(user({ id: "usr_a" }), project({ members: [{ userId: "usr_a", role: "owner" }] as Project["members"] })),
    true,
  );
  assert.equal(
    canManageProject(user({ id: "usr_a" }), project({ members: [{ userId: "usr_a", role: "editor" }] as Project["members"] })),
    false,
    "an editor cannot manage the project",
  );
});

test("filterJobsForUser keeps an admin's view unfiltered", () => {
  const jobs = [job({ id: "j1", userId: "usr_a" }), job({ id: "j2", userId: "usr_b" })];
  const visible = filterJobsForUser(jobs, user({ role: "admin", id: "usr_admin" }));
  assert.deepEqual(
    visible.map((j) => j.id),
    ["j1", "j2"],
  );
});

test("filterJobsForUser keeps a plain user's own jobs and drops jobs it cannot reach", () => {
  const jobs = [job({ id: "j1", userId: "usr_a" }), job({ id: "j2", userId: "usr_b" })];
  // usr_b's job belongs to a project that does not exist in the store, so the
  // project fallback cannot grant access -- the default must be deny.
  const visible = filterJobsForUser(jobs, user({ id: "usr_a" }));
  assert.deepEqual(
    visible.map((j) => j.id),
    ["j1"],
  );
});

test("filterJobsForUser applies the ownerUserId narrowing on top of access", () => {
  const jobs = [job({ id: "j1", userId: "usr_a" }), job({ id: "j2", userId: "usr_b" })];
  const admin = user({ role: "admin", id: "usr_admin" });
  assert.deepEqual(
    filterJobsForUser(jobs, admin, "usr_b").map((j) => j.id),
    ["j2"],
  );
  // Narrowing must not widen: asking for a user with no jobs yields nothing.
  assert.deepEqual(filterJobsForUser(jobs, admin, "usr_none"), []);
});

test("isDemoAccount recognises the built-in demo identities", () => {
  assert.equal(isDemoAccount(user({ email: "demo@brickvisual.com" })), true);
  assert.equal(isDemoAccount(user({ email: "momi.demo@brickvisual.com" })), true);
  assert.equal(isDemoAccount(user({ email: "x@y.com", username: "demo" } as Partial<User>)), true);
  assert.equal(isDemoAccount(user({ email: "x@y.com", username: "momi-demo" } as Partial<User>)), true);
  assert.equal(isDemoAccount(user({ email: "momen@brickvisual.com" })), false);
});

test("isDemoAccount is case-insensitive and reads MOMI_DEMO_EMAILS", () => {
  assert.equal(isDemoAccount(user({ email: "DEMO@BrickVisual.com" })), true);

  const previous = process.env.MOMI_DEMO_EMAILS;
  process.env.MOMI_DEMO_EMAILS = " client.demo@brickvisual.com , second@x.com ";
  try {
    assert.equal(isDemoAccount(user({ email: "client.demo@brickvisual.com" })), true);
    assert.equal(isDemoAccount(user({ email: "Second@X.com" })), true);
    assert.equal(isDemoAccount(user({ email: "third@x.com" })), false);
  } finally {
    if (previous === undefined) delete process.env.MOMI_DEMO_EMAILS;
    else process.env.MOMI_DEMO_EMAILS = previous;
  }
});

test("isDemoAccount does not treat an empty MOMI_DEMO_EMAILS as matching everyone", () => {
  const previous = process.env.MOMI_DEMO_EMAILS;
  process.env.MOMI_DEMO_EMAILS = " , ,, ";
  try {
    assert.equal(isDemoAccount(user({ email: "momen@brickvisual.com" })), false);
  } finally {
    if (previous === undefined) delete process.env.MOMI_DEMO_EMAILS;
    else process.env.MOMI_DEMO_EMAILS = previous;
  }
});
