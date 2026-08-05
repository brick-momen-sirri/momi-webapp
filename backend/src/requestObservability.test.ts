import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import { createRequestObservability, getHttpRequestMetricsSnapshot, resolveRequestId } from "./requestObservability.js";

test("preserves a safe incoming request id and replaces malformed values", () => {
  assert.equal(resolveRequestId("req_trace_123456"), "req_trace_123456");
  assert.match(resolveRequestId("bad value with spaces"), /^[0-9a-f-]{36}$/);
});

test("echoes request ids, emits structured completion logs, and records SLO metrics", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const before = getHttpRequestMetricsSnapshot();
  const app = express();
  app.use(createRequestObservability((entry) => entries.push(entry)));
  app.get("/api/trace", (_req, res) => res.status(503).json({ error: "Unavailable" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/trace?secret=not-logged`, {
      headers: { "X-Request-ID": "req_observe_123456" },
    });
    assert.equal(response.headers.get("x-request-id"), "req_observe_123456");
    await response.arrayBuffer();

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      event: "http_request",
      request_id: "req_observe_123456",
      method: "GET",
      path: "/api/trace",
      status: 503,
      duration_ms: entries[0].duration_ms,
    });
    assert.equal(typeof entries[0].duration_ms, "number");

    const after = getHttpRequestMetricsSnapshot();
    assert.equal(after.inFlight, before.inFlight);
    assert.equal(after.total, before.total + 1);
    assert.equal(after.byStatusClass["5xx"], before.byStatusClass["5xx"] + 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
    });
  }
});
