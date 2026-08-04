import { apiRequest } from "./client";
import { mapModel } from "./mappers";
import type { BackendWorkflowModel } from "./types";

export async function fetchBackendModels() {
  const data = await apiRequest<{ models: BackendWorkflowModel[] }>("/api/models");
  return data.models.map(mapModel);
}
