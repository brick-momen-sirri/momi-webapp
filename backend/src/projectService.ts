import fs from "node:fs/promises";
import path from "node:path";
import { appStateDriver, appStateSqlitePath, brickProjectsRoot, localProjectsRoot, projectsStorePath } from "./config.js";
import { invalidateSharedMediaIndex } from "./mediaIndexCoordinator.js";
import { projectFolderName } from "./projectFolderName.js";
import {
  buildProjectDiskName,
  createProjectFolder as createProjectFolderRecord,
  deleteProjectFolder as deleteProjectFolderRecord,
  ensureProjectFolderStructure,
  ensureProjectMetadata,
  parseProjectDiskName,
  readProjectMetadata,
  renameProjectFolder as renameProjectFolderRecord,
  renameProjectOnDisk,
  validateDisplayName,
  withProjectRegistryMutationLock,
} from "./projectMetadataService.js";
import { readJsonFile, safeSegment, writeJsonFile } from "./storageService.js";
import { openSqliteProjectStore, type SqliteProjectStore } from "./sqliteProjectStore.js";
import type { Project, ProjectFolder, ProjectMember } from "./types.js";

const now = () => new Date().toISOString();
export const PLAYGROUND_PROJECT_ID = "prj_playground";
export const PLAYGROUND_FOLDER_NAME = "0000_ply_graound";
export const PROJECT_FOLDER_EXAMPLE = "1234_Client Name_Project_Name";
export const PROJECT_FOLDER_RULE_MESSAGE =
  `Project folder name must follow company format: ${PROJECT_FOLDER_EXAMPLE} ` +
  "(4 digits, underscore, office name, underscore, project name).";

function seedProjects(): Project[] {
  const createdAt = now();
  return [
    {
      id: PLAYGROUND_PROJECT_ID,
      name: "Playground",
      shortName: "PLY",
      folderName: PLAYGROUND_FOLDER_NAME,
      isDefault: true,
      description: "Official default Playground project folder for local tests.",
      folderPath: path.join(brickProjectsRoot, PLAYGROUND_FOLDER_NAME),
      ownerId: "usr_momen",
      members: [{ userId: "usr_momen", role: "owner", addedAt: createdAt, addedBy: "usr_momen" }],
      groupMembers: [],
      jobCount: 0,
      createdAt,
      updatedAt: createdAt,
    },
  ];
}

let projects: Project[] = [];
let sqliteProjectStore: SqliteProjectStore | undefined;

export async function loadProjects() {
  sqliteProjectStore?.close();
  sqliteProjectStore = undefined;
  return withProjectRegistryMutationLock(brickProjectsRoot, async () => {
    await ensureProjectFolder(path.join(brickProjectsRoot, PLAYGROUND_FOLDER_NAME));
    const storedProjects = await readJsonFile<Project[]>(projectsStorePath, []);
    const discoveredProjects = await discoverBrickProjects();
    projects = normalizeProjects(mergeProjects(storedProjects, discoveredProjects));

    if (appStateDriver === "sqlite") {
      sqliteProjectStore = openSqliteProjectStore(appStateSqlitePath);
      const migrated = sqliteProjectStore.migrateFromJsonIfNeeded(projects);
      if (migrated && projects.length) {
        console.log(`Migrated ${projects.length} projects into app-state SQLite.`);
      }

      const discovered = normalizeProjects(discoveredProjects);
      for (const project of discovered) {
        const existing = sqliteProjectStore.loadProjectById(project.id);
        if (existing && !sameProjectPath(existing.folderPath, project.folderPath)) {
          const [existingPathPresent, discoveredPathPresent] = await Promise.all([
            projectPathExists(existing.folderPath),
            projectPathExists(project.folderPath),
          ]);
          if (!existingPathPresent && discoveredPathPresent) {
            sqliteProjectStore.applyToProject(existing.id, (current) => mergeHydratedProject(current, project));
          }
        }
        sqliteProjectStore.insertDiscoveredProject(project);
      }

      // Complete an interrupted create and refresh filesystem-owned folder
      // metadata without replacing row-owned ACL fields.
      for (const project of sqliteProjectStore.loadProjects()) {
        const hydrated = await ensureProjectMetadata(project);
        sqliteProjectStore.applyToProject(project.id, (current) => mergeHydratedProject(current, hydrated));
      }
      projects = [];
      return getProjects();
    }

    projects = await Promise.all(projects.map(ensureProjectMetadata));
    await saveProjects();
    return projects;
  });
}

export function closeProjectStore() {
  sqliteProjectStore?.close();
  sqliteProjectStore = undefined;
}

