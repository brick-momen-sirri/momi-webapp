import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverBackendTests } from "./testDiscovery.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(backendRoot, "src");
const tests = await discoverBackendTests(sourceRoot);

if (tests.length < 66) {
  throw new Error(`Backend test discovery found only ${tests.length} files; the established baseline is 66.`);
}

if (process.argv.includes("--list")) {
  for (const testPath of tests) console.log(path.relative(backendRoot, testPath).replaceAll(path.sep, "/"));
  process.exit(0);
}

console.log(`Discovered ${tests.length} backend test files.`);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  cwd: backendRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
