import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  fsErrorCode,
  isTransientFsError,
  renameWithRetry,
  retryTransientFs,
  rmWithRetry,
  writeFileWithRetry,
} from "./fsRetry.js";

function fsError(code: string) {
  return Object.assign(new Error(code), { code });
}

test("isTransientFsError matches the share errors and nothing else", () => {
  for (const code of ["ENOTEMPTY", "EBUSY", "EPERM"]) {
    assert.equal(isTransientFsError(fsError(code)), true, `${code} should be retryable`);
  }
  // EACCES is a real permission failure - retrying only delays the error.
  for (const code of ["EACCES", "ENOENT", "EEXIST", "EISDIR"]) {
    assert.equal(isTransientFsError(fsError(code)), false, `${code} should not be retryable`);
  }
  assert.equal(isTransientFsError(new Error("no code")), false);
  assert.equal(isTransientFsError(undefined), false);
  assert.equal(isTransientFsError(null), false);
  assert.equal(isTransientFsError("ENOTEMPTY"), false);
});

test("fsErrorCode reads the code without throwing on odd inputs", () => {
  assert.equal(fsErrorCode(fsError("EBUSY")), "EBUSY");
  assert.equal(fsErrorCode(new Error("plain")), "");
  assert.equal(fsErrorCode(null), "");
  assert.equal(fsErrorCode(42), "");
});

test("retryTransientFs succeeds once the delete-pending entry clears", async () => {
  let calls = 0;
  const result = await retryTransientFs(
    async () => {
      calls += 1;
      if (calls < 3) throw fsError("ENOTEMPTY");
      return "removed";
    },
    { initialDelayMs: 1, maxDelayMs: 2 },
  );

  assert.equal(result, "removed");
  assert.equal(calls, 3, "should have retried twice before succeeding");
});

test("retryTransientFs gives up after the attempt budget and surfaces the original error", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientFs(
      async () => {
        calls += 1;
        throw fsError("EBUSY");
      },
      { attempts: 4, initialDelayMs: 1, maxDelayMs: 2 },
    ),
    (error: unknown) => fsErrorCode(error) === "EBUSY",
  );

  assert.equal(calls, 4, "should stop at the configured attempt count");
});

test("retryTransientFs does not retry a genuine permission failure", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientFs(async () => {
      calls += 1;
      throw fsError("EACCES");
    }),
    (error: unknown) => fsErrorCode(error) === "EACCES",
  );

  assert.equal(calls, 1, "EACCES should fail on the first attempt");
});

test("retryTransientFs does not retry a non-filesystem bug", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientFs(async () => {
      calls += 1;
      throw new TypeError("undefined is not a function");
    }),
    TypeError,
  );

  assert.equal(calls, 1, "a programming error must not be retried");
});

test("attempts below 1 still run the operation exactly once", async () => {
  let calls = 0;
  const value = await retryTransientFs(
    async () => {
      calls += 1;
      return "ok";
    },
    { attempts: 0 },
  );

  assert.equal(value, "ok");
  assert.equal(calls, 1);
});

test("rmWithRetry removes a directory whose children were only just unlinked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-fsretry-"));
  const nested = path.join(root, "shots");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "a.bin"), "x");

  await rmWithRetry(nested, { recursive: true, force: true });
  assert.equal(await fs.stat(nested).then(() => true).catch(() => false), false);

  // force: true must stay tolerant of an already-absent path.
  await rmWithRetry(nested, { force: true });

  await fs.rm(root, { recursive: true, force: true });
});

test("renameWithRetry and writeFileWithRetry behave like the plain calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-fsretry-"));
  const from = path.join(root, "render_0001.txt");
  const to = path.join(root, "render_0001_final.txt");

  await writeFileWithRetry(from, "frame one");
  await renameWithRetry(from, to);

  assert.equal(await fs.readFile(to, "utf8"), "frame one");
  assert.equal(await fs.stat(from).then(() => true).catch(() => false), false);

  // Overwriting an existing destination is the render-output case.
  await writeFileWithRetry(to, "frame one OVERWRITTEN");
  assert.equal(await fs.readFile(to, "utf8"), "frame one OVERWRITTEN");

  await assert.rejects(renameWithRetry(path.join(root, "missing.txt"), to), (error: unknown) => fsErrorCode(error) === "ENOENT");

  await fs.rm(root, { recursive: true, force: true });
});