export async function discoverBrickProjects() {
  try {
    const entries = await fs.readdir(brickProjectsRoot, { withFileTypes: true });
    const folders = entries
      .filter((entry) => entry.isDirectory() && isBrickProjectFolder(entry.name))
      .map(async (entry) => {
        const folderPath = path.join(brickProjectsRoot, entry.name);
        const metadata = await readProjectMetadata(folderPath);
        const parts = entry.name.split("_");
        const shortName = /^\d{4}$/.test(parts[0] ?? "") ? parts[0] : safeSegment(entry.name).slice(0, 8).toUpperCase();
        const name = parts.length >= 3 ? parts.slice(2).join(" ") : entry.name;
        const createdAt = now();
        return {
          id: entry.name === PLAYGROUND_FOLDER_NAME ? PLAYGROUND_PROJECT_ID : metadata?.projectId ?? `prj_${safeSegment(entry.name).toLowerCase()}`,
          name: entry.name === PLAYGROUND_FOLDER_NAME ? "Playground" : metadata?.name ?? name,
          shortName: entry.name === PLAYGROUND_FOLDER_NAME ? "PLY" : metadata?.code ?? shortName,
          client: metadata?.client,
          displayName: metadata?.displayName,
          diskName: metadata?.diskName ?? entry.name,
          folderName: entry.name,
          isDefault: entry.name === PLAYGROUND_FOLDER_NAME,
          folderPath,
          ownerId: "usr_momen",
          members: [{ userId: "usr_momen", role: "owner", addedAt: createdAt, addedBy: "usr_momen" }],
          groupMembers: [],
          jobCount: 0,
          createdAt,
          updatedAt: createdAt,
        } satisfies Project;
      });
    return Promise.all(folders);
  } catch {
    return [];
  }
}

export function getProjects() {
  return sqliteProjectStore?.loadProjects() ?? projects;
}

export function getProject(id: string) {
  return sqliteProjectStore?.loadProjectById(id) ?? projects.find((project) => project.id === id);
}

