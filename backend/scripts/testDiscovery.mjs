import fs from "node:fs/promises";
import path from "node:path";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/i;
const IGNORED_DIRECTORIES = new Set(["__fixtures__", "fixtures", "helpers", "node_modules", "dist", "coverage"]);

/**
 * Discover backend test entry points without relying on shell glob expansion.
 * Returned paths are absolute and sorted so Windows, Linux, local runs, and CI
 * execute the same files in a deterministic order.
 */
export async function discoverBackendTests(sourceRoot) {
  const tests = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(entryPath);
        continue;
      }
      if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) tests.push(path.resolve(entryPath));
    }
  }

  await visit(path.resolve(sourceRoot));
  return tests.sort((left, right) => left.localeCompare(right));
}

export function isBackendTestFile(fileName) {
  return TEST_FILE_PATTERN.test(fileName);
}
