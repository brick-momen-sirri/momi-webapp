import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertManifestRecordSafe, readJsonFile, writeJsonFile } from "./storageService.js";
import type { Project, ProjectFolder, ProjectMetadata } from "./types.js";

type ProjectFoldersFile = {
  version: 1;
  folders: ProjectFolder[];
};

type ProjectLock = {
  handle: fs.FileHandle;
  lockPath: string;
};

const RESERVED_WINDOWS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const LOCK_STALE_MS = 5 * 60 * 1000;

const now = () => new Date().toISOString();

export async function readProjectMetadata(projectRoot: string) {
  return readJsonFile<ProjectMetadata | undefined>(path.join(projectRoot, "metadata", "project.json"), undefined);
}

export async function ensureProjectMetadata(project: Project): Promise<Project> {
  await ensureProjectFolderStructure(project.folderPath);
  const metadataPath = projectMetadataPath(project.folderPath);
  const existing = await readProjectMetadata(project.folderPath);
  const parsed = parseProjectDiskName(path.basename(project.folderPath), project.name, project.shortName);
  const code = existing?.code || parsed.code || project.shortName || "0000";
  const client = existing?.client || project.client || parsed.client || project.shortName || "Client";
  const projectName = existing?.name || project.name || parsed.name || "Project";
  const metadata: ProjectMetadata = {
    version: 1,
    projectId: existing?.projectId || project.id,
    code,
    client,
    name: projectName,
    displayName: displayName(client, projectName),
    diskName: path.basename(project.folderPath),
    createdAt: existing?.createdAt || project.createdAt || now(),
    updatedAt: existing?.updatedAt || project.updatedAt || now(),
    renamedFrom: Array.isArray(existing?.renamedFrom) ? existing.renamedFrom.filter((item): item is string => typeof item === "string") : [],
  };

  if (!existing || needsProjectMetadataWrite(existing, metadata)) {
    await writeJsonFile(metadataPath, metadata);
  }

  const folders = await ensureProjectFoldersFile(project.folderPath);
  return applyProjectMetadata(project, metadata, folders);
}

export async function ensureProjectFolderStructure(projectRoot: string) {
  for (const folder of ["images", "sequences", "videos", "metadata", "logs", "jobs", "folders"]) {
    await fs.mkdir(path.join(projectRoot, folder), { recursive: true });
  }
}

export async function loadProjectFolders(project: Project): Promise<ProjectFolder[]> {
  return ensureProjectFoldersFile(project.folderPath);
}

export async function createProjectFolder(
  project: Project,
  input: { name: string; parentId?: string | null },
  userId: string,
) {
  return withProjectLock(project, async () => {
    const folders = await ensureProjectFoldersFile(project.folderPath);
    const cleanName = validateDisplayName(input.name);
    const parentId = normalizeParentId(input.parentId);

    if (parentId && !folders.some((folder) => folder.folderId === parentId && !folder.archived)) {
      throw new Error("Parent folder not found.");
    }
    assertUniqueFolderName(folders, cleanName, parentId);

    const folderId = uniqueFolderId(folders);
    const folder: ProjectFolder = {
      folderId,
      parentId,
      name: cleanName,
      slug: toSlug(cleanName),
      diskName: buildFolderDiskName(folderId, cleanName),
      createdAt: now(),
      updatedAt: now(),
      createdBy: userId,
      updatedBy: userId,
      archived: false,
    };

    const folderRoot = path.join(project.folderPath, "folders", folder.diskName);
    assertPathInside(project.folderPath, folderRoot);
    for (const child of ["images", "videos", "sequences", "metadata"]) {
      await fs.mkdir(path.join(folderRoot, child), { recursive: true });
    }

    const updatedFolders = [...folders, folder];
    await writeProjectFolders(project.folderPath, updatedFolders);
    await appendAudit(project.folderPath, {
      event: "folder.created",
      projectId: project.id,
      folderId,
      name: cleanName,
      changedBy: userId,
    });
    return folder;
  });
}

