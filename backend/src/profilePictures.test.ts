import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { profilePictureContentType, resolveProfilePicturePath } from "./profilePictures.js";

test("resolves only known profile-picture renditions", () => {
  const root = path.resolve("profile-pictures");
  assert.equal(
    resolveProfilePicturePath(root, "andras-dsc6597-0123456789", "avatar-128.webp"),
    path.join(root, "andras-dsc6597-0123456789", "avatar-128.webp"),
  );
  assert.equal(resolveProfilePicturePath(root, "../private", "original.png"), undefined);
  assert.equal(resolveProfilePicturePath(root, "valid-id", "../../users.json"), undefined);
  assert.equal(resolveProfilePicturePath(root, "valid-id", "avatar-1024.webp"), undefined);
});

test("reports the profile-picture content types", () => {
  assert.equal(profilePictureContentType("avatar-64.webp"), "image/webp");
  assert.equal(profilePictureContentType("original.png"), "image/png");
  assert.equal(profilePictureContentType("avatar.svg"), undefined);
});
