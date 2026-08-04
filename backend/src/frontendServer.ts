import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFrontendGateway } from "./frontendGateway.js";
import { createFrontendShutdown, parseFrontendPort } from "./frontendServerLifecycle.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDistPath = path.resolve(process.env.FRONTEND_DIST_PATH?.trim() || path.join(moduleDirectory, "..", "..", "dist"));
const apiTarget = process.env.FRONTEND_API_TARGET?.trim() || "http://127.0.0.1:3333";
const host = process.env.FRONTEND_HOST?.trim() || "0.0.0.0";
const port = parseFrontendPort(process.env.FRONTEND_PORT);

await fs.access(path.join(frontendDistPath, "index.html")).catch(() => {
  throw new Error(`Frontend build not found at ${frontendDistPath}. Run 'pnpm run build' before starting production.`);
});

const app = createFrontendGateway({ frontendDistPath, apiTarget });
const server = app.listen(port, host, () => {
  console.log(`Momi production frontend listening on http://${host}:${port}`);
  console.log(`Serving ${frontendDistPath}; proxying /api to ${apiTarget}`);
});

server.on("error", (error) => {
  console.error("Momi production frontend failed:", error);
  process.exitCode = 1;
});

const shutdown = createFrontendShutdown(server);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      console.error("Momi production frontend shutdown failed:", error);
    });
  });
}
