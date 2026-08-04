import type http from "node:http";

export type FrontendShutdownOptions = {
  timeoutMs?: number;
  log?: (message: string) => void;
  forceExit?: (code: number) => void;
  setExitCode?: (code: number) => void;
};

export function parseFrontendPort(value: string | undefined, fallback = 8190) {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`FRONTEND_PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

export function createFrontendShutdown(server: http.Server, options: FrontendShutdownOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log ?? ((message: string) => console.log(message));
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const setExitCode = options.setExitCode ?? ((code: number) => (process.exitCode = code));
  let shutdownPromise: Promise<void> | undefined;

  return (signal = "shutdown") => {
    if (shutdownPromise) return shutdownPromise;

    log(`Momi production frontend received ${signal}; draining connections.`);
    shutdownPromise = new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        server.closeAllConnections?.();
        setExitCode(1);
        const error = new Error(`Production frontend did not close within ${timeoutMs}ms.`);
        reject(error);
        forceExit(1);
      }, timeoutMs);
      timer.unref?.();

      server.close((error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          setExitCode(1);
          reject(error);
          return;
        }
        setExitCode(0);
        log("Momi production frontend stopped cleanly.");
        resolve();
      });
      server.closeIdleConnections?.();
    });
    return shutdownPromise;
  };
}
