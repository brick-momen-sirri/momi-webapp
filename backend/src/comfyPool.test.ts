import assert from "node:assert/strict";
import test from "node:test";

import { ComfyServerPool, createComfyPoolActionRunner, runComfyPoolAction } from "./comfyPool.js";

const servers = ["http://127.0.0.1:8211", "http://127.0.0.1:8212"];

test("discovers healthy workers and acquires each idle worker at most once", async () => {
  const pool = new ComfyServerPool(
    servers,
    async () => ({}),
    () => "2026-08-04T12:00:00.000Z",
  );

  assert.deepEqual(
    pool.getServers().map(({ status }) => status),
    ["offline", "offline"],
  );
  assert.equal(await pool.acquireIdleServer(), servers[0]);
  assert.equal(await pool.acquireIdleServer(), servers[1]);
  assert.equal(await pool.acquireIdleServer(), undefined);
  assert.deepEqual(
    pool.getServers().map(({ status }) => status),
    ["busy", "busy"],
  );
});

test("unreachable workers stay offline while healthy workers remain selectable", async () => {
  const pool = new ComfyServerPool(servers, async (url) => {
    if (url === servers[0]) throw new Error("connection refused");
    return {};
  });

  const refreshed = await pool.refreshServers();
  assert.equal(refreshed[0].status, "offline");
  assert.equal(refreshed[0].errorMessage, "connection refused");
  assert.equal(refreshed[1].status, "idle");
  assert.equal(await pool.acquireIdleServer(), servers[1]);
});

test("a failed health check drops stale busy state and the worker can recover", async () => {
  let reachable = true;
  const pool = new ComfyServerPool([servers[0]], async () => {
    if (!reachable) throw new Error("stopped");
    return {};
  });

  assert.equal(await pool.acquireIdleServer(), servers[0]);
  reachable = false;
  assert.equal((await pool.refreshServers())[0].status, "offline");
  reachable = true;
  assert.equal((await pool.refreshServers())[0].status, "idle");
  assert.equal(await pool.acquireIdleServer(), servers[0]);
});

test("release is idempotent and never adds an unknown worker", async () => {
  const pool = new ComfyServerPool([servers[0]], async () => ({}));
  assert.equal(await pool.acquireIdleServer(), servers[0]);

  pool.releaseServer(servers[0]);
  pool.releaseServer(servers[0]);
  pool.releaseServer("http://127.0.0.1:8999");
  pool.releaseServer(undefined);

  assert.deepEqual(
    pool.getServers().map(({ url, status }) => ({ url, status })),
    [{ url: servers[0], status: "idle" }],
  );
});

test("invalid configured worker URLs fail during construction", () => {
  assert.throws(() => new ComfyServerPool(["not a url"], async () => ({})), /invalid url/i);
});

test("pool actions map to the expected scripts, arguments, and timeout budgets", async () => {
  const calls: Array<{ kind: string; script?: string; args?: string[]; timeout?: number }> = [];
  const runAction = createComfyPoolActionRunner({
    requireAllowedPort: (port) => {
      if (port !== 8211) throw new Error("bad port");
    },
    runCheckedPoolScript: async (script, args, timeout) => {
      calls.push({ kind: "checked", script, args, timeout });
      return { exitCode: 0, output: `${script} output`, error: "" };
    },
    launchPoolScript: async (script, args) => {
      calls.push({ kind: "launch", script, args });
    },
    openDesktopManager: async () => {
      calls.push({ kind: "manager" });
    },
  });

  assert.equal((await runAction({ action: "start", port: 8211 })).ok, true);
  assert.equal((await runAction({ action: "stop", port: 8211 })).ok, true);
  assert.equal((await runAction({ action: "restart", port: 8211 })).ok, true);
  await runAction({ action: "start-safe" });
  await runAction({ action: "start-all" });
  await runAction({ action: "stop-all" });
  await runAction({ action: "open-manager" });

  assert.deepEqual(calls, [
    { kind: "checked", script: "Start-ComfyPool.ps1", args: ["-Port", "8211"], timeout: 60_000 },
    { kind: "checked", script: "Stop-ComfyPool.ps1", args: ["-Port", "8211"], timeout: 60_000 },
    { kind: "checked", script: "Stop-ComfyPool.ps1", args: ["-Port", "8211"], timeout: 60_000 },
    { kind: "checked", script: "Start-ComfyPool.ps1", args: ["-Port", "8211"], timeout: 60_000 },
    {
      kind: "launch",
      script: "Start-ComfyPool.ps1",
      args: ["-StartDelaySeconds", "15", "-MaxInstances", "4"],
    },
    { kind: "launch", script: "Start-ComfyPool.ps1", args: ["-StartDelaySeconds", "20"] },
    { kind: "checked", script: "Stop-ComfyPool.ps1", args: [], timeout: 120_000 },
    { kind: "manager" },
  ]);
});

test("action failures are propagated and invalid production ports fail before spawning", async () => {
  const runAction = createComfyPoolActionRunner({
    requireAllowedPort: () => undefined,
    runCheckedPoolScript: async () => {
      throw new Error("script timed out");
    },
    launchPoolScript: async () => undefined,
    openDesktopManager: async () => undefined,
  });
  await assert.rejects(() => runAction({ action: "start", port: 8211 }), /timed out/i);
  await assert.rejects(() => runComfyPoolAction({ action: "start" }), /valid comfy pool port/i);
  await assert.rejects(() => runComfyPoolAction({ action: "stop", port: 8999 }), /not configured/i);
});
