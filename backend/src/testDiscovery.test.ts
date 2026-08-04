import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverBackendTests, isBackendTestFile } from "../scripts/testDiscovery.mjs";

test("test discovery recognizes supported test and spec entry points", () => {
  assert.equal(isBackendTestFile("queue.test.ts"), true);
  assert.equal(isBackendTestFile("queue.integration.test.ts"), true);
  assert.equal(isBackendTestFile("queue.spec.tsx"), true);
  assert.equal(isBackendTestFile("queue.fixture.ts"), false);
  assert.equal(isBackendTestFile("testHelpers.ts"), false);
});

test("test discovery is recursive, deterministic, and excludes fixture/helper directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-test-discovery-"));
  try {
    await Promise.all([
      fs.mkdir(path.join(root, "nested"), { recursive: true }),
      fs.mkdir(path.join(root, "fixtures"), { recursive: true }),
      fs.mkdir(path.join(root, "helpers"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, "z.test.ts"), ""),
      fs.writeFile(path.join(root, "nested", "a.spec.ts"), ""),
      fs.writeFile(path.join(root, "nested", "support.ts"), ""),
      fs.writeFile(path.join(root, "fixtures", "fixture.test.ts"), ""),
      fs.writeFile(path.join(root, "helpers", "helper.test.ts"), ""),
    ]);

    const discovered = (await discoverBackendTests(root)).map((filePath) =>
      path.relative(root, filePath).replaceAll(path.sep, "/"),
    );
    assert.deepEqual(discovered, ["nested/a.spec.ts", "z.test.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
