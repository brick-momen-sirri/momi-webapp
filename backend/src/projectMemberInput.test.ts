import test from "node:test";
import assert from "node:assert/strict";

import { parseProjectMemberInput, projectMemberInputError } from "./projectMemberInput.js";

// The bug these exist for: the create route discarded the submitted list and the
// update route stored it unchecked, so "I added five people" produced a project
// with one member and no error either way.

const KNOWN = new Set(["usr_owner", "usr_a", "usr_b"]);

function context(overrides: Partial<Parameters<typeof parseProjectMemberInput>[1]> = {}) {
  return {
    ownerId: "usr_owner",
    actorId: "usr_owner",
    now: "2026-08-10T00:00:00.000Z",
    userExists: (userId: string) => KNOWN.has(userId),
    ...overrides,
  };
}

test("keeps every submitted member with its role", () => {
  const result = parseProjectMemberInput(
    [
      { userId: "usr_a", role: "editor" },
      { userId: "usr_b", role: "viewer" },
    ],
    context(),
  );
  assert.equal(projectMemberInputError(result), undefined);
  assert.deepEqual(
    result.members.map((member) => [member.userId, member.role]),
    [
      ["usr_a", "editor"],
      ["usr_b", "viewer"],
      ["usr_owner", "owner"],
    ],
  );
});

test("stamps addedAt/addedBy when the caller omits them", () => {
  const [member] = parseProjectMemberInput([{ userId: "usr_a", role: "editor" }], context({ actorId: "usr_b" })).members;
  assert.equal(member.addedAt, "2026-08-10T00:00:00.000Z");
  assert.equal(member.addedBy, "usr_b");
});

test("reports a user id that does not exist instead of dropping it silently", () => {
  const result = parseProjectMemberInput(
    [
      { userId: "usr_a", role: "editor" },
      { userId: "usr_ghost", role: "editor" },
    ],
    context(),
  );
  assert.deepEqual(result.unknownUserIds, ["usr_ghost"]);
  assert.equal(projectMemberInputError(result), "No such user: usr_ghost.");
});

test("reports an unrecognized role rather than downgrading it to viewer", () => {
  const result = parseProjectMemberInput([{ userId: "usr_a", role: "admin" }], context());
  assert.deepEqual(result.invalidRoles, ["admin"]);
  assert.equal(projectMemberInputError(result), "Project role must be owner, editor, or viewer.");
});

test("adds the fallback owner row only when the list names no owner", () => {
  const withOwner = parseProjectMemberInput([{ userId: "usr_a", role: "owner" }], context());
  assert.deepEqual(
    withOwner.members.map((member) => member.userId),
    ["usr_a"],
    "an ownership transfer is left alone",
  );

  const withoutOwner = parseProjectMemberInput([{ userId: "usr_a", role: "editor" }], context());
  assert.deepEqual(
    withoutOwner.members.map((member) => [member.userId, member.role]),
    [
      ["usr_a", "editor"],
      ["usr_owner", "owner"],
    ],
  );
});

test("last entry wins for a duplicated user id", () => {
  const result = parseProjectMemberInput(
    [
      { userId: "usr_a", role: "viewer" },
      { userId: "usr_a", role: "editor" },
    ],
    context(),
  );
  assert.deepEqual(
    result.members.filter((member) => member.userId === "usr_a").map((member) => member.role),
    ["editor"],
  );
});

test("a non-array body yields the owner alone, not an empty project", () => {
  for (const input of [undefined, null, "usr_a", {}]) {
    const result = parseProjectMemberInput(input, context());
    assert.deepEqual(
      result.members.map((member) => [member.userId, member.role]),
      [["usr_owner", "owner"]],
    );
  }
});
