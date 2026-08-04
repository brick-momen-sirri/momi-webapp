import test from "node:test";
import assert from "node:assert/strict";

import { createLoginRateLimiter, loginRateLimitKeys } from "./loginRateLimiter.js";

const config = { maxAttempts: 3, windowMs: 60_000, lockoutMs: 120_000 };

function failTimes(limiter: ReturnType<typeof createLoginRateLimiter>, keys: string[], count: number, startMs = 0) {
  for (let i = 0; i < count; i += 1) limiter.recordFailure(keys, startMs + i);
}

test("attempts are allowed until the threshold is crossed", () => {
  const limiter = createLoginRateLimiter(config);
  const keys = ["ip:1.2.3.4"];
  assert.equal(limiter.check(keys, 0).allowed, true);
  failTimes(limiter, keys, 2);
  assert.equal(limiter.check(keys, 10).allowed, true, "two failures is still under the limit");
  failTimes(limiter, keys, 1, 10);
  assert.equal(limiter.check(keys, 20).allowed, false, "third failure trips the lockout");
});

test("a locked out caller is told how long to wait", () => {
  const limiter = createLoginRateLimiter(config);
  const keys = ["ip:1.2.3.4"];
  failTimes(limiter, keys, 3, 1_000);
  const verdict = limiter.check(keys, 3_000);
  assert.equal(verdict.allowed, false);
  // Tripped on the third failure at 1002ms, + 120s lockout = unlocks at 121002.
  assert.equal(verdict.retryAfterSeconds, 119);
});

test("the lockout outlives the failure window and then expires", () => {
  const limiter = createLoginRateLimiter(config);
  const keys = ["ip:1.2.3.4"];
  // lockoutMs (120s) is longer than windowMs (60s) here on purpose: the three
  // failures age out of the window well before the lockout ends, and that must
  // not release the caller early.
  failTimes(limiter, keys, 3);
  assert.equal(limiter.check(keys, config.windowMs + 1).allowed, false, "window expiry must not lift the lockout");
  assert.equal(limiter.check(keys, config.lockoutMs - 1).allowed, false);
  assert.equal(limiter.check(keys, config.lockoutMs + 100).allowed, true);
});

test("serving out a lockout returns the key to a full fresh allowance", () => {
  const limiter = createLoginRateLimiter(config);
  const keys = ["ip:1.2.3.4"];
  failTimes(limiter, keys, 3);
  const after = config.lockoutMs + 100;
  // One more failure must not immediately re-lock: the tally restarts at zero.
  limiter.recordFailure(keys, after);
  assert.equal(limiter.check(keys, after + 1).allowed, true);
  limiter.recordFailure(keys, after + 2);
  assert.equal(limiter.check(keys, after + 3).allowed, true);
  limiter.recordFailure(keys, after + 4);
  assert.equal(limiter.check(keys, after + 5).allowed, false, "three fresh failures lock it again");
});

test("failures older than the window do not accumulate toward a lockout", () => {
  const limiter = createLoginRateLimiter(config);
  const keys = ["ip:1.2.3.4"];
  // Two failures per window, spread over three windows: never 3 inside one window.
  failTimes(limiter, keys, 2, 0);
  failTimes(limiter, keys, 2, 70_000);
  failTimes(limiter, keys, 2, 140_000);
  assert.equal(limiter.check(keys, 140_100).allowed, true);
});

test("a successful login clears the caller's counters", () => {
  const limiter = createLoginRateLimiter(config);
  const keys = ["ip:1.2.3.4", "id:momen@brickvisual.com"];
  failTimes(limiter, keys, 3);
  assert.equal(limiter.check(keys, 10).allowed, false);
  limiter.recordSuccess(keys);
  assert.equal(limiter.check(keys, 10).allowed, true);
  assert.equal(limiter.trackedKeyCount(), 0);
});

test("either key tripping is enough to refuse the attempt", () => {
  const limiter = createLoginRateLimiter(config);
  // One account guessed from three different hosts: no single IP trips, but the
  // identifier key does.
  for (const ip of ["ip:1.1.1.1", "ip:2.2.2.2", "ip:3.3.3.3"]) {
    limiter.recordFailure([ip, "id:momen@brickvisual.com"], 0);
  }
  assert.equal(limiter.check(["ip:4.4.4.4", "id:momen@brickvisual.com"], 10).allowed, false);
  // A different account from a fresh host is unaffected.
  assert.equal(limiter.check(["ip:4.4.4.4", "id:someone.else@brickvisual.com"], 10).allowed, true);
});

test("one locked account does not lock out an innocent user on the same host", () => {
  const limiter = createLoginRateLimiter(config);
  // Deliberately checks the reverse of the case above: a shared office NAT means
  // the ip key is shared, so it *will* trip -- that is the intended trade-off,
  // and the lockout must still be time-bounded rather than permanent.
  failTimes(limiter, ["ip:1.2.3.4", "id:a@x.com"], 3);
  assert.equal(limiter.check(["ip:1.2.3.4", "id:b@x.com"], 10).allowed, false);
  assert.equal(limiter.check(["ip:1.2.3.4", "id:b@x.com"], config.lockoutMs + 100).allowed, true);
});

test("tracked keys are bounded so a spray cannot grow memory unbounded", () => {
  const limiter = createLoginRateLimiter(config);
  for (let i = 0; i < 7000; i += 1) {
    limiter.recordFailure([`ip:10.0.${Math.floor(i / 256)}.${i % 256}`], i);
  }
  assert.ok(limiter.trackedKeyCount() <= 5000, `expected <= 5000 tracked keys, got ${limiter.trackedKeyCount()}`);
});

test("stale entries are dropped once both the window and lockout have passed", () => {
  const limiter = createLoginRateLimiter(config);
  failTimes(limiter, ["ip:1.2.3.4"], 3);
  assert.equal(limiter.trackedKeyCount(), 1);
  // Any later failure triggers the prune pass.
  limiter.recordFailure(["ip:9.9.9.9"], 500_000);
  assert.equal(limiter.trackedKeyCount(), 1);
  assert.equal(limiter.check(["ip:1.2.3.4"], 500_000).allowed, true);
});

test("keys are derived from the address and a case-folded identifier", () => {
  assert.deepEqual(loginRateLimitKeys("1.2.3.4", " Momen@BrickVisual.com "), ["ip:1.2.3.4", "id:momen@brickvisual.com"]);
  // A missing address or an empty identifier must not produce a shared bucket
  // that every caller collides in.
  assert.deepEqual(loginRateLimitKeys(undefined, "a@b.com"), ["id:a@b.com"]);
  assert.deepEqual(loginRateLimitKeys("1.2.3.4", ""), ["ip:1.2.3.4"]);
  assert.deepEqual(loginRateLimitKeys(undefined, "  "), []);
});

test("an attempt with no usable keys is allowed rather than blocked outright", () => {
  const limiter = createLoginRateLimiter(config);
  assert.equal(limiter.check([], 0).allowed, true);
});
