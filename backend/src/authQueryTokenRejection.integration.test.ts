import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";

// The regression this locks down: a session token in ?access_token= used to
// authenticate ANY route. It is a 14-day full-account credential, and putting it
// in a URL leaks it into reverse-proxy access logs, browser history, and Referer
// headers. extractAuthToken must never look at the query string again.

process.env.MEDIA_ACCESS_TOKEN_SECRET = "test-media-secret";

const { extractAuthToken } = await import("./authMiddleware.js");

function fakeRequest(options: { query?: Record<string, string>; headers?: Record<string, string> }): Request {
  const headers = options.headers ?? {};
  return {
    query: options.query ?? {},
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

test("a session token in the query string is ignored", () => {
  const req = fakeRequest({ query: { access_token: "sess_abc123" } });
  assert.equal(extractAuthToken(req), undefined);
});

test("the Authorization header is still read", () => {
  assert.equal(extractAuthToken(fakeRequest({ headers: { authorization: "Bearer sess_abc123" } })), "sess_abc123");
  // Scheme match is case-insensitive, as before.
  assert.equal(extractAuthToken(fakeRequest({ headers: { authorization: "bearer sess_abc123" } })), "sess_abc123");
});

test("the momi_session cookie is still read, and url-decoded", () => {
  assert.equal(extractAuthToken(fakeRequest({ headers: { cookie: "momi_session=sess_abc123" } })), "sess_abc123");
  assert.equal(extractAuthToken(fakeRequest({ headers: { cookie: "other=1; momi_session=sess%2Fabc; another=2" } })), "sess/abc");
});

test("a query token cannot override a header or cookie session", () => {
  const withHeader = fakeRequest({
    query: { access_token: "sess_attacker" },
    headers: { authorization: "Bearer sess_real" },
  });
  assert.equal(extractAuthToken(withHeader), "sess_real");

  const withCookie = fakeRequest({
    query: { access_token: "sess_attacker" },
    headers: { cookie: "momi_session=sess_real" },
  });
  assert.equal(extractAuthToken(withCookie), "sess_real");
});

test("no credential at all yields undefined rather than an empty string", () => {
  assert.equal(extractAuthToken(fakeRequest({})), undefined);
  assert.equal(extractAuthToken(fakeRequest({ headers: { authorization: "" } })), undefined);
  assert.equal(extractAuthToken(fakeRequest({ headers: { cookie: "momi_session=" } })), "");
});
