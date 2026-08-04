import test from "node:test";
import assert from "node:assert/strict";

import { decideOpsAccess, isLoopbackAddress, tokensMatch } from "./opsAccessGuard.js";

const localOnly = { configuredToken: "", allowLoopback: true };

test("default posture: loopback in, everything else out", () => {
  assert.equal(decideOpsAccess({ ...localOnly, remoteAddress: "127.0.0.1" }).allowed, true);
  assert.equal(decideOpsAccess({ ...localOnly, remoteAddress: "::1" }).allowed, true);
  assert.equal(decideOpsAccess({ ...localOnly, remoteAddress: "::ffff:127.0.0.1" }).allowed, true);
  assert.equal(decideOpsAccess({ ...localOnly, remoteAddress: "192.168.1.50" }).allowed, false);
  assert.equal(decideOpsAccess({ ...localOnly, remoteAddress: "203.0.113.9" }).allowed, false);
});

test("a remote caller with no token configured is told how to enable access", () => {
  const decision = decideOpsAccess({ ...localOnly, remoteAddress: "203.0.113.9" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /OPS_ACCESS_TOKEN/);
});

test("a remote caller presenting the configured token is allowed", () => {
  const input = { configuredToken: "s3cret-ops", allowLoopback: true, remoteAddress: "203.0.113.9" };
  assert.equal(decideOpsAccess({ ...input, presentedToken: "s3cret-ops" }).allowed, true);
  assert.equal(decideOpsAccess({ ...input, presentedToken: "wrong" }).allowed, false);
  assert.equal(decideOpsAccess({ ...input, presentedToken: undefined }).allowed, false);
  // A prefix of the real token must not pass.
  assert.equal(decideOpsAccess({ ...input, presentedToken: "s3cret" }).allowed, false);
});

test("OPS_ALLOW_LOOPBACK=false closes the loopback bypass for proxied deployments", () => {
  const input = { configuredToken: "s3cret-ops", allowLoopback: false, remoteAddress: "127.0.0.1" };
  assert.equal(decideOpsAccess(input).allowed, false);
  assert.equal(decideOpsAccess({ ...input, presentedToken: "s3cret-ops" }).allowed, true);
});

test("an empty presented token never satisfies an empty configured token", () => {
  assert.equal(tokensMatch("", ""), false);
  assert.equal(tokensMatch(undefined, ""), false);
  assert.equal(
    decideOpsAccess({ configuredToken: "", allowLoopback: false, remoteAddress: "203.0.113.9", presentedToken: "" }).allowed,
    false,
  );
});

test("loopback detection does not over-match", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.5.6.7"), true);
  assert.equal(isLoopbackAddress("[::1]"), true);
  assert.equal(isLoopbackAddress("fe80::1%eth0"), false);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);
  assert.equal(isLoopbackAddress("128.0.0.1"), false);
  assert.equal(isLoopbackAddress("127.0.0.1.evil.test"), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(""), false);
});
