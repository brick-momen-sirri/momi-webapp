import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { archivedItemsStorePath, jobsStorePath } from "./config.js";
import { getProjects } from "./projectService.js";
import { MAX_JSON_METADATA_BYTES } from "./storageService.js";

const embeddedMediaMarkers = ["data:image/", "data:video/", "data:audio/", "data:application/octet-stream"];

export async function assertMetadataHealth() {
  await Promise.all([
    checkSmallTextMetadata(jobsStorePath),
    checkSmallTextMetadata(archivedItemsStorePath),
    ...getProjects().map((project) => checkJsonlMetadata(path.join(project.folderPath, "metadata", "manifest.jsonl"))),
  ]);
}

async function checkSmallTextMetadata(filePath: string) {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat) return;

  if (stat.size > MAX_JSON_METADATA_BYTES) {
    throw new Error(`Metadata file is too large: ${filePath} (${stat.size} bytes)`);
  }

  const text = await fs.readFile(filePath, "utf8");
  if (containsEmbeddedMedia(text)) {
    throw new Error(`Embedded media detected in metadata file: ${filePath}`);
  }
}

async function checkJsonlMetadata(filePath: string) {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat) return;

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (containsEmbeddedMedia(line)) {
      throw new Error(`Embedded media detected in manifest: ${filePath}:${lineNumber}`);
    }
  }
}

function containsEmbeddedMedia(value: string) {
  return embeddedMediaMarkers.some((marker) => value.includes(marker));
}

