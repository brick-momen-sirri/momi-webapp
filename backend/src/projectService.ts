import fs from "node:fs/promises";
import path from "node:path";
import { brickProjectsRoot, localProjectsRoot, projectsStorePath } from "./config.js";
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
} from "./projectMetadataService.js";
import { readJsonFile, safeSegment, writeJsonFile } from "./storageService.js";
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

export async function loadProjects() {
  await ensureProjectFolder(path.join(brickProjectsRoot, PLAYGROUND_FOLDER_NAME));
  const storedProjects = await readJsonFile<Project[]>(projectsStorePath, []);
  const discoveredProjects = await discoverBrickProjects();
  projects = normalizeProjects(mergeProjects(storedProjects, discoveredProjects));
  projects = await Promise.all(projects.map(ensureProjectMetadata));
  await saveProjects();
  return projects;
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
  return projects;
}

export function getProject(id: string) {
  return projects.find((project) => project.id === id);
}

export async function createProject(input: Partial<Project>) {
  const createdAt = now();
  const shortName = (input.shortName || input.code || safeSegment(input.name || "Project").slice(0, 8)).trim().toUpperCase();
  const parsed = parseProjectDiskName(input.folderName || path.basename(input.folderPath || ""), input.name || "Project", shortName);
  const client = validateDisplayName(input.client || parsed.client || "Client", "Client");
  const projectName = validateDisplayName(input.name || parsed.name || "New Project", "Project name");
  const requestedFolderName =
    input.folderName?.trim() ||
    path.basename(input.folderPath || "").trim() ||
    buildProjectDiskName(shortName, client, projectName);
  const folderName = validateBrickProjectFolderName(requestedFolderName);
  const folderPath =
    input.folderPath && path.basename(input.folderPath) === folderName
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
    folderName: folderName || path.basename(folderPath),
    folderPath,
    ownerId: input.ownerId || "usr_momen",
    members: input.members || [{ userId: input.ownerId || "usr_momen", role: "owner", addedAt: createdAt, addedBy: input.ownerId || "usr_momen" }],
    groupMembers: input.groupMembers || [],
    jobCount: input.jobCount ?? 0,
    createdAt,
    updatedAt: createdAt,
  };
  await ensureProjectFolder(folderPath);
  const hydrated = await ensureProjectMetadata(project);
  projects = [hydrated, ...projects];
  await saveProjects();
  return hydrated;
}

export async function updateProject(projectId: string, input: Partial<Project>) {
  const current = getProject(projectId);
  if (!current) {
    return undefined;
  }

  const members = normalizeMembers(input.members ?? current.members, current.ownerId);
  const updated: Project = {
    ...current,
    name: current.name,
    shortName: current.shortName,
    description: input.description ?? current.description,
    ownerId: input.ownerId || current.ownerId,
    members,
    groupMembers: input.groupMembers ?? current.groupMembers ?? [],
    updatedAt: now(),
  };

  projects = projects.map((project) => (project.id === projectId ? updated : project));
  await saveProjects();
  return updated;
}

export async function renameProject(projectId: string, input: { client?: string; name?: string }, userId: string) {
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
  projects = projects.map((project) => (project.id === projectId ? updated : project));
  await saveProjects();
  return updated;
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
  const project = getProject(projectId);
  if (!project) {
    return undefined;
  }
  if (!isProjectRole(member.role)) {
    throw new Error("Project role must be owner, editor, or viewer.");
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
  const project = getProject(projectId);
  if (!project) {
    return undefined;
  }
  project.members = project.members.filter((item) => item.userId !== userId || item.role === "owner");
  project.updatedAt = now();
  await saveProjects();
  return project;
}

export async function incrementProjectJobCount(projectId: string) {
  const project = getProject(projectId);
  if (project) {
    project.jobCount += 1;
    project.updatedAt = now();
    await saveProjects();
  }
}

async function saveProjects() {
  await writeJsonFile(projectsStorePath, projects);
}

function normalizeProjects(input: Project[]) {
  const seed = seedProjects()[0];
  const valid = input
    .filter((project) => project.id && project.name && project.folderPath)
    .map((project) => {
      if (project.id === seed.id) {
        return { ...seed, members: project.members?.length ? project.members : seed.members, groupMembers: project.groupMembers ?? [] };
      }
      const folderName = project.folderName || path.basename(project.folderPath || "");
      const parsed = parseProjectDiskName(folderName, project.name, project.shortName);
      return {
        ...project,
        shortName: project.shortName || parsed.code,
        code: project.code || project.shortName || parsed.code,
        client: project.client || parsed.client,
        displayName: project.displayName || `${project.client || parsed.client} - ${project.name || parsed.name}`,
        diskName: project.diskName || folderName,
        folderName,
      };
    });
  if (!valid.some((project) => project.id === seed.id)) {
    valid.unshift(seed);
  }
  return valid;
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
  const leftFolder = left.folderName || path.basename(left.folderPath || "");
  const rightFolder = right.folderName || path.basename(right.folderPath || "");
  return Boolean(leftFolder && rightFolder && leftFolder.toLowerCase() === rightFolder.toLowerCase());
}

function normalizeProjectPath(folderPath: string | undefined) {
  return folderPath ? path.resolve(folderPath).toLowerCase() : "";
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
  projects = projects.map((item) => (item.id === projectId ? hydrated : item));
  await saveProjects();
}
