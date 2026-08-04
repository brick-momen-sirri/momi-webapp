import assert from "node:assert/strict";
import test from "node:test";

// The guards themselves are unit-tested in opsAccessGuard.test.ts and
// corsOrigin.test.ts against explicit inputs. This covers the seam those cannot:
// that the env vars actually reach the policy objects, and that a combination
// which would silently make the ops surface unreachable fails at startup rather
// than after a deploy.

process.env.OPS_ACCESS_TOKEN = "  token-with-padding  ";
process.env.OPS_ALLOW_LOOPBACK = "false";
process.env.CORS_ALLOWED_ORIGINS = " https://momi.brickvisual.com , ,https://ops.brickvisual.com ";
process.env.CORS_ALLOW_PRIVATE_ORIGINS = "off";
process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS = "4";
process.env.LOGIN_RATE_LIMIT_WINDOW_MS = "60000";

const config = await import("./config.js");
const { decideOpsAccess } = await import("./opsAccessGuard.js");
const { isOriginAllowed } = await import("./corsOrigin.js");

test("the ops token is trimmed and the loopback bypass can be closed by env", () => {
  assert.equal(config.opsAccessToken, "token-with-padding");
  assert.equal(config.opsAllowLoopback, false);

  const guard = { configuredToken: config.opsAccessToken, allowLoopback: config.opsAllowLoopback };
  assert.equal(decideOpsAccess({ ...guard, remoteAddress: "127.0.0.1" }).allowed, false);
  assert.equal(decideOpsAccess({ ...guard, remoteAddress: "127.0.0.1", presentedToken: "token-with-padding" }).allowed, true);
});

test("the CORS allowlist is parsed into exact origins with blanks dropped", () => {
  assert.deepEqual(config.corsAllowedOrigins, ["https://momi.brickvisual.com", "https://ops.brickvisual.com"]);
  assert.equal(config.corsAllowPrivateOrigins, false);

  const policy = { allowedOrigins: config.corsAllowedOrigins, allowPrivateOrigins: config.corsAllowPrivateOrigins };
  assert.equal(isOriginAllowed("https://ops.brickvisual.com", policy), true);
  assert.equal(isOriginAllowed("https://evil.example.com", policy), false);
  // Private origins are off in this configuration.
  assert.equal(isOriginAllowed("http://localhost:8190", policy), false);
});

test("login throttle values come from env with sane fallbacks", () => {
  assert.equal(config.loginRateLimitMaxAttempts, 4);
  assert.equal(config.loginRateLimitWindowMs, 60_000);
  // Not set above, so it falls back to the 15 minute default.
  assert.equal(config.loginRateLimitLockoutMs, 15 * 60 * 1000);
});

test("this configuration is coherent, so startup does not reject it", () => {
  // A token is set, so closing the loopback bypass is a valid hardened posture.
  // The unreachable combination is covered in
  // opsAccessUnreachable.integration.test.ts, which needs its own env preamble.
  assert.doesNotThrow(() => config.validateRuntimeConfigForStartup());
});
