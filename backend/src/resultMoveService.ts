import fs from "node:fs/promises";
import path from "node:path";
import { folderDisplayName } from "./projectMetadataService.js";
import type { Job, Project, ProjectFolder } from "./types.js";

export type ResultFileMove = {
  from: string;
  to: string;
  fromRelativePath: string;
  toRelativePath: string;
};

export type MoveResultFilesResult = {
  job: Job;
  fileMoves: ResultFileMove[];
  rollback: () => Promise<void>;
};

type MoveResultFilesInput = {
  project: Project;
  job: Job;
  destinationFolderId: string | null;
  folders: ProjectFolder[];
};

const LOCAL_MEDIA_PATH = "/api/media";
const MOVABLE_OUTPUT_FOLDERS = new Set(["images", "videos", "sequences"]);

/**
 * Reassigns a completed job to another project folder. Project output media is
 * renamed in place (never copied), while job-scoped or remote references stay
 * where they are and retain their URLs.
 */
export async function moveResultFiles({
  project,
  job,
  destinationFolderId,
  folders,
}: MoveResultFilesInput): Promise<MoveResultFilesResult> {
  if (job.projectId !== project.id) {
    throw new Error("Result does not belong to this project.");
  }
  if (job.status !== "completed") {
    throw new Error("Only completed results can be moved.");
  }
  if (job.archivedAt) {
    throw new Error("Restore this result before moving it.");
  }
  if (job.folderId === destinationFolderId) {
    throw new Error("Result is already in that folder.");
  }
  if (!job.resultUrls.length && !job.thumbnailUrls.length) {
    throw new Error("Result has no file references to move.");
  }

  const destinationFolder = destinationFolderId
    ? folders.find((folder) => folder.folderId === destinationFolderId && !folder.archived)
    : undefined;
  if (destinationFolderId && !destinationFolder) {
    throw new Error("Destination folder not found.");
  }

  const sourceOutputRoot = outputRootFor(project, job.folderId, folders, "Source");
  const destinationOutputRoot = outputRootFor(project, destinationFolderId, folders, "Destination");
  const referencedPaths = uniqueLocalMediaPaths([...job.resultUrls, ...job.thumbnailUrls]);
  const operations = buildMoveOperations(referencedPaths, sourceOutputRoot, destinationOutputRoot, job.outputType);

  await validateReferencedFiles(referencedPaths);
  await validateMoveOperations(operations);
  const completedOperations: ResultFileMove[] = [];

  try {
    for (const operation of operations) {
      await fs.mkdir(path.dirname(operation.to), { recursive: true });
      await fs.rename(operation.from, operation.to);
      completedOperations.push(operation);
    }
  } catch (error) {
    try {
      await rollbackFileMoves(completedOperations);
    } catch (rollbackError) {
      throw new Error(
        `Could not move result files: ${error instanceof Error ? error.message : "filesystem operation failed"}. `
        + `Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : "filesystem operation failed"}`,
      );
    }
    throw new Error(`Could not move result files: ${error instanceof Error ? error.message : "filesystem operation failed"}`);
  }

  const relocateUrl = (url: string) => rewriteLocalMediaUrl(url, operations);
  const movedJob: Job = {
    ...job,
    folderId: destinationFolderId,
    folderName: folderDisplayName(destinationFolderId, folders),
    resultUrls: job.resultUrls.map(relocateUrl),
    thumbnailUrls: job.thumbnailUrls.map(relocateUrl),
  };

  return {
    job: movedJob,
    fileMoves: operations,
    rollback: () => rollbackFileMoves(completedOperations),
  };
}

function uniqueLocalMediaPaths(urls: string[]) {
  const paths = urls
    .map(localMediaPathFromUrl)
    .filter((filePath): filePath is string => Boolean(filePath));
  return Array.from(new Set(paths.map((filePath) => path.resolve(filePath))));
}

function outputRootFor(
  project: Project,
  folderId: string | null | undefined,
  folders: ProjectFolder[],
  label: "Source" | "Destination",
) {
  if (!folderId) return path.resolve(project.folderPath);
  const folder = folders.find((item) => item.folderId === folderId && !item.archived);
  if (!folder) throw new Error(`${label} folder not found.`);
  const root = path.resolve(project.folderPath, "folders", folder.diskName);
  assertPathInside(project.folderPath, root);
  return root;
}

