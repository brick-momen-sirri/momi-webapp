import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { createFrontendShutdown, parseFrontendPort } from "./frontendServerLifecycle.js";

test("frontend shutdown closes the listener cleanly and is idempotent", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await listen(server);
  const address = server.address();
  assert(address && typeof address !== "string");
  assert.equal(await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.text()), "ok");

  const shutdown = createFrontendShutdown(server, {
    timeoutMs: 1_000,
    log: () => undefined,
    forceExit: () => assert.fail("clean shutdown must not force exit"),
    setExitCode: (code) => assert.equal(code, 0),
  });
  const first = shutdown("test");
  const second = shutdown("duplicate");

  assert.equal(first, second);
  await first;
  assert.equal(server.listening, false);
});

test("frontend shutdown has a bounded forced-close path for stuck connections", async () => {
  const server = http.createServer();
  await listen(server);
  const address = server.address();
  assert(address && typeof address !== "string");
  const socket = net.connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));

  let forcedCode: number | undefined;
  let exitCode: number | undefined;
  const shutdown = createFrontendShutdown(server, {
    timeoutMs: 25,
    log: () => undefined,
    forceExit: (code) => {
      forcedCode = code;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  await assert.rejects(shutdown("test-timeout"), /did not close within 25ms/);
  assert.equal(forcedCode, 1);
  assert.equal(exitCode, 1);
  socket.destroy();
});

test("frontend port parsing defaults only when unset and rejects invalid explicit values", () => {
  assert.equal(parseFrontendPort(undefined), 8190);
  assert.equal(parseFrontendPort(" 8192 "), 8192);
  assert.throws(() => parseFrontendPort("0"), /FRONTEND_PORT/);
  assert.throws(() => parseFrontendPort("not-a-port"), /FRONTEND_PORT/);
  assert.throws(() => parseFrontendPort("65536"), /FRONTEND_PORT/);
});

function listen(server: http.Server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}
