import assert from "node:assert/strict";
import test from "node:test";
import { parseBackendProcessRole } from "./processRole.js";

test("process role defaults to monolith", () => {
  assert.equal(parseBackendProcessRole(undefined), "monolith");
  assert.equal(parseBackendProcessRole(""), "monolith");
});

test("process role accepts dispatcher and API roles case-insensitively", () => {
  assert.equal(parseBackendProcessRole(" dispatcher "), "dispatcher");
  assert.equal(parseBackendProcessRole("API"), "api");
});

test("process role rejects unknown values", () => {
  assert.throws(() => parseBackendProcessRole("worker"), /Invalid ROLE/);
});
