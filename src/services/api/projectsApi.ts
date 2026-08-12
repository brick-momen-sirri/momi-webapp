import type { Project, ProjectRole } from "../../types";
import { apiRequest } from "./client";
import { mapProject } from "./mappers";

export async function fetchBackendProjects() {
  const data = await apiRequest<{ projects: Project[] }>("/api/projects");
  return data.projects.map(mapProject);
}

export async function createBackendProject(project: Project) {
  const data = await apiRequest<{ project: Project }>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  return mapProject(data.project);
}

export async function updateBackendProject(project: Project) {
  const data = await apiRequest<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  return mapProject(data.project);
}

// Membership is edited one member at a time rather than by PATCHing the whole
// project. Sending the entire array meant two owners editing at once silently
// overwrote each other, and it gave the UI no way to tell "the server accepted
// this member" from "the server rejected the whole list".
export async function addBackendProjectMember(projectId: string, userId: string, role: ProjectRole) {
  const data = await apiRequest<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
  return mapProject(data.project);
}

export async function removeBackendProjectMember(projectId: string, userId: string) {
  const data = await apiRequest<{ project: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  return mapProject(data.project);
}

export async function createBackendProjectFolder(projectId: string, name: string, parentId?: string | null) {
  const data = await apiRequest<{ folder: NonNullable<Project["folders"]>[number]; project?: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/folders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    },
  );
  return { folder: data.folder, project: data.project ? mapProject(data.project) : undefined };
}

export async function renameBackendProjectFolder(projectId: string, folderId: string, name: string) {
  const data = await apiRequest<{ folder: NonNullable<Project["folders"]>[number]; project?: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) },
  );
  return { folder: data.folder, project: data.project ? mapProject(data.project) : undefined };
}

export async function deleteBackendProjectFolder(projectId: string, folderId: string) {
  const data = await apiRequest<{ folder: NonNullable<Project["folders"]>[number]; project?: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
  return { folder: data.folder, project: data.project ? mapProject(data.project) : undefined };
}
