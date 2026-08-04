import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isPathWithinRoot, resolveExistingPathWithinRoots } from "./pathContainment.js";

test("accepts only the root itself or a real descendant on the host filesystem", () => {
  const root = path.resolve(os.tmpdir(), "momi-containment", "project");
  const repeated = `${root}${path.sep}${path.sep}images${path.sep}${path.sep}shot.png`;

  assert.equal(isPathWithinRoot(root, root), true);
  assert.equal(isPathWithinRoot(`${root}${path.sep}`, root), true);
  assert.equal(isPathWithinRoot(path.join(root, "direct.png"), root), true);
  assert.equal(isPathWithinRoot(path.join(root, "deep", "nested", "clip.mp4"), root), true);
  assert.equal(isPathWithinRoot(repeated, root), true);
  assert.equal(isPathWithinRoot(`${root}-backup${path.sep}secret.png`, root), false);
  assert.equal(isPathWithinRoot(`${root}2${path.sep}secret.png`, root), false);
  assert.equal(isPathWithinRoot(path.join(root, "..", "outside.png"), root), false);
  assert.equal(isPathWithinRoot(path.resolve(root, "..", "absolute-outside.png"), root), false);
  assert.equal(isPathWithinRoot(`${root}\0hidden.png`, root), false);
});

test("uses Windows drive, case, mixed-separator, and UNC semantics explicitly", () => {
  const root = "D:\\media\\project";

  assert.equal(isPathWithinRoot("d:\\MEDIA\\PROJECT", root), true);
  assert.equal(isPathWithinRoot("d:/MEDIA/project\\deep//shot.png", root), true);
  assert.equal(isPathWithinRoot("D:\\media\\project-backup\\shot.png", root), false);
  assert.equal(isPathWithinRoot("D:\\media\\project2\\shot.png", root), false);
  assert.equal(isPathWithinRoot("D:\\media\\project\\..\\secret.png", root), false);
  assert.equal(isPathWithinRoot("C:\\media\\project\\shot.png", root), false);

  const uncRoot = "\\\\render-host\\media\\project";
  assert.equal(isPathWithinRoot("\\\\RENDER-HOST\\MEDIA\\PROJECT\\shots\\a.png", uncRoot), true);
  assert.equal(isPathWithinRoot("\\\\render-host\\media\\project-evil\\a.png", uncRoot), false);
  assert.equal(isPathWithinRoot("\\\\other-host\\media\\project\\a.png", uncRoot), false);
});

test("rejects invalid candidates and roots", () => {
  assert.equal(isPathWithinRoot("", "C:\\media"), false);
  assert.equal(isPathWithinRoot("C:\\media\\image.png", ""), false);
  assert.equal(isPathWithinRoot("C:\\media\0\\image.png", "C:\\media"), false);
  assert.equal(isPathWithinRoot("C:\\media\\image.png", "C:\\media\0"), false);
});

test("real-path containment rejects a symbolic-link or junction escape", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-containment-real-"));
  const allowedRoot = path.join(tempRoot, "allowed");
  const outsideRoot = path.join(tempRoot, "outside");
  const directFile = path.join(allowedRoot, "images", "direct.png");
  const outsideFile = path.join(outsideRoot, "secret.png");
  const escapeLink = path.join(allowedRoot, "escape");

  try {
    await fs.mkdir(path.dirname(directFile), { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(directFile, "inside");
    await fs.writeFile(outsideFile, "outside");

    try {
      await fs.symlink(outsideRoot, escapeLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        t.skip(`filesystem links are unavailable on this host (${code})`);
        return;
      }
      throw error;
    }

    assert.equal(await resolveExistingPathWithinRoots(directFile, [allowedRoot]), await fs.realpath(directFile));
    assert.equal(await resolveExistingPathWithinRoots(path.join(escapeLink, "secret.png"), [allowedRoot]), undefined);
    assert.equal(await resolveExistingPathWithinRoots(path.join(allowedRoot, "missing.png"), [allowedRoot]), undefined);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