export async function createProject(input: Partial<Project>) {
  const createdAt = now();
  const shortName = (input.shortName || input.code || safeSegment(input.name || "Project").slice(0, 8)).trim().toUpperCase();
  const parsed = parseProjectDiskName(input.folderName || projectFolderName(input.folderPath), input.name || "Project", shortName);
  const client = validateDisplayName(input.client || parsed.client || "Client", "Client");
  const projectName = validateDisplayName(input.name || parsed.name || "New Project", "Project name");
  const requestedFolderName =
    input.folderName?.trim() ||
    projectFolderName(input.folderPath).trim() ||
    buildProjectDiskName(shortName, client, projectName);
  const folderName = validateBrickProjectFolderName(requestedFolderName);
  const folderPath =
    input.folderPath && projectFolderName(input.folderPath) === folderName
      ? input.folderPath
      : path.join(brickProjectsRoot, folderName);
  const project: Project = {
    id: input.id || `prj_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: projectName,
    shortName,
    code: shortName,
    client,
    displayName: `${client} - ${projectName}`,
    diskName: folderName,
    description: input.description,
    folderName: folderName || projectFolderName(folderPath),
    folderPath,
    ownerId: input.ownerId || "usr_momen",
    members: input.members || [{ userId: input.ownerId || "usr_momen", role: "owner", addedAt: createdAt, addedBy: input.ownerId || "usr_momen" }],
    groupMembers: input.groupMembers || [],
    jobCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
  return withProjectRegistryMutationLock(brickProjectsRoot, async () => {
    if (sqliteProjectStore) {
      try {
        sqliteProjectStore.insertProject(project);
      } catch (error) {
        throwProjectIdentityConstraint(error);
      }
    }

    try {
      await ensureProjectFolder(folderPath);
    } catch (error) {
      sqliteProjectStore?.deleteProject(project.id);
      throw error;
    }
    const hydrated = await ensureProjectMetadata(project);
    if (sqliteProjectStore) {
      return sqliteProjectStore.applyToProject(project.id, (current) => mergeHydratedProject(current, hydrated)) ?? hydrated;
    }
    projects = [hydrated, ...projects];
    await saveProjects();
    return hydrated;
  });
}

export async function updateProject(projectId: string, input: Partial<Project>) {
  if (sqliteProjectStore) {
    return sqliteProjectStore.applyToProject(projectId, (current) => updatedProject(current, input));
  }
  const current = getProject(projectId);
  if (!current) {
    return undefined;
  }

  const updated = updatedProject(current, input);

  projects = projects.map((project) => (project.id === projectId ? updated : project));
  await saveProjects();
  return updated;
}

export async function renameProject(projectId: string, input: { client?: string; name?: string }, userId: string) {
  return withProjectRegistryMutationLock(brickProjectsRoot, async () => {
    const current = getProject(projectId);
    if (!current) {
      return undefined;
    }

    const renamed = await renameProjectOnDisk(current, input, userId);
    const updated = await ensureProjectMetadata({
      ...current,
      name: renamed.metadata.name,
      shortName: renamed.metadata.code,
      code: renamed.metadata.code,
      client: renamed.metadata.client,
      displayName: renamed.metadata.displayName,
      diskName: renamed.folderName,
      folderName: renamed.folderName,
      folderPath: renamed.folderPath,
      updatedAt: renamed.metadata.updatedAt,
    });
    if (sqliteProjectStore) {
      const stored = sqliteProjectStore.applyToProject(projectId, (latest) => mergeHydratedProject(latest, updated));
      invalidateSharedMediaIndex();
      return stored;
    }
    projects = projects.map((project) => (project.id === projectId ? updated : project));
    await saveProjects();
    invalidateSharedMediaIndex();
    return updated;
  });
}

export async function createProjectFolder(projectId: string, input: { name: string; parentId?: string | null }, userId: string) {
  const project = getProject(projectId);
  if (!project) return undefined;
  const folder = await createProjectFolderRecord(project, input, userId);
  await refreshProjectFolders(projectId);
  return folder;
}

export async function renameProjectFolder(projectId: string, folderId: string, input: { name: string }, userId: string) {
  const project = getProject(projectId);
  if (!project) return undefined;
  const folder = await renameProjectFolderRecord(project, folderId, input, userId);
  await refreshProjectFolders(projectId);
  invalidateSharedMediaIndex();
  return folder;
}

export async function deleteProjectFolder(projectId: string, folderId: string, userId: string) {
  const project = getProject(projectId);
  if (!project) return undefined;
  const folder = await deleteProjectFolderRecord(project, folderId, userId);
  await refreshProjectFolders(projectId);
  return folder;
}

export async function listProjectFolders(projectId: string): Promise<ProjectFolder[] | undefined> {
  const project = getProject(projectId);
  if (!project) return undefined;
  await refreshProjectFolders(projectId);
  return getProject(projectId)?.folders ?? [];
}

export async function addProjectMember(projectId: string, member: ProjectMember) {
  if (!isProjectRole(member.role)) {
    throw new Error("Project role must be owner, editor, or viewer.");
  }
  if (sqliteProjectStore) {
    return sqliteProjectStore.applyToProject(projectId, (project) => {
      project.members = normalizeMembers([
        ...project.members.filter((item) => item.userId !== member.userId),
        { ...member, addedAt: member.addedAt || now(), addedBy: member.addedBy || project.ownerId },
      ], project.ownerId);
      project.updatedAt = now();
    });
  }
  const project = getProject(projectId);
  if (!project) {
    return undefined;
  }
  project.members = [
    ...project.members.filter((item) => item.userId !== member.userId),
    { ...member, addedAt: member.addedAt || now(), addedBy: member.addedBy || project.ownerId },
  ];
  project.members = normalizeMembers(project.members, project.ownerId);
  project.updatedAt = now();
  await saveProjects();
  return project;
}

export async function removeProjectMember(projectId: string, userId: string) {
  if (sqliteProjectStore) {
    return sqliteProjectStore.applyToProject(projectId, (project) => {
      project.members = project.members.filter((item) => item.userId !== userId || item.role === "owner");
      project.updatedAt = now();
    });
  }
  const project = getProject(projectId);
  if (!project) {
    return undefined;
  }
  project.members = project.members.filter((item) => item.userId !== userId || item.role === "owner");
  project.updatedAt = now();
  await saveProjects();
  return project;
}

async function saveProjects() {
  if (sqliteProjectStore) return;
  await writeJsonFile(projectsStorePath, projects);
}

function updatedProject(current: Project, input: Partial<Project>): Project {
  const ownerId = input.ownerId || current.ownerId;
  return {
    ...current,
    name: current.name,
    shortName: current.shortName,
    description: input.description ?? current.description,
    ownerId,
    members: normalizeMembers(input.members ?? current.members, ownerId),
    groupMembers: input.groupMembers ?? current.groupMembers ?? [],
    updatedAt: now(),
  };
}

function mergeHydratedProject(current: Project, hydrated: Project): Project {
  return {
    ...current,
    name: hydrated.name,
    shortName: hydrated.shortName,
    code: hydrated.code,
    client: hydrated.client,
    displayName: hydrated.displayName,
    diskName: hydrated.diskName,
    folderName: hydrated.folderName,
    folderPath: hydrated.folderPath,
    folders: hydrated.folders,
    updatedAt: hydrated.updatedAt,
  };
}

function throwProjectIdentityConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("app_projects.folder_path_norm") || message.includes("app_projects.folder_name_norm")) {
    throw new Error("A project already uses that folder.");
  }
  if (message.includes("app_projects.id")) {
    throw new Error("A project with that ID already exists.");
  }
  throw error;
}

function normalizeProjects(input: Project[]) {
  const seed = seedProjects()[0];
  const valid = input
    .filter((project) => project.id && project.name && project.folderPath)
    .map((project) => {
      if (project.id === seed.id) {
        return withoutDerivedProjectStats({
          ...seed,
          members: project.members?.length ? project.members : seed.members,
          groupMembers: project.groupMembers ?? [],
        });
      }
      const folderName = project.folderName || projectFolderName(project.folderPath);
      const parsed = parseProjectDiskName(folderName, project.name, project.shortName);
      return withoutDerivedProjectStats({
        ...project,
        shortName: project.shortName || parsed.code,
        code: project.code || project.shortName || parsed.code,
        client: project.client || parsed.client,
        displayName: project.displayName || `${project.client || parsed.client} - ${project.name || parsed.name}`,
        diskName: project.diskName || folderName,
        folderName,
      });
    });
  if (!valid.some((project) => project.id === seed.id)) {
    valid.unshift(seed);
  }
  return valid;
}

function withoutDerivedProjectStats(project: Project): Project {
  const normalized = { ...project, jobCount: 0 };
  delete normalized.creditsUsed;
  delete normalized.monthCreditsUsed;
  return normalized;
}

function normalizeMembers(members: ProjectMember[], ownerId: string) {
  const nowValue = now();
  const map = new Map<string, ProjectMember>();
  for (const member of members) {
    if (!member.userId || !isProjectRole(member.role)) continue;
    map.set(member.userId, {
      userId: member.userId,
      role: member.role,
      addedAt: member.addedAt || nowValue,
      addedBy: member.addedBy || ownerId,
    });
  }

  if (!Array.from(map.values()).some((member) => member.role === "owner")) {
    map.set(ownerId, {
      userId: ownerId,
      role: "owner",
      addedAt: nowValue,
      addedBy: ownerId,
    });
  }

  return Array.from(map.values());
}

function isProjectRole(role: unknown): role is ProjectMember["role"] {
  return role === "owner" || role === "editor" || role === "viewer";
}

function mergeProjects(stored: Project[], discovered: Project[]) {
  const merged: Project[] = [];
  for (const project of [...discovered, ...stored]) {
    const index = merged.findIndex((item) => sameProjectRecord(item, project));
    if (index >= 0) {
      merged[index] = { ...merged[index], ...project };
    } else {
      merged.push(project);
    }
  }
  return merged;
}

function sameProjectRecord(left: Project, right: Project) {
  if (left.id && right.id && left.id === right.id) return true;
  const leftPath = normalizeProjectPath(left.folderPath);
  const rightPath = normalizeProjectPath(right.folderPath);
  if (leftPath && rightPath && leftPath === rightPath) return true;
  const leftFolder = left.folderName || projectFolderName(left.folderPath);
  const rightFolder = right.folderName || projectFolderName(right.folderPath);
  return Boolean(leftFolder && rightFolder && leftFolder.toLowerCase() === rightFolder.toLowerCase());
}

function normalizeProjectPath(folderPath: string | undefined) {
  return folderPath ? path.resolve(folderPath).toLowerCase() : "";
}

function sameProjectPath(left: string, right: string) {
  return normalizeProjectPath(left) === normalizeProjectPath(right);
}

async function projectPathExists(folderPath: string) {
  try {
    return (await fs.stat(folderPath)).isDirectory();
  } catch {
    return false;
  }
}

export function isBrickProjectFolder(folderName: string) {
  return /^\d{4}_[A-Za-z0-9][A-Za-z0-9 .,&()+\-']*_[A-Za-z0-9][A-Za-z0-9 _.,&()+\-']*$/.test(folderName);
}

function validateBrickProjectFolderName(folderName: string) {
  if (!isBrickProjectFolder(folderName)) {
    throw new Error(PROJECT_FOLDER_RULE_MESSAGE);
  }
  return folderName;
}

function buildProjectFolderName(shortName: string, name: string) {
  const safeName =
    name
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "Client_Project";
  return `${shortName}_${safeName}`;
}

async function ensureProjectFolder(projectRoot: string) {
  await ensureProjectFolderStructure(projectRoot);
}

async function refreshProjectFolders(projectId: string) {
  const project = getProject(projectId);
  if (!project) return;
  const hydrated = await ensureProjectMetadata(project);
  if (sqliteProjectStore) {
    sqliteProjectStore.applyToProject(projectId, (current) => {
      current.folders = hydrated.folders;
      current.updatedAt = now();
    });
    return;
  }
  projects = projects.map((item) => (item.id === projectId ? hydrated : item));
  await saveProjects();
}
