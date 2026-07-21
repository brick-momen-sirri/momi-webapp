import assert from "node:assert/strict";
import test from "node:test";
import { projectFolderName } from "./projectFolderName.js";

test("projectFolderName handles Windows project paths on every OS", () => {
  assert.equal(
    projectFolderName("C:\\ComfyUI\\output\\projects\\1234_TestOffice_TestProject"),
    "1234_TestOffice_TestProject",
  );
});

test("projectFolderName handles POSIX and mixed-separator project paths", () => {
  assert.equal(projectFolderName("/srv/output/projects/1234_TestOffice_TestProject"), "1234_TestOffice_TestProject");
  assert.equal(projectFolderName("C:\\ComfyUI/output\\projects/1234_TestOffice_TestProject"), "1234_TestOffice_TestProject");
});

test("projectFolderName ignores trailing separators", () => {
  assert.equal(
    projectFolderName("C:\\ComfyUI\\output\\projects\\1234_TestOffice_TestProject\\"),
    "1234_TestOffice_TestProject",
  );
  assert.equal(projectFolderName("/srv/output/projects/1234_TestOffice_TestProject/"), "1234_TestOffice_TestProject");
});

test("projectFolderName preserves empty optional inputs", () => {
  assert.equal(projectFolderName(""), "");
  assert.equal(projectFolderName(null), "");
  assert.equal(projectFolderName(undefined), "");
});
