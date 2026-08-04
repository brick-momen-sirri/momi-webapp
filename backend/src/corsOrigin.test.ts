import test from "node:test";
import assert from "node:assert/strict";

import { isOriginAllowed, isPrivateOriginHostname, normalizeOrigin } from "./corsOrigin.js";

const defaultPolicy = { allowedOrigins: [] as string[], allowPrivateOrigins: true };

test("a request with no Origin header is allowed (server-to-server callers send none)", () => {
  assert.equal(isOriginAllowed(undefined, defaultPolicy), true);
  assert.equal(isOriginAllowed("", defaultPolicy), true);
});

test("arbitrary public origins are denied by default", () => {
  assert.equal(isOriginAllowed("https://evil.example.com", defaultPolicy), false);
  assert.equal(isOriginAllowed("http://attacker.test:8190", defaultPolicy), false);
});

test("the local and LAN origins the app is actually opened from stay allowed", () => {
  for (const origin of [
    "http://localhost:8190",
    "http://127.0.0.1:8190",
    "http://localhost:8191",
    "https://localhost:5173",
    "http://192.168.1.42:8190",
    "http://10.0.0.7:3333",
    "http://172.20.5.9:8190",
    "http://workstation.local:8190",
    "http://[::1]:8190",
  ]) {
    assert.equal(isOriginAllowed(origin, defaultPolicy), true, `expected ${origin} to be allowed`);
  }
});

test("private origins can be turned off for a hardened deployment", () => {
  const policy = { allowedOrigins: [], allowPrivateOrigins: false };
  assert.equal(isOriginAllowed("http://localhost:8190", policy), false);
  assert.equal(isOriginAllowed("http://192.168.1.42:8190", policy), false);
});

test("an explicitly allowed public origin is matched exactly", () => {
  const policy = { allowedOrigins: ["https://momi.brickvisual.com"], allowPrivateOrigins: false };
  assert.equal(isOriginAllowed("https://momi.brickvisual.com", policy), true);
  // Case and a trailing slash must not defeat the match.
  assert.equal(isOriginAllowed("https://MOMI.brickvisual.com/", policy), true);
  // A different scheme, port or a suffix attack must not match.
  assert.equal(isOriginAllowed("http://momi.brickvisual.com", policy), false);
  assert.equal(isOriginAllowed("https://momi.brickvisual.com:8443", policy), false);
  assert.equal(isOriginAllowed("https://momi.brickvisual.com.evil.test", policy), false);
  assert.equal(isOriginAllowed("https://evilmomi.brickvisual.com", policy), false);
});

test('"*" reflects any origin as an explicit emergency rollback', () => {
  const policy = { allowedOrigins: ["*"], allowPrivateOrigins: false };
  assert.equal(isOriginAllowed("https://evil.example.com", policy), true);
});

test("opaque and non-http origins are denied", () => {
  assert.equal(isOriginAllowed("null", defaultPolicy), false);
  assert.equal(isOriginAllowed("file://", defaultPolicy), false);
  assert.equal(isOriginAllowed("chrome-extension://abcdef", defaultPolicy), false);
  assert.equal(isOriginAllowed("not a url", defaultPolicy), false);
});

test("public IPs that merely look private are not treated as private", () => {
  assert.equal(isPrivateOriginHostname("172.32.0.1"), false);
  assert.equal(isPrivateOriginHostname("172.15.0.1"), false);
  assert.equal(isPrivateOriginHostname("11.0.0.1"), false);
  assert.equal(isPrivateOriginHostname("192.169.1.1"), false);
  assert.equal(isPrivateOriginHostname("127.0.0.1.evil.test"), false);
  // Out-of-range octets are not a valid IPv4 address at all.
  assert.equal(isPrivateOriginHostname("10.0.0.999"), false);
});

test("private hostname matching covers loopback, RFC1918, link-local and IPv6", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.254", "169.254.10.1", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPrivateOriginHostname(host), true, `expected ${host} to be private`);
  }
});

test("normalizeOrigin lowercases and strips trailing slashes", () => {
  assert.equal(normalizeOrigin("  HTTPS://Example.COM/// "), "https://example.com");
});