export async function renameProjectFolder(
  project: Project,
  folderId: string,
  input: { name: string },
  userId: string,
) {
  return withProjectLock(project, async () => {
    const folders = await ensureProjectFoldersFile(project.folderPath);
    const folder = folders.find((item) => item.folderId === folderId && !item.archived);
    if (!folder) {
      throw new Error("Folder not found.");
    }

    const cleanName = validateDisplayName(input.name);
    assertUniqueFolderName(folders, cleanName, folder.parentId, folder.folderId);
    const newDiskName = buildFolderDiskName(folder.folderId, cleanName);
    const oldPath = path.join(project.folderPath, "folders", folder.diskName);
    const newPath = path.join(project.folderPath, "folders", newDiskName);
    assertPathInside(project.folderPath, oldPath);
    assertPathInside(project.folderPath, newPath);
    await assertTargetDoesNotExist(oldPath, newPath);
    await renameDirSafe(oldPath, newPath);

    const oldName = folder.name;
    const updated: ProjectFolder = {
      ...folder,
      name: cleanName,
      slug: toSlug(cleanName),
      diskName: newDiskName,
      updatedAt: now(),
      updatedBy: userId,
    };
    const updatedFolders = folders.map((item) => (item.folderId === folder.folderId ? updated : item));
    await writeProjectFolders(project.folderPath, updatedFolders);
    await appendAudit(project.folderPath, {
      event: "folder.renamed",
      projectId: project.id,
      folderId,
      oldName,
      newName: cleanName,
      changedBy: userId,
    });

    return updated;
  });
}

export async function deleteProjectFolder(project: Project, folderId: string, userId: string) {
  return withProjectLock(project, async () => {
    const folders = await ensureProjectFoldersFile(project.folderPath);
    const folder = folders.find((item) => item.folderId === folderId && !item.archived);
    if (!folder) {
      throw new Error("Folder not found.");
    }
    if (folders.some((item) => !item.archived && item.parentId === folderId)) {
      throw new Error("Delete child folders first.");
    }

    const folderRoot = path.join(project.folderPath, "folders", folder.diskName);
    assertPathInside(project.folderPath, folderRoot);
    if (await directoryContainsFiles(folderRoot)) {
      throw new Error("Only empty folders can be deleted.");
    }

    await fs.rm(folderRoot, { recursive: true, force: true });
    const updated: ProjectFolder = {
      ...folder,
      archived: true,
      updatedAt: now(),
      updatedBy: userId,
    };
    const updatedFolders = folders.map((item) => (item.folderId === folderId ? updated : item));
    await writeProjectFolders(project.folderPath, updatedFolders);
    await appendAudit(project.folderPath, {
      event: "folder.deleted",
      projectId: project.id,
      folderId,
      oldName: folder.name,
      changedBy: userId,
    });

    return updated;
  });
}

export async function resolveProjectOutputRoot(project: Project, folderId?: string | null) {
  if (!folderId) {
    return { root: project.folderPath, folder: undefined };
  }

  const folders = await ensureProjectFoldersFile(project.folderPath);
  const folder = folders.find((item) => item.folderId === folderId && !item.archived);
  if (!folder) {
    throw new Error("Target folder not found.");
  }

  const root = path.join(project.folderPath, "folders", folder.diskName);
  assertPathInside(project.folderPath, root);
  return { root, folder };
}

export async function resolveProjectMediaPath(project: Project, folderId: string | null | undefined, relativePath: string) {
  const cleanRelative = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!cleanRelative || cleanRelative.includes("\0")) return undefined;
  const { root } = await resolveProjectOutputRoot(project, folderId);
  const fullPath = path.resolve(root, cleanRelative);
  assertPathInside(root, fullPath);
  return fullPath;
}

export async function renameProjectOnDisk(
  project: Project,
  input: { client?: string; name?: string },
  userId: string,
) {
  const oldRoot = project.folderPath;
  const lock = await acquireProjectLock(oldRoot);
  let currentRoot = oldRoot;

  try {
    const existing = await readProjectMetadata(oldRoot);
    const parsed = parseProjectDiskName(path.basename(oldRoot), project.name, project.shortName);
    const code = existing?.code || project.shortName || parsed.code || "0000";
    const client = validateDisplayName(input.client ?? existing?.client ?? project.client ?? parsed.client ?? "Client", "Client");
    const name = validateDisplayName(input.name ?? existing?.name ?? project.name ?? parsed.name ?? "Project", "Project name");
    const newDiskName = buildProjectDiskName(code, client, name);
    const newRoot = path.join(path.dirname(oldRoot), newDiskName);

    assertPathInside(path.dirname(oldRoot), newRoot);
    await assertTargetDoesNotExist(oldRoot, newRoot);
    await lock.handle.close().catch(() => undefined);
    await renameDirSafe(oldRoot, newRoot);
    currentRoot = newRoot;
    await ensureProjectFolderStructure(newRoot);

    const oldDiskName = path.basename(oldRoot);
    const metadata: ProjectMetadata = {
      version: 1,
      projectId: existing?.projectId || project.id,
      code,
      client,
      name,
      displayName: displayName(client, name),
      diskName: newDiskName,
      createdAt: existing?.createdAt || project.createdAt || now(),
      updatedAt: now(),
      renamedFrom: uniqueStrings([...(existing?.renamedFrom ?? []), oldDiskName].filter((item) => item && item !== newDiskName)),
    };

    await writeJsonFile(projectMetadataPath(newRoot), metadata);
    await appendAudit(newRoot, {
      event: "project.renamed",
      projectId: metadata.projectId,
      oldName: existing?.name || project.name,
      newName: name,
      oldClient: existing?.client || project.client || parsed.client,
      newClient: client,
      oldDiskName,
      newDiskName,
      changedBy: userId,
    });

    return {
      metadata,
      folderPath: newRoot,
      folderName: newDiskName,
    };
  } finally {
    await releaseProjectLock(lock, currentRoot);
  }
}

