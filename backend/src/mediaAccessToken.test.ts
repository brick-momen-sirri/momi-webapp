import test from "node:test";
import assert from "node:assert/strict";

process.env.MEDIA_ACCESS_TOKEN_SECRET = "test-media-secret";
process.env.MEDIA_ACCESS_TOKEN_TTL_MS = "60000";

const { createMediaAccessToken, verifyMediaAccessToken, isMediaTokenPath } = await import("./mediaAccessToken.js");

test("a freshly minted token verifies back to the user who owns it", () => {
  const now = 1_000_000;
  const minted = createMediaAccessToken("usr_momen", now);
  assert.deepEqual(verifyMediaAccessToken(minted.token, now + 1), { userId: "usr_momen" });
  assert.equal(minted.expiresAt, new Date(now + 60_000).toISOString());
});

test("a token stops verifying once it expires", () => {
  const now = 1_000_000;
  const minted = createMediaAccessToken("usr_momen", now);
  assert.ok(verifyMediaAccessToken(minted.token, now + 59_999));
  assert.equal(verifyMediaAccessToken(minted.token, now + 60_000), undefined, "expiry is not inclusive");
  assert.equal(verifyMediaAccessToken(minted.token, now + 60_001), undefined);
});

test("the payload cannot be edited without invalidating the signature", () => {
  const minted = createMediaAccessToken("usr_viewer", 1_000_000);
  const [payload, signature] = minted.token.split(".");

  // Re-encode the payload as a different user and keep the original signature.
  const forgedPayload = Buffer.from(JSON.stringify({ v: 1, sub: "usr_admin", exp: 9_999_999_999_999 }), "utf8").toString(
    "base64url",
  );
  assert.equal(verifyMediaAccessToken(`${forgedPayload}.${signature}`, 1_000_001), undefined);

  // Extending the expiry is the same attack and must fail the same way.
  const extended = Buffer.from(JSON.stringify({ v: 1, sub: "usr_viewer", exp: 9_999_999_999_999 }), "utf8").toString("base64url");
  assert.equal(verifyMediaAccessToken(`${extended}.${signature}`, 1_000_001), undefined);

  // Sanity: the untampered token still works, so the assertions above are
  // failing for the right reason.
  assert.ok(verifyMediaAccessToken(`${payload}.${signature}`, 1_000_001));
});

test("malformed tokens are rejected rather than throwing", () => {
  const now = 1_000_000;
  for (const bad of [
    "",
    ".",
    "onlypayload",
    "onlypayload.",
    ".onlysignature",
    "not-base64url!.sig",
    "a.b.c",
    "eyJhIjoxfQ.wrongsignature",
  ]) {
    assert.equal(verifyMediaAccessToken(bad, now), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("a JWT-shaped three-segment token is not accepted", () => {
  // Guards against a future refactor that splits on "." and ignores the tail.
  const minted = createMediaAccessToken("usr_momen", 1_000_000);
  const [payload, signature] = minted.token.split(".");
  assert.equal(verifyMediaAccessToken(`header.${payload}.${signature}`, 1_000_001), undefined);
  assert.equal(verifyMediaAccessToken(`${payload}.${signature}.extra`, 1_000_001), undefined);
});

test("a payload with a missing subject or wrong version is rejected", async () => {
  // These are signed correctly, so only the payload checks can catch them.
  // Signing here mirrors the module's own scheme with the test secret.
  const { createHmac } = await import("node:crypto");
  const signWith = (text: string) => createHmac("sha256", "test-media-secret").update(text).digest("base64url");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

  for (const payload of [
    { v: 1, exp: 9_999_999_999_999 },
    { v: 1, sub: "", exp: 9_999_999_999_999 },
    { v: 2, sub: "usr_momen", exp: 9_999_999_999_999 },
    { v: 1, sub: "usr_momen" },
    { v: 1, sub: "usr_momen", exp: "later" },
  ]) {
    const text = encode(payload);
    assert.equal(
      verifyMediaAccessToken(`${text}.${signWith(text)}`, 1_000_000),
      undefined,
      `expected ${JSON.stringify(payload)} to be rejected`,
    );
  }
});

test("the media token path allowlist covers exactly the binary read routes", () => {
  for (const allowed of [
    "/api/media",
    "/api/media/thumbnail",
    "/api/jobs/job_123/result-file",
    "/api/jobs/job_123/result-media",
  ]) {
    assert.equal(isMediaTokenPath(allowed), true, `expected ${allowed} to accept a media token`);
  }

  for (const denied of [
    "/api/jobs",
    "/api/jobs/job_123",
    "/api/jobs/job_123/status",
    "/api/jobs/job_123/retry",
    "/api/jobs/job_123/result",
    "/api/auth/me",
    "/api/auth/change-password",
    "/api/users",
    "/api/projects",
    "/api/media/upload",
    "/api/media/thumbnail/extra",
    "/api/mediax",
    "/api/jobs/a/b/result-file",
  ]) {
    assert.equal(isMediaTokenPath(denied), false, `expected ${denied} to refuse a media token`);
  }
});
