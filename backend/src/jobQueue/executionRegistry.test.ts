import assert from "node:assert/strict";
import test from "node:test";

import { ActiveExecutionRegistry } from "./executionRegistry.js";

test("only one execution can hold a job and each claim is immutable", () => {
  let nextToken = 0;
  const registry = new ActiveExecutionRegistry(() => `claim_${++nextToken}`);
  const first = registry.begin("job_1");

  assert.ok(first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(registry.begin("job_1"), undefined);
  assert.equal(registry.isCurrent(first), true);
  assert.deepEqual([...registry.jobIds()], ["job_1"]);
});

test("a stale claim cannot finish or clear a newer execution", () => {
  let nextToken = 0;
  const registry = new ActiveExecutionRegistry(() => `claim_${++nextToken}`);
  const first = registry.begin("job_1");
  assert.ok(first);
  assert.equal(registry.finish(first), true);

  const second = registry.begin("job_1");
  assert.ok(second);
  assert.notEqual(first.token, second.token);
  assert.equal(registry.finish(first), false);
  assert.equal(registry.isCurrent(second), true);
  assert.equal(registry.has("job_1"), true);
});

test("clear invalidates every outstanding execution token", () => {
  const registry = new ActiveExecutionRegistry();
  const first = registry.begin("job_1");
  const second = registry.begin("job_2");
  assert.ok(first && second);

  registry.clear();
  assert.equal(registry.isCurrent(first), false);
  assert.equal(registry.isCurrent(second), false);
  assert.deepEqual([...registry.jobIds()], []);
});