export async function appendAudit(projectRoot: string, record: Record<string, unknown>) {
  await appendJsonl(path.join(projectRoot, "metadata", "audit.jsonl"), {
    ...record,
    createdAt: now(),
  });
}

export async function appendManifestEvent(project: Project, record: Record<string, unknown>) {
  await appendJsonl(path.join(project.folderPath, "metadata", "manifest.jsonl"), {
    ...record,
    createdAt: now(),
  });
}

export function validateDisplayName(name: unknown, label = "Name") {
  if (typeof name !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (trimmed.length > 80) {
    throw new Error(`${label} is too long.`);
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) {
    throw new Error(`${label} contains invalid filesystem characters.`);
  }
  if (trimmed.endsWith(".") || trimmed.endsWith(" ")) {
    throw new Error(`${label} cannot end with dot or space.`);
  }
  if (RESERVED_WINDOWS_NAMES.has(trimmed.toUpperCase())) {
    throw new Error(`${label} is reserved by Windows.`);
  }
  return trimmed;
}

export function toSlug(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "folder"
  );
}

export function buildProjectDiskName(code: string, client: string, projectName: string) {
  if (!/^\d{4}$/.test(code)) {
    throw new Error("Project code must be exactly 4 digits.");
  }
  const safeClient = validateDisplayName(client, "Client").replace(/\s+/g, "_");
  const safeProject = validateDisplayName(projectName, "Project name").replace(/\s+/g, "_");
  return `${code}_${safeClient}_${safeProject}`;
}

export function buildFolderDiskName(folderId: string, name: string) {
  return `${folderId}_${toSlug(name)}`;
}

export function parseProjectDiskName(folderName: string, fallbackName = "Project", fallbackCode = "0000") {
  const parts = folderName.split("_").filter(Boolean);
  const code = /^\d{4}$/.test(parts[0] ?? "") ? parts[0] : /^\d{4}$/.test(fallbackCode) ? fallbackCode : "0000";
  const client = parts.length >= 2 ? parts[1].replace(/_/g, " ") : "Client";
  const name = parts.length >= 3 ? parts.slice(2).join(" ") : fallbackName;
  return { code, client, name };
}

export function folderDisplayName(folderId: string | null | undefined, folders: ProjectFolder[]) {
  if (!folderId) return "Root";
  return folders.find((folder) => folder.folderId === folderId)?.name;
}

export function relativePathFromOutputRoot(outputRoot: string, filePath: string) {
  return path.relative(outputRoot, filePath).replaceAll("\\", "/");
}

async function ensureProjectFoldersFile(projectRoot: string): Promise<ProjectFolder[]> {
  const foldersPath = projectFoldersPath(projectRoot);
  const exists = await fileExists(foldersPath);
  const data = await readJsonFile<ProjectFoldersFile>(foldersPath, { version: 1, folders: [] });
  const folders = Array.isArray(data.folders) ? data.folders.map(normalizeFolder).filter((item): item is ProjectFolder => Boolean(item)) : [];
  if (!exists) {
    await writeProjectFolders(projectRoot, folders);
  }
  return folders;
}

async function writeProjectFolders(projectRoot: string, folders: ProjectFolder[]) {
  await writeJsonFile(projectFoldersPath(projectRoot), { version: 1, folders });
}

function normalizeFolder(folder: ProjectFolder): ProjectFolder | undefined {
  if (!folder || typeof folder.folderId !== "string" || typeof folder.name !== "string") return undefined;
  const cleanName = validateDisplayName(folder.name);
  return {
    folderId: folder.folderId,
    parentId: typeof folder.parentId === "string" && folder.parentId ? folder.parentId : null,
    name: cleanName,
    slug: typeof folder.slug === "string" && folder.slug ? folder.slug : toSlug(cleanName),
    diskName: typeof folder.diskName === "string" && folder.diskName ? folder.diskName : buildFolderDiskName(folder.folderId, cleanName),
    createdAt: typeof folder.createdAt === "string" ? folder.createdAt : now(),
    updatedAt: typeof folder.updatedAt === "string" ? folder.updatedAt : now(),
    createdBy: typeof folder.createdBy === "string" ? folder.createdBy : undefined,
    updatedBy: typeof folder.updatedBy === "string" ? folder.updatedBy : undefined,
    archived: folder.archived === true,
  };
}

