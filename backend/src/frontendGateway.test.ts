import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFrontendGateway } from "./frontendGateway.js";

test("production gateway serves hashed assets, SPA routes, and security/cache headers", async () => {
  const fixture = await gatewayFixture();
  try {
    const asset = await fetch(`${fixture.gatewayUrl}/assets/index-AbCd1234.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /max-age=31536000/);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    assert.match(asset.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    const spa = await fetch(`${fixture.gatewayUrl}/projects/example`, { headers: { Accept: "text/html" } });
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), "<html><body>Momi production shell</body></html>");
    assert.match(spa.headers.get("cache-control") ?? "", /no-cache/);

    const health = await fetch(`${fixture.gatewayUrl}/healthz`);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get("cache-control"), "no-store");
  } finally {
    await fixture.close();
  }
});

test("production gateway proxies application APIs and blocks operational endpoints", async () => {
  const fixture = await gatewayFixture();
  try {
    const jobs = await fetch(`${fixture.gatewayUrl}/api/jobs?limit=30`);
    assert.equal(jobs.status, 200);
    assert.deepEqual(await jobs.json(), { path: "/api/jobs?limit=30" });
    assert.equal(fixture.apiRequests(), 1);

    const blocked = await fetch(`${fixture.gatewayUrl}/api/health`);
    assert.equal(blocked.status, 404);
    assert.equal(fixture.apiRequests(), 1, "blocked ops request must never reach the loopback API");
  } finally {
    await fixture.close();
  }
});

async function gatewayFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "momi-frontend-gateway-"));
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "index.html"), "<html><body>Momi production shell</body></html>");
  await fs.writeFile(path.join(directory, "assets", "index-AbCd1234.js"), "export const ready = true;".repeat(100));

  let requests = 0;
  const apiServer = http.createServer((req, res) => {
    requests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  await listen(apiServer);
  const apiAddress = apiServer.address();
  assert(apiAddress && typeof apiAddress !== "string");

  const app = createFrontendGateway({ frontendDistPath: directory, apiTarget: `http://127.0.0.1:${apiAddress.port}` });
  const gatewayServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => gatewayServer.once("listening", resolve));
  const gatewayAddress = gatewayServer.address();
  assert(gatewayAddress && typeof gatewayAddress !== "string");

  return {
    gatewayUrl: `http://127.0.0.1:${gatewayAddress.port}`,
    apiRequests: () => requests,
    async close() {
      await Promise.all([closeServer(gatewayServer), closeServer(apiServer)]);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

function listen(server: http.Server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
