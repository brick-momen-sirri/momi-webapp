import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(backendDirectory, "..");
const frontendDistPath = path.join(repositoryDirectory, "dist");
const frontendEntryPath = path.join(backendDirectory, "dist", "frontendServer.js");

await fs.access(path.join(frontendDistPath, "index.html"));
await fs.access(frontendEntryPath);

const apiRequests = [];
const apiServer = http.createServer((req, res) => {
  apiRequests.push(req.url);
  if (req.url === "/api/media/smoke") {
    res.statusCode = 206;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Range", "bytes 0-15/1024");
    res.end(Buffer.alloc(16, 5));
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, path: req.url, cookie: req.headers.cookie ?? "" }));
});
await listen(apiServer);
const apiAddress = apiServer.address();
assert(apiAddress && typeof apiAddress !== "string");

const gatewayPort = await availablePort();
const entryUrl = pathToFileURL(frontendEntryPath).href;
const wrapper = `
  await import(${JSON.stringify(entryUrl)});
  process.on("message", (message) => {
    if (message === "shutdown") {
      process.emit("SIGTERM");
      process.disconnect();
    }
  });
`;
const child = spawn(process.execPath, ["--input-type=module", "--eval", wrapper], {
  cwd: backendDirectory,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    FRONTEND_HOST: "127.0.0.1",
    FRONTEND_PORT: String(gatewayPort),
    FRONTEND_DIST_PATH: frontendDistPath,
    FRONTEND_API_TARGET: `http://127.0.0.1:${apiAddress.port}`,
  },
});
let stdout = "";
let stderr = "";
child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

try {
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  await waitForHealth(baseUrl, child);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");

  const index = await fetch(`${baseUrl}/index.html`);
  const indexText = await index.text();
  assert.match(index.headers.get("cache-control") ?? "", /no-cache/);
  assert.match(indexText, /id="root"/);
  const assetPath = indexText.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
  assert(assetPath, "built index must reference a hashed JS or CSS asset");

  const asset = await fetch(`${baseUrl}${assetPath}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /max-age=31536000/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(asset.headers.get("content-encoding"), "gzip");

  const deepRoute = await fetch(`${baseUrl}/projects/gateway-smoke`, { headers: { Accept: "text/html" } });
  assert.equal(deepRoute.status, 200);
  assert.match(await deepRoute.text(), /id="root"/);

  const missingAsset = await fetch(`${baseUrl}/assets/missing-deadbeef.js`, { headers: { Accept: "text/html" } });
  assert.equal(missingAsset.status, 404);

  const api = await fetch(`${baseUrl}/api/smoke?built=1`, { headers: { Cookie: "momi_session=local-smoke" } });
  assert.deepEqual(await api.json(), {
    ok: true,
    path: "/api/smoke?built=1",
    cookie: "momi_session=local-smoke",
  });

  const media = await fetch(`${baseUrl}/api/media/smoke`, { headers: { Range: "bytes=0-15" } });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 16);

  const proxiedBeforeBlock = apiRequests.length;
  const blocked = await fetch(`${baseUrl}/api/health`);
  assert.equal(blocked.status, 404);
  assert.equal(apiRequests.length, proxiedBeforeBlock);

  child.send?.("shutdown");
  const exit = await waitForExit(child, 5_000);
  assert.equal(exit.code, 0, `gateway exited unexpectedly: ${stderr}`);
  assert.match(stdout, /stopped cleanly/);

  console.log(
    JSON.stringify({
      ok: true,
      gatewayUrl: baseUrl,
      assetPath,
      checks: [
        "health",
        "index-cache",
        "hashed-cache",
        "gzip",
        "spa-fallback",
        "missing-asset",
        "api-cookie-proxy",
        "media-range",
        "ops-block",
        "graceful-shutdown",
      ],
    }),
  );
} finally {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill();
    await waitForExit(child, 2_000).catch(() => undefined);
  }
  await closeServer(apiServer);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function availablePort() {
  const server = http.createServer();
  await listen(server);
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await closeServer(server);
  return port;
}

async function waitForHealth(baseUrl, childProcess) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (childProcess.exitCode != null) {
      throw new Error(`Gateway exited before becoming ready (code ${childProcess.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Gateway did not become healthy within 5 seconds.");
}

function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode != null || childProcess.signalCode != null) {
    return Promise.resolve({ code: childProcess.exitCode, signal: childProcess.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway did not exit within ${timeoutMs}ms.`)), timeoutMs);
    childProcess.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