async function withProjectLock<T>(project: Project, fn: () => Promise<T>) {
  const lock = await acquireProjectLock(project.folderPath);
  try {
    return await fn();
  } finally {
    await releaseProjectLock(lock, project.folderPath);
  }
}

async function acquireProjectLock(projectRoot: string): Promise<ProjectLock> {
  await fs.mkdir(path.join(projectRoot, "metadata"), { recursive: true });
  const lockPath = path.join(projectRoot, "metadata", ".lock");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }), "utf8");
      return { handle, lockPath };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EEXIST") throw error;
      await removeStaleLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  throw new Error("Project is locked by another operation.");
}

async function releaseProjectLock(lock: ProjectLock, currentProjectRoot: string) {
  await lock.handle.close().catch(() => undefined);
  await fs.rm(lock.lockPath, { force: true }).catch(() => undefined);
  const movedLockPath = path.join(currentProjectRoot, "metadata", ".lock");
  if (path.resolve(movedLockPath).toLowerCase() !== path.resolve(lock.lockPath).toLowerCase()) {
    await fs.rm(movedLockPath, { force: true }).catch(() => undefined);
  }
}

async function removeStaleLock(lockPath: string) {
  const stat = await fs.stat(lockPath).catch(() => undefined);
  if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function renameDirSafe(oldPath: string, newPath: string) {
  const oldResolved = path.resolve(oldPath);
  const newResolved = path.resolve(newPath);
  if (oldResolved === newResolved) return;
  if (oldResolved.toLowerCase() === newResolved.toLowerCase()) {
    const tempPath = `${oldResolved}.__renaming_${Date.now()}`;
    await fs.rename(oldResolved, tempPath);
    await fs.rename(tempPath, newResolved);
    return;
  }
  await fs.rename(oldResolved, newResolved);
}

async function assertTargetDoesNotExist(oldPath: string, newPath: string) {
  const oldResolved = path.resolve(oldPath);
  const newResolved = path.resolve(newPath);
  if (oldResolved.toLowerCase() === newResolved.toLowerCase()) return;
  if (await fileExists(newResolved)) {
    throw new Error("A folder with that disk name already exists.");
  }
}

function assertPathInside(root: string, target: string) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const relative = path.relative(rootResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved path is outside the project folder.");
  }
}

async function appendJsonl(filePath: string, record: Record<string, unknown>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = assertManifestRecordSafe(record, path.basename(filePath));
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

function assertUniqueFolderName(folders: ProjectFolder[], name: string, parentId: string | null, exceptFolderId?: string) {
  const normalized = name.trim().toLowerCase();
  if (folders.some((folder) => !folder.archived && folder.folderId !== exceptFolderId && folder.parentId === parentId && folder.name.trim().toLowerCase() === normalized)) {
    throw new Error("A folder with that name already exists in this project.");
  }
}

function uniqueFolderId(folders: ProjectFolder[]) {
  const existing = new Set(folders.map((folder) => folder.folderId));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `fld_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!existing.has(id)) return id;
  }
  throw new Error("Could not create a unique folder ID.");
}

function applyProjectMetadata(project: Project, metadata: ProjectMetadata, folders: ProjectFolder[]): Project {
  return {
    ...project,
    id: metadata.projectId,
    name: metadata.name,
    shortName: metadata.code,
    code: metadata.code,
    client: metadata.client,
    displayName: metadata.displayName,
    diskName: metadata.diskName,
    folderName: metadata.diskName,
    folders,
    createdAt: project.createdAt || metadata.createdAt,
    updatedAt: project.updatedAt || metadata.updatedAt,
  };
}

function needsProjectMetadataWrite(current: ProjectMetadata, next: ProjectMetadata) {
  return current.projectId !== next.projectId
    || current.code !== next.code
    || current.client !== next.client
    || current.name !== next.name
    || current.displayName !== next.displayName
    || current.diskName !== next.diskName
    || !Array.isArray(current.renamedFrom);
}

function projectMetadataPath(projectRoot: string) {
  return path.join(projectRoot, "metadata", "project.json");
}

function projectFoldersPath(projectRoot: string) {
  return path.join(projectRoot, "metadata", "folders.json");
}

function displayName(client: string, name: string) {
  return client ? `${client} - ${name}` : name;
}

function normalizeParentId(parentId: string | null | undefined) {
  return typeof parentId === "string" && parentId.trim() ? parentId.trim() : null;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryContainsFiles(folderPath: string): Promise<boolean> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await directoryContainsFiles(fullPath)) return true;
  }
  return false;
}
