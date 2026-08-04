import test from "node:test";
import assert from "node:assert/strict";
import type express from "express";

import { clearSessionCookie, setSessionCookie } from "./sessionCookie.js";

// Small module, but every attribute on this cookie is a security decision. The
// flags are asserted individually so that dropping one is a test failure rather
// than a silent downgrade.

function fakeResponse() {
  const headers = new Map<string, string>();
  return {
    res: { setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value) } as unknown as express.Response,
    cookie: () => headers.get("set-cookie") ?? "",
  };
}

function setCookie(token: string, expiresAt: string) {
  const { res, cookie } = fakeResponse();
  setSessionCookie(res, token, expiresAt);
  return cookie();
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

test("the session cookie carries HttpOnly, SameSite=Lax and a root path", () => {
  const cookie = setCookie("sess_abc", inAnHour());
  assert.match(cookie, /^momi_session=/);
  // HttpOnly keeps the token out of reach of any script on the page, which is
  // the whole reason a cookie is used alongside the header.
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});

test("Max-Age tracks the session's own expiry", () => {
  const cookie = setCookie("sess_abc", new Date(Date.now() + 3600_000).toISOString());
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
  // Within a couple of seconds of an hour, allowing for clock movement between
  // the two Date.now() calls.
  assert.ok(maxAge > 3590 && maxAge <= 3600, `expected ~3600, got ${maxAge}`);
});

test("an already-expired session yields a positive Max-Age rather than a negative one", () => {
  const cookie = setCookie("sess_abc", new Date(Date.now() - 60_000).toISOString());
  const maxAge = Number(cookie.match(/Max-Age=(-?\d+)/)?.[1]);
  // A negative Max-Age would make some clients treat the cookie as a session
  // cookie rather than an expired one; the floor of 1 keeps it unambiguous.
  assert.equal(maxAge, 1);
});

test("an unparseable expiry does not produce Max-Age=NaN", () => {
  const cookie = setCookie("sess_abc", "not a date");
  assert.doesNotMatch(cookie, /Max-Age=NaN/);
  assert.match(cookie, /Max-Age=1\b/);
});

test("the token is url-encoded so a stray character cannot break the header", () => {
  const cookie = setCookie("sess with spaces;and=specials", inAnHour());
  assert.ok(!cookie.includes("sess with spaces"), "raw spaces must not survive");
  // A literal ; would terminate the cookie value and inject an attribute.
  assert.match(cookie, /momi_session=sess%20with%20spaces%3Band%3Dspecials/);
});

test("Secure is set only in production", () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.match(setCookie("sess_abc", inAnHour()), /; Secure/);

    // Local development is plain HTTP, where a Secure cookie would never be sent
    // back and sign-in would appear to silently fail.
    process.env.NODE_ENV = "development";
    assert.doesNotMatch(setCookie("sess_abc", inAnHour()), /Secure/);
    delete process.env.NODE_ENV;
    assert.doesNotMatch(setCookie("sess_abc", inAnHour()), /Secure/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("clearing the cookie expires it immediately and keeps the same attributes", () => {
  const { res, cookie } = fakeResponse();
  clearSessionCookie(res);
  const value = cookie();

  assert.match(value, /^momi_session=;/);
  assert.match(value, /Max-Age=0/);
  // Attributes must match the set call, or the browser keeps the original cookie
  // alongside the cleared one and the user stays signed in.
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Path=\//);
});