function buildMoveOperations(
  referencedPaths: string[],
  sourceOutputRoot: string,
  destinationOutputRoot: string,
  outputType: Job["outputType"],
) {
  const bySource = new Map<string, ResultFileMove>();
  for (const referencedPath of referencedPaths) {
    const relative = safeRelativePath(sourceOutputRoot, referencedPath);
    if (!relative) continue;
    const segments = relative.split(path.sep).filter(Boolean);
    if (!MOVABLE_OUTPUT_FOLDERS.has(segments[0]?.toLowerCase())) continue;

    const movableRelative = outputType === "sequence" && segments[0].toLowerCase() === "sequences" && segments.length > 2
      ? path.join(segments[0], segments[1])
      : relative;
    const from = path.resolve(sourceOutputRoot, movableRelative);
    const to = path.resolve(destinationOutputRoot, movableRelative);
    assertPathInside(sourceOutputRoot, from);
    assertPathInside(destinationOutputRoot, to);
    bySource.set(normalizePath(from), {
      from,
      to,
      fromRelativePath: path.relative(sourceOutputRoot, from).replaceAll("\\", "/"),
      toRelativePath: path.relative(destinationOutputRoot, to).replaceAll("\\", "/"),
    });
  }
  return Array.from(bySource.values());
}

async function validateMoveOperations(operations: ResultFileMove[]) {
  for (const operation of operations) {
    const destination = await fs.stat(operation.to).catch(() => undefined);
    if (destination) {
      throw new Error(`A result with the same file name already exists in the destination: ${path.basename(operation.to)}`);
    }
  }
}

async function validateReferencedFiles(referencedPaths: string[]) {
  for (const filePath of referencedPaths) {
    const source = await fs.stat(filePath).catch(() => undefined);
    if (!source) {
      throw new Error(`Result file is missing: ${path.basename(filePath)}`);
    }
  }
}

async function rollbackFileMoves(operations: ResultFileMove[]) {
  const failures: string[] = [];
  for (const operation of [...operations].reverse()) {
    const destinationExists = await fs.stat(operation.to).then(() => true).catch(() => false);
    if (!destinationExists) continue;
    await fs.mkdir(path.dirname(operation.from), { recursive: true });
    await fs.rename(operation.to, operation.from).catch((error) => {
      failures.push(`${path.basename(operation.to)}: ${error instanceof Error ? error.message : "filesystem operation failed"}`);
    });
  }
  if (failures.length) {
    throw new Error(failures.join("; "));
  }
}

function rewriteLocalMediaUrl(value: string, operations: ResultFileMove[]) {
  const filePath = localMediaPathFromUrl(value);
  if (!filePath) return value;
  const relocatedPath = relocatedFilePath(filePath, operations);
  if (!relocatedPath) return value;

  const absolute = /^https?:\/\//i.test(value);
  const url = new URL(value, "http://127.0.0.1");
  url.searchParams.set("path", relocatedPath);
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function relocatedFilePath(filePath: string, operations: ResultFileMove[]) {
  const resolved = path.resolve(filePath);
  for (const operation of operations) {
    const relative = safeRelativePath(operation.from, resolved, true);
    if (relative !== undefined) {
      return relative ? path.join(operation.to, relative) : operation.to;
    }
  }
  return undefined;
}

function localMediaPathFromUrl(value: string) {
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.pathname !== LOCAL_MEDIA_PATH) return undefined;
    const filePath = url.searchParams.get("path");
    return filePath ? path.resolve(filePath) : undefined;
  } catch {
    return undefined;
  }
}

function safeRelativePath(root: string, target: string, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  if (!relative && !allowRoot) return undefined;
  return relative;
}

function assertPathInside(root: string, target: string) {
  if (safeRelativePath(root, target, true) === undefined) {
    throw new Error("Resolved result path is outside the project folder.");
  }
}

function normalizePath(value: string) {
  return path.resolve(value).toLowerCase();
}
