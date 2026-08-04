import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFrontendGateway } from "./frontendGateway.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDistPath = path.resolve(process.env.FRONTEND_DIST_PATH?.trim() || path.join(moduleDirectory, "..", "..", "dist"));
const apiTarget = process.env.FRONTEND_API_TARGET?.trim() || "http://127.0.0.1:3333";
const host = process.env.FRONTEND_HOST?.trim() || "0.0.0.0";
const port = positivePort(process.env.FRONTEND_PORT, 8190);

await fs.access(path.join(frontendDistPath, "index.html")).catch(() => {
  throw new Error(`Frontend build not found at ${frontendDistPath}. Run 'pnpm run build' before starting production.`);
});

const app = createFrontendGateway({ frontendDistPath, apiTarget });
app.listen(port, host, () => {
  console.log(`Momi production frontend listening on http://${host}:${port}`);
  console.log(`Serving ${frontendDistPath}; proxying /api to ${apiTarget}`);
});

function positivePort(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}
