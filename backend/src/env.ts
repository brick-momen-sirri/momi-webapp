import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const workspaceRoot = path.resolve(backendRoot, "..");

const envFiles = [
  path.join(workspaceRoot, ".env"),
  path.join(workspaceRoot, ".env.local"),
  path.join(backendRoot, ".env"),
  path.join(backendRoot, ".env.local"),
];

for (const filePath of envFiles) {
  loadEnvFile(filePath);
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || parsed.key in process.env) continue;
    process.env[parsed.key] = parsed.value;
  }
}

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex <= 0) return undefined;

  const key = trimmed.slice(0, equalsIndex).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return undefined;

  const value = unquoteEnvValue(trimmed.slice(equalsIndex + 1).trim());
  return { key, value };
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }

  const commentIndex = value.search(/\s+#/);
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}
