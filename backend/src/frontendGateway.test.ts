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
    assert.equal(asset.headers.get("content-encoding"), "gzip");

    const directIndex = await fetch(`${fixture.gatewayUrl}/index.html`);
    assert.match(directIndex.headers.get("cache-control") ?? "", /no-cache/);

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

test("production gateway does not turn missing static assets into SPA responses", async () => {
  const fixture = await gatewayFixture();
  try {
    const asset = await fetch(`${fixture.gatewayUrl}/assets/missing-deadbeef.js`, {
      headers: { Accept: "text/html,*/*" },
    });
    assert.equal(asset.status, 404);
    assert.deepEqual(await asset.json(), { error: "Not found." });

    const icon = await fetch(`${fixture.gatewayUrl}/favicon.ico`, { headers: { Accept: "text/html" } });
    assert.equal(icon.status, 404);
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

test("production gateway preserves request bodies, cookies, CORS, and media ranges", async () => {
  const fixture = await gatewayFixture();
  try {
    const echo = await fetch(`${fixture.gatewayUrl}/api/echo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "momi_session=session-in",
        Origin: "http://127.0.0.1:8190",
      },
      body: JSON.stringify({ prompt: "local smoke" }),
    });
    assert.equal(echo.status, 201);
    assert.equal(echo.headers.get("access-control-allow-origin"), "http://127.0.0.1:8190");
    assert.match(echo.headers.get("set-cookie") ?? "", /momi_session=session-out/);
    assert.deepEqual(await echo.json(), {
      method: "POST",
      body: '{"prompt":"local smoke"}',
      cookie: "momi_session=session-in",
      origin: "http://127.0.0.1:8190",
      forwardedHost: new URL(fixture.gatewayUrl).host,
      forwardedProto: "http",
    });

    const media = await fetch(`${fixture.gatewayUrl}/api/media/large`, { headers: { Range: "bytes=1024-2047" } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("accept-ranges"), "bytes");
    assert.equal(media.headers.get("content-range"), "bytes 1024-2047/2097152");
    assert.equal((await media.arrayBuffer()).byteLength, 1024);
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
    if (req.url === "/api/media/large") {
      res.statusCode = 206;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", "bytes 1024-2047/2097152");
      res.setHeader("Content-Length", "1024");
      res.end(Buffer.alloc(1024, 7));
      return;
    }
    if (req.url === "/api/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Set-Cookie", "momi_session=session-out; HttpOnly; SameSite=Lax");
        res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin ?? ""));
        res.end(
          JSON.stringify({
            method: req.method,
            body: Buffer.concat(chunks).toString("utf8"),
            cookie: req.headers.cookie,
            origin: req.headers.origin,
            forwardedHost: req.headers["x-forwarded-host"],
            forwardedProto: req.headers["x-forwarded-proto"],
          }),
        );
      });
      return;
    }
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
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
