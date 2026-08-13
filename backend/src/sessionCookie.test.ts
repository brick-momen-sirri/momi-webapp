import test from "node:test";
import assert from "node:assert/strict";
import type express from "express";

import { clearSessionCookie, setMediaAccessCookie, setSessionCookie } from "./sessionCookie.js";

// Small module, but every attribute on these cookies is a security decision. The
// flags are asserted individually so that dropping one is a test failure rather
// than a silent downgrade.

// Collects appended cookies rather than replacing, mirroring express's own
// append. A fake that only kept the last value would hide the exact bug this
// module has to avoid: a response issuing both cookies dropping one of them.
function fakeResponse() {
  const cookies: string[] = [];
  return {
    res: { append: (name: string, value: string) => cookies.push(`${name.toLowerCase()}:${value}`) } as unknown as express.Response,
    cookie: (name = "momi_session") => cookies.find((value) => value.includes(`${name}=`))?.split(":").slice(1).join(":") ?? "",
    count: () => cookies.length,
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

test("clearing expires both cookies immediately, keeping the same attributes", () => {
  const { res, cookie, count } = fakeResponse();
  clearSessionCookie(res);

  const session = cookie("momi_session");
  assert.match(session, /^momi_session=;/);
  assert.match(session, /Max-Age=0/);
  // Attributes must match the set call, or the browser keeps the original cookie
  // alongside the cleared one and the user stays signed in.
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Path=\//);

  // Leaving the media cookie behind would leave a usable media credential on a
  // machine whose session has just been invalidated.
  const media = cookie("momi_media");
  assert.match(media, /^momi_media=;/);
  assert.match(media, /Max-Age=0/);
  assert.equal(count(), 2);
});

test("the media cookie is readable by scripts, unlike the session cookie", () => {
  const { res, cookie } = fakeResponse();
  setMediaAccessCookie(res, "mt_abc", inAnHour());
  const value = cookie("momi_media");

  assert.match(value, /^momi_media=mt_abc/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Path=\//);
  // Deliberately not HttpOnly: the frontend has to confirm the cookie exists
  // before it stops putting the token in media URLs, and guessing wrong would
  // turn every image on the page into a 401. See setMediaAccessCookie.
  assert.doesNotMatch(value, /HttpOnly/);
});

test("issuing both cookies on one response keeps both", () => {
  const { res, cookie, count } = fakeResponse();
  setSessionCookie(res, "sess_abc", inAnHour());
  setMediaAccessCookie(res, "mt_abc", inAnHour());

  // The login response sets both. Using setHeader for these would make the
  // second call silently discard the first, signing the user out or breaking
  // every image depending on the order.
  assert.equal(count(), 2);
  assert.match(cookie("momi_session"), /^momi_session=sess_abc/);
  assert.match(cookie("momi_media"), /^momi_media=mt_abc/);
});
