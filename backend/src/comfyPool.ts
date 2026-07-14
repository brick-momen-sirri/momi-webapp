import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { comfyPoolRoot, comfyServers } from "./config.js";
import { getSystemStats } from "./comfyClient.js";
import type { ComfyServerStatus } from "./types.js";

type ServerRecord = {
  url: string;
  port: number;
  status: ComfyServerStatus;
  lastChecked?: string;
  errorMessage?: string;
};

const busy = new Set<string>();
let cache: ServerRecord[] = comfyServers.map((url) => ({ url, port: portFromUrl(url), status: "offline" }));

export async function refreshServers() {
  cache = await Promise.all(
    comfyServers.map(async (url) => {
      try {
        await getSystemStats(url);
        return {
          url,
          port: portFromUrl(url),
          status: busy.has(url) ? "busy" : "idle",
          lastChecked: new Date().toISOString(),
        } satisfies ServerRecord;
      } catch (error) {
        busy.delete(url);
        return {
          url,
          port: portFromUrl(url),
          status: "offline",
          lastChecked: new Date().toISOString(),
          errorMessage: error instanceof Error ? error.message : "Unknown health check error",
        } satisfies ServerRecord;
      }
    }),
  );
  return cache;
}

export function getServers() {
  return cache.map((server) => ({ ...server, status: busy.has(server.url) ? "busy" : server.status }));
}

export async function acquireIdleServer() {
  const servers = await refreshServers();
  const idle = servers.find((server) => server.status === "idle" && !busy.has(server.url));
  if (!idle) {
    return undefined;
  }
  busy.add(idle.url);
  cache = cache.map((server) => (server.url === idle.url ? { ...server, status: "busy" } : server));
  return idle.url;
}

export function releaseServer(url?: string) {
  if (!url) {
    return;
  }
  busy.delete(url);
  cache = cache.map((server) => (server.url === url ? { ...server, status: "idle" } : server));
}

export type ComfyPoolAction =
  | "start"
  | "stop"
  | "restart"
  | "start-safe"
  | "start-all"
  | "stop-all"
  | "open-manager";

type RunComfyPoolActionInput = {
  action: ComfyPoolAction;
  port?: number;
};

export async function runComfyPoolAction({ action, port }: RunComfyPoolActionInput) {
  switch (action) {
    case "start":
      requireAllowedPort(port);
      return actionResult(
        action,
        port,
        `Start finished for ${port}. Waiting for ComfyUI to become reachable.`,
        await runCheckedPoolScript("Start-ComfyPool.ps1", ["-Port", String(port)], 60000),
      );
    case "stop":
      requireAllowedPort(port);
      return actionResult(
        action,
        port,
        `Stop finished for ${port}.`,
        await runCheckedPoolScript("Stop-ComfyPool.ps1", ["-Port", String(port)], 60000),
      );
    case "restart":
      requireAllowedPort(port);
      const stopResult = await runCheckedPoolScript("Stop-ComfyPool.ps1", ["-Port", String(port)], 60000);
      const startResult = await runCheckedPoolScript("Start-ComfyPool.ps1", ["-Port", String(port)], 60000);
      return actionResult(action, port, `Restart finished for ${port}. Waiting for ComfyUI to become reachable.`, {
        exitCode: 0,
        output: [stopResult.output, startResult.output].filter(Boolean).join("\n"),
        error: [stopResult.error, startResult.error].filter(Boolean).join("\n"),
      });
    case "start-safe":
      await launchPoolScript("Start-ComfyPool.ps1", ["-StartDelaySeconds", "15", "-MaxInstances", "4"]);
      return actionResult(action, undefined, "Start 4 launched in the background.");
    case "start-all":
      await launchPoolScript("Start-ComfyPool.ps1", ["-StartDelaySeconds", "20"]);
      return actionResult(action, undefined, "Start all launched in the background. It can take several minutes.");
    case "stop-all":
      return actionResult(
        action,
        undefined,
        "Stop all finished.",
        await runCheckedPoolScript("Stop-ComfyPool.ps1", [], 120000),
      );
    case "open-manager":
      await openDesktopManager();
      return actionResult(action, undefined, "Desktop manager opened.");
    default:
      throw new Error("Unsupported Comfy pool action.");
  }
}

type PoolScriptResult = {
  exitCode: number;
  output: string;
  error: string;
};

function actionResult(action: ComfyPoolAction, port?: number, message = "Comfy pool command finished.", result?: PoolScriptResult) {
  return {
    ok: true,
    action,
    port,
    message,
    output: result?.output,
    errorOutput: result?.error,
    startedAt: new Date().toISOString(),
  };
}

async function launchPoolScript(scriptName: string, args: string[]) {
  const scriptPath = path.join(comfyPoolRoot, scriptName);
  await assertInsidePoolRoot(scriptPath);
  await assertFileExists(scriptPath);

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      cwd: comfyPoolRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

async function runCheckedPoolScript(scriptName: string, args: string[], timeoutMs: number) {
  const result = await runPoolScript(scriptName, args, timeoutMs);
  if (result.exitCode !== 0) {
    const detail = [result.error, result.output].filter(Boolean).join("\n").trim();
    throw new Error(`${scriptName} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

async function runPoolScript(scriptName: string, args: string[], timeoutMs: number) {
  const scriptPath = path.join(comfyPoolRoot, scriptName);
  await assertInsidePoolRoot(scriptPath);
  await assertFileExists(scriptPath);

  return new Promise<PoolScriptResult>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      {
        cwd: comfyPoolRoot,
        windowsHide: true,
      },
    );

    let output = "";
    let error = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${scriptName} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      error += String(chunk);
    });
    child.on("error", (spawnError) => {
      clearTimeout(timeout);
      reject(spawnError);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode: exitCode ?? -1,
        output: output.trim(),
        error: error.trim(),
      });
    });
  });
}

async function openDesktopManager() {
  const managerPath = path.join(comfyPoolRoot, "Open-ComfyPoolManager.bat");
  await assertInsidePoolRoot(managerPath);
  await assertFileExists(managerPath);

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Process -FilePath $args[0]", managerPath],
    {
      cwd: comfyPoolRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

function requireAllowedPort(port: number | undefined): asserts port is number {
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error("A valid Comfy pool port is required.");
  }

  const allowedPorts = new Set(comfyServers.map(portFromUrl));
  if (!allowedPorts.has(port)) {
    throw new Error(`Port ${port} is not configured for this Comfy pool.`);
  }
}

function portFromUrl(url: string) {
  const parsed = new URL(url);
  return Number(parsed.port);
}

async function assertInsidePoolRoot(filePath: string) {
  const root = path.resolve(comfyPoolRoot).toLowerCase();
  const resolved = path.resolve(filePath).toLowerCase();
  if (!resolved.startsWith(root)) {
    throw new Error("Comfy pool script path is outside the configured pool root.");
  }
}

async function assertFileExists(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing Comfy pool file: ${filePath}`);
  }
}
