import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { comfyPoolRoot, comfyServers } from "./config.js";
import { getSystemStats } from "./comfyClient.js";
import { isPathWithinRoot } from "./pathContainment.js";
import type { ComfyServerStatus } from "./types.js";

export type ServerRecord = {
  url: string;
  port: number;
  status: ComfyServerStatus;
  lastChecked?: string;
  errorMessage?: string;
};

type HealthCheck = (url: string) => Promise<unknown>;

/** Deterministic process-local worker selection; provider I/O is injected for tests. */
export class ComfyServerPool {
  private readonly busy = new Set<string>();
  private cache: ServerRecord[];

  constructor(
    private readonly serverUrls: string[],
    private readonly healthCheck: HealthCheck = getSystemStats,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.cache = serverUrls.map((url) => ({ url, port: portFromUrl(url), status: "offline" }));
  }

  async refreshServers() {
    this.cache = await Promise.all(
      this.serverUrls.map(async (url) => {
        try {
          await this.healthCheck(url);
          return {
            url,
            port: portFromUrl(url),
            status: this.busy.has(url) ? "busy" : "idle",
            lastChecked: this.now(),
          } satisfies ServerRecord;
        } catch (error) {
          this.busy.delete(url);
          return {
            url,
            port: portFromUrl(url),
            status: "offline",
            lastChecked: this.now(),
            errorMessage: error instanceof Error ? error.message : "Unknown health check error",
          } satisfies ServerRecord;
        }
      }),
    );
    return this.getServers();
  }

  getServers() {
    return this.cache.map((server) => ({ ...server, status: this.busy.has(server.url) ? "busy" : server.status }));
  }

  async acquireIdleServer() {
    const servers = await this.refreshServers();
    const idle = servers.find((server) => server.status === "idle" && !this.busy.has(server.url));
    if (!idle) return undefined;
    this.busy.add(idle.url);
    this.cache = this.cache.map((server) => (server.url === idle.url ? { ...server, status: "busy" } : server));
    return idle.url;
  }

  releaseServer(url?: string) {
    if (!url || !this.cache.some((server) => server.url === url)) return;
    this.busy.delete(url);
    this.cache = this.cache.map((server) => (server.url === url ? { ...server, status: "idle" } : server));
  }
}

const defaultServerPool = new ComfyServerPool(comfyServers);

export const refreshServers = () => defaultServerPool.refreshServers();
export const getServers = () => defaultServerPool.getServers();
export const acquireIdleServer = () => defaultServerPool.acquireIdleServer();
export const releaseServer = (url?: string) => defaultServerPool.releaseServer(url);

export type ComfyPoolAction = "start" | "stop" | "restart" | "start-safe" | "start-all" | "stop-all" | "open-manager";

type RunComfyPoolActionInput = {
  action: ComfyPoolAction;
  port?: number;
};

type ComfyPoolActionDependencies = {
  requireAllowedPort: (port: number | undefined) => void;
  runCheckedPoolScript: (scriptName: string, args: string[], timeoutMs: number) => Promise<PoolScriptResult>;
  launchPoolScript: (scriptName: string, args: string[]) => Promise<void>;
  openDesktopManager: () => Promise<void>;
};

const defaultActionDependencies: ComfyPoolActionDependencies = {
  requireAllowedPort,
  runCheckedPoolScript,
  launchPoolScript,
  openDesktopManager,
};

export function createComfyPoolActionRunner(dependencies: ComfyPoolActionDependencies) {
  return (input: RunComfyPoolActionInput) => runComfyPoolAction(input, dependencies);
}

export async function runComfyPoolAction(
  { action, port }: RunComfyPoolActionInput,
  dependencies: ComfyPoolActionDependencies = defaultActionDependencies,
) {
  switch (action) {
    case "start":
      dependencies.requireAllowedPort(port);
      return actionResult(
        action,
        port,
        `Start finished for ${port}. Waiting for ComfyUI to become reachable.`,
        await dependencies.runCheckedPoolScript("Start-ComfyPool.ps1", ["-Port", String(port)], 60000),
      );
    case "stop":
      dependencies.requireAllowedPort(port);
      return actionResult(
        action,
        port,
        `Stop finished for ${port}.`,
        await dependencies.runCheckedPoolScript("Stop-ComfyPool.ps1", ["-Port", String(port)], 60000),
      );
    // Braced so these two consts are scoped to this case rather than leaking
    // into the sibling cases in the same switch block.
    case "restart": {
      dependencies.requireAllowedPort(port);
      const stopResult = await dependencies.runCheckedPoolScript("Stop-ComfyPool.ps1", ["-Port", String(port)], 60000);
      const startResult = await dependencies.runCheckedPoolScript("Start-ComfyPool.ps1", ["-Port", String(port)], 60000);
      return actionResult(action, port, `Restart finished for ${port}. Waiting for ComfyUI to become reachable.`, {
        exitCode: 0,
        output: [stopResult.output, startResult.output].filter(Boolean).join("\n"),
        error: [stopResult.error, startResult.error].filter(Boolean).join("\n"),
      });
    }
    case "start-safe":
      await dependencies.launchPoolScript("Start-ComfyPool.ps1", ["-StartDelaySeconds", "15", "-MaxInstances", "4"]);
      return actionResult(action, undefined, "Start 4 launched in the background.");
    case "start-all":
      await dependencies.launchPoolScript("Start-ComfyPool.ps1", ["-StartDelaySeconds", "20"]);
      return actionResult(action, undefined, "Start all launched in the background. It can take several minutes.");
    case "stop-all":
      return actionResult(
        action,
        undefined,
        "Stop all finished.",
        await dependencies.runCheckedPoolScript("Stop-ComfyPool.ps1", [], 120000),
      );
    case "open-manager":
      await dependencies.openDesktopManager();
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

function actionResult(
  action: ComfyPoolAction,
  port?: number,
  message = "Comfy pool command finished.",
  result?: PoolScriptResult,
) {
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

  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], {
    cwd: comfyPoolRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
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
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], {
      cwd: comfyPoolRoot,
      windowsHide: true,
    });

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
  if (!isPathWithinRoot(filePath, comfyPoolRoot)) {
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
