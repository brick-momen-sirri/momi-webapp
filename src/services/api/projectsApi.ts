import type { Project } from "../../types";
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
