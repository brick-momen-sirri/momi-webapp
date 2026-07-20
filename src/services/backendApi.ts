import type { Job, MediaResolution, ModelType, Project, User, WorkflowOptions } from "../types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const AUTH_TOKEN_STORAGE_KEY = "momi_auth_token_v1";

export type AuthUser = User & {
  email: string;
  displayName?: string;
  role: "admin" | "user";
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type AuthResult =
  | { ok: true; account: AuthUser; token?: string }
  | { ok: false; error: string };

type BackendWorkflowModel = {
  id: string;
  name: string;
  category: string;
  workflowPath: string;
  description?: string;
  requiredInputs: string[];
  defaultResolution?: string;
  requiresPrompt: boolean;
  requiresImage: boolean;
  requiresStartEndFrames: boolean;
  imageSlotCount?: number;
  outputType: "image" | "video" | "sequence";
  estimatedCredits?: number;
  estimatedTime?: string;
  supportedResolutions?: string[];
  supportedDurations?: number[];
  defaultDurationSeconds?: number;
};

type BackendJob = {
  id: string;
  projectId: string;
  folderId?: string | null;
  folderName?: string;
  userId: string;
  modelId: string;
  modelName: string;
  title?: string;
  category: string;
  workflowPath?: string;
  inputType: Job["inputType"];
  prompt?: string;
  resolution?: MediaResolution;
  outputResolution?: MediaResolution;
  durationSeconds?: number;
  workflowOptions?: WorkflowOptions;
  status: Job["status"];
  inputImages: string[];
  inputVideo?: string;
  resultUrls: string[];
  thumbnailUrls: string[];
  outputType: "image" | "video" | "sequence";
  creditsEstimated?: number;
  creditsUsed?: number;
  creditsActual?: number;
  creditsActualSource?: string;
  creditBalanceBefore?: Job["creditBalanceBefore"];
  creditBalanceAfter?: Job["creditBalanceAfter"];
  creditUsage?: Job["creditUsage"];
  errorMessage?: string;
  fileName?: string;
  generatedPrompt?: string;
  textArtifacts?: Job["textArtifacts"];
  source?: "backend_job" | "existing_project_media";
  missingMetadata?: string[];
  archivedAt?: string;
  archivedBy?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type BackendJobsPage = {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type BackendMonthlyUsage = {
  month: string;
  startAt: string;
  endAt: string;
  users: Array<{
    userId: string;
    creditsSpent: number;
    jobsCompleted: number;
  }>;
};

export type BackendCreditDashboardGroup = {
  id: string;
  label: string;
  credits: number;
  usd: number;
  jobs: number;
  percentage: number;
  averageCreditsPerRun: number;
  minCredits: number;
  maxCredits: number;
  expectedCredits: number;
  actualVsExpectedCredits: number;
  lastActivityAt?: string;
  mostExpensiveWorkflow?: string;
  mostExpensiveWorkflowCredits?: number;
};

export type BackendCreditDashboardDay = {
  date: string;
  credits: number;
  usd: number;
  jobs: number;
};

export type BackendCreditDashboardRecentJob = {
  jobId: string;
  projectId: string;
  projectName: string;
  userId: string;
  userName: string;
  modelId: string;
  modelName: string;
  status: Job["status"];
  credits: number;
  usd: number;
  expectedCredits: number;
  source: string;
  resolution: string;
  runDurationSeconds?: number;
  createdAt: string;
  completedAt?: string;
  timestamp: string;
};

export type BackendCreditDashboardNodeRow = {
  rowKey: string;
  jobId: string;
  projectName: string;
  userName: string;
  modelName: string;
  nodeId: string;
  nodeTitle: string;
  classType: string;
  credits: number;
  usd: number;
  source: string;
  status: string;
  createdAt: string;
};

export type BackendCreditDashboardAnomaly = {
  id: string;
  type: "run_high" | "expected_overrun" | "daily_high";
  severity: "warning" | "critical";
  message: string;
  jobId?: string;
  date?: string;
  credits: number;
  threshold: number;
};

export type BackendCreditDashboardRange = {
  preset: string;
  label: string;
  startAt: string;
  endAt: string;
};

export type BackendCreditDashboard = {
  generatedAt: string;
  month: string;
  range: BackendCreditDashboardRange;
  summary: {
    totalCredits: number;
    totalUsd: number;
    todayCredits: number;
    todayUsd: number;
    todayRuns: number;
    monthCredits: number;
    monthUsd: number;
    monthRuns: number;
    projectedMonthCredits: number;
    projectedMonthUsd: number;
    periodCredits: number;
    periodUsd: number;
    periodRuns: number;
    averageCreditsPerRun: number;
    burnRateCreditsPerDay: number;
    jobsWithUsage: number;
    totalJobs: number;
  };
  byProject: BackendCreditDashboardGroup[];
  byUser: BackendCreditDashboardGroup[];
  byModel: BackendCreditDashboardGroup[];
  byDay: BackendCreditDashboardDay[];
  anomalies: BackendCreditDashboardAnomaly[];
  recent: BackendCreditDashboardRecentJob[];
  nodeRows: BackendCreditDashboardNodeRow[];
};

export type BackendRuntime = {
  generationBackend: "runpod" | "local_comfy";
  localComfyEnabled: boolean;
  runpodConfigured: boolean;
  runpodPollIntervalMs: number;
  runpodTimeoutMs: number;
};

export type PodDisplayStatus = "idle" | "running" | "queued" | "stopped" | "error";

export type PodStatusJob = {
  id: string;
  modelName: string;
  status: Job["status"];
  projectId: string;
  startedAt?: string;
  createdAt: string;
  comfyServerUrl?: string;
  runpodJobId?: string;
  runpodStatus?: string;
};

export type PodStatusResponse = {
  backend: "runpod" | "local_comfy";
  status: PodDisplayStatus;
  available: number;
  running: number;
  idle: number;
  stopped: number;
  unavailable: number;
  queued: number;
  hasQueuedTasks: boolean;
  capacity: number;
  queue: {
    queued: number;
    sending: number;
    running: number;
    active: number;
    runpodActive: number;
    capacity: number;
    activeJobs: PodStatusJob[];
    waitingJobs: PodStatusJob[];
  };
  pods: Array<{
    id: string;
    label: string;
    status: PodDisplayStatus;
    message?: string;
    updatedAt?: string;
    currentJob?: PodStatusJob;
  }>;
  runpod?: {
    endpointConfigured: boolean;
    endpointLabel?: string;
    healthAvailable: boolean;
    healthError?: string;
    health?: {
      workers: {
        available: number;
        running: number;
        idle: number;
        stopped: number;
        unavailable: number;
        initializing: number;
        throttled: number;
      };
      jobs: {
        queued: number;
        running: number;
        completed?: number;
        failed?: number;
      };
    };
  };
  updatedAt: string;
};

export type ComfyServerStatus = "offline" | "idle" | "busy" | "error";

export type ComfyServer = {
  url: string;
  port?: number;
  status: ComfyServerStatus;
  lastChecked?: string;
  errorMessage?: string;
};

export type ComfyPoolAction =
  | "start"
  | "stop"
  | "restart"
  | "start-safe"
  | "start-all"
  | "stop-all"
  | "open-manager";

export type ComfyPoolActionResult = {
  ok: true;
  action: ComfyPoolAction;
  port?: number;
  message: string;
  output?: string;
  errorOutput?: string;
  startedAt: string;
};

export type BackendClipboardImage = {
  name: string;
  type: string;
  dataUrl: string;
  source: string;
};

type BackendJobsResponse = {
  jobs: BackendJob[];
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
};

type FetchBackendJobsParams = {
  limit?: number;
  offset?: number;
  projectId?: string;
  folderId?: string;
  userId?: string;
  q?: string;
  status?: Job["status"];
  outputType?: Job["outputType"];
  archived?: boolean;
};

export function getStoredAuthToken() {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? undefined;
}

export function setStoredAuthToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

export function clearStoredAuthToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export async function signInBackend(email: string, password: string): Promise<AuthResult> {
  try {
    const data = await api<{ token: string; user: AuthUser }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setStoredAuthToken(data.token);
    return { ok: true, account: mapUser(data.user), token: data.token };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not sign in." };
  }
}

export async function fetchCurrentAccount() {
  const data = await api<{ user: AuthUser }>("/api/auth/me");
  return mapUser(data.user);
}

export async function logoutBackend() {
  try {
    await api<{ ok: true }>("/api/auth/logout", { method: "POST" });
  } finally {
    clearStoredAuthToken();
  }
}

export async function updateBackendProfile(updates: Pick<AuthUser, "name" | "avatarColor"> & { profileImageUrl?: string }): Promise<AuthResult> {
  try {
    const data = await api<{ user: AuthUser }>("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, displayName: updates.name }),
    });
    return { ok: true, account: mapUser(data.user) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save profile." };
  }
}

export async function updateBackendPinnedProjects(projectIds: string[]): Promise<AuthResult> {
  try {
    const data = await api<{ user: AuthUser }>("/api/auth/me/pinned-projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds }),
    });
    return { ok: true, account: mapUser(data.user) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save pinned projects." };
  }
}

export async function changeBackendPassword(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): Promise<AuthResult> {
  try {
    const data = await api<{ user: AuthUser }>("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    });
    clearStoredAuthToken();
    return { ok: true, account: mapUser(data.user) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not change password." };
  }
}

export async function fetchBackendUsers() {
  const data = await api<{ users: AuthUser[] }>("/api/users");
  return data.users.map(mapUser);
}

export async function createBackendUser(payload: {
  name: string;
  email: string;
  username?: string;
  password: string;
  role: "admin" | "user";
  active?: boolean;
}) {
  const data = await api<{ user: AuthUser }>("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, displayName: payload.name }),
  });
  return mapUser(data.user);
}

export async function updateBackendUser(userId: string, payload: Partial<Pick<AuthUser, "name" | "email" | "role" | "active" | "avatarColor">>) {
  const data = await api<{ user: AuthUser }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, displayName: payload.name }),
  });
  return mapUser(data.user);
}

export async function resetBackendUserPassword(userId: string, password: string, confirmPassword: string) {
  const data = await api<{ user: AuthUser }>(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, confirmPassword }),
  });
  return mapUser(data.user);
}

export async function setBackendUserActive(userId: string, active: boolean) {
  const suffix = active ? "enable" : "disable";
  const data = await api<{ user: AuthUser }>(`/api/users/${encodeURIComponent(userId)}/${suffix}`, { method: "POST" });
  return mapUser(data.user);
}

export async function fetchBackendModels() {
  const data = await api<{ models: BackendWorkflowModel[] }>("/api/models");
  return data.models.map(mapModel);
}

export async function fetchBackendProjects() {
  const data = await api<{ projects: Project[] }>("/api/projects");
  return data.projects.map(mapProject);
}

export async function createBackendProject(project: Project) {
  const data = await api<{ project: Project }>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  return mapProject(data.project);
}

export async function updateBackendProject(project: Project) {
  const data = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  return mapProject(data.project);
}

export async function createBackendProjectFolder(projectId: string, name: string, parentId?: string | null) {
  const data = await api<{ folder: NonNullable<Project["folders"]>[number]; project?: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/folders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    },
  );
  return {
    folder: data.folder,
    project: data.project ? mapProject(data.project) : undefined,
  };
}

export async function renameBackendProjectFolder(projectId: string, folderId: string, name: string) {
  const data = await api<{ folder: NonNullable<Project["folders"]>[number]; project?: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  return {
    folder: data.folder,
    project: data.project ? mapProject(data.project) : undefined,
  };
}

export async function deleteBackendProjectFolder(projectId: string, folderId: string) {
  const data = await api<{ folder: NonNullable<Project["folders"]>[number]; project?: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
  return {
    folder: data.folder,
    project: data.project ? mapProject(data.project) : undefined,
  };
}

export async function fetchBackendJobs(params: FetchBackendJobsParams = {}): Promise<BackendJobsPage> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const suffix = search.size ? `?${search.toString()}` : "";
  const data = await api<BackendJobsResponse>(`/api/jobs${suffix}`);
  const jobs = data.jobs.map(mapJob);

  return {
    jobs,
    total: data.total ?? jobs.length,
    limit: data.limit ?? jobs.length,
    offset: data.offset ?? 0,
    hasMore: data.hasMore ?? false,
  };
}

export async function fetchBackendCredits() {
  return api<{ creditsLeft: number | null; creditsUsed?: number; currency?: string; updatedAt?: string; source: string }>("/api/credits");
}

export async function fetchBackendMonthlyUsage() {
  return api<BackendMonthlyUsage>("/api/usage/monthly");
}

export async function fetchBackendCreditDashboard(params?: { range?: string; from?: string; to?: string }) {
  const search = new URLSearchParams();
  if (params?.range) search.set("range", params.range);
  if (params?.from) search.set("from", params.from);
  if (params?.to) search.set("to", params.to);
  const suffix = search.size ? `?${search.toString()}` : "";
  const data = await api<{ dashboard: BackendCreditDashboard }>(`/api/credits/dashboard${suffix}`);
  return data.dashboard;
}

export async function fetchBackendRuntime() {
  return api<BackendRuntime>("/api/runtime");
}

export async function fetchPodStatus() {
  const data = await api<{ status: PodStatusResponse }>("/api/pods/status");
  return data.status;
}

export async function fetchComfyServers() {
  const data = await api<{ servers: ComfyServer[] }>("/api/comfy/servers");
  return data.servers;
}

export async function runComfyPoolAction(action: ComfyPoolAction, port?: number) {
  return api<ComfyPoolActionResult>("/api/comfy/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, port }),
  });
}

export async function createBackendJob(payload: {
  projectId: string;
  targetFolderId?: string | null;
  modelId: string;
  prompt?: string;
  resolution: { width: number; height: number; label?: string };
  durationSeconds?: number;
  inputImages?: string[];
  startFrame?: string;
  endFrame?: string;
  inputVideo?: string;
  workflowOptions?: WorkflowOptions;
}) {
  const data = await api<{ job: BackendJob }>("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return mapJob(data.job);
}

export async function uploadBackendMedia(media: Blob, options: { projectId: string; kind: "image" | "video"; name?: string }) {
  const search = new URLSearchParams({
    projectId: options.projectId,
    kind: options.kind,
  });
  if (options.name) search.set("name", options.name);

  const headers = new Headers();
  if (media.type) headers.set("Content-Type", media.type);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}/api/media/upload?${search.toString()}`, {
    method: "POST",
    headers,
    body: media,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res));
  }
  const data = await res.json() as { url: string };
  return data.url;
}

export async function renameBackendJob(projectId: string, jobId: string, title: string) {
  const data = await api<{ job: BackendJob }>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  return mapJob(data.job);
}

export async function updateBackendJobSaveNumber(projectId: string, jobId: string, saveNumber: string) {
  const data = await api<{ job: BackendJob }>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/save-number`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saveNumber }),
    },
  );
  return mapJob(data.job);
}

export async function moveBackendJobResult(projectId: string, jobId: string, destinationFolderId: string | null) {
  const data = await api<{ job: BackendJob }>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/folder`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationFolderId }),
    },
  );
  return mapJob(data.job);
}

export async function archiveBackendJob(jobId: string) {
  const data = await api<{ job: BackendJob }>(`/api/jobs/${encodeURIComponent(jobId)}/archive`, { method: "POST" });
  return mapJob(data.job);
}

export async function restoreBackendJob(jobId: string) {
  const data = await api<{ job: BackendJob }>(`/api/jobs/${encodeURIComponent(jobId)}/restore`, { method: "POST" });
  return mapJob(data.job);
}

export async function permanentlyDeleteBackendJob(jobId: string) {
  const data = await api<{ job: BackendJob }>(`/api/jobs/${encodeURIComponent(jobId)}/permanent`, { method: "DELETE" });
  return mapJob(data.job);
}

export function backendResultFileUrl(jobId: string, index = 0) {
  const suffix = index > 0 ? `?${new URLSearchParams({ index: String(index) }).toString()}` : "";
  return withMediaAccessToken(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/result-file${suffix}`);
}

export function backendResultMediaUrl(jobId: string, index = 0) {
  const params = new URLSearchParams({ index: String(index) });
  return withMediaAccessToken(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/result-media?${params.toString()}`);
}

export async function fetchBackendClipboardImage() {
  const data = await api<{ image: BackendClipboardImage }>("/api/clipboard/image");
  return data.image;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res));
  }
  return (await res.json()) as T;
}

async function errorMessageFromResponse(res: Response) {
  try {
    const data = await res.json() as { error?: string };
    if (data.error) return data.error;
  } catch {
    // Fall back to the status text below.
  }
  return `${res.status} ${res.statusText}`;
}

function mapModel(model: BackendWorkflowModel): ModelType {
  const category = model.category.includes("video") ? "video" : model.category.includes("upscal") ? "upscale" : "image";
  const durationConfig = durationConfigForModel(model);
  const supportedResolutions = supportedResolutionsForModel(model);
  return {
    id: model.id,
    label: model.name,
    description: model.description ?? `ComfyUI workflow loaded from ${model.workflowPath}`,
    category,
    cost: Math.max(0, Math.round(model.estimatedCredits ?? 0)),
    estimatedTime: model.estimatedTime ?? "Queued",
    requiresTwoImages: model.requiresStartEndFrames,
    requiresLandscape: category === "video",
    supportsAudio: category === "video",
    requiresPrompt: model.requiresPrompt,
    requiresImage: model.requiresImage,
    requiresVideo: model.requiredInputs.includes("video"),
    imageSlotCount: model.imageSlotCount ?? inferImageSlotCount(model),
    backendCategory: model.category,
    workflowPath: model.workflowPath,
    supportedResolutions,
    supportedDurations: durationConfig.supportedDurations,
    defaultDurationSeconds: durationConfig.defaultDurationSeconds,
  };
}

function supportedResolutionsForModel(model: BackendWorkflowModel) {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  if (key.includes("nano") && key.includes("banana")) {
    return ["1K", "2K", "4K"];
  }
  if ((key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid")) {
    return [
      "auto",
      "1024x1024",
      "1024x1536",
      "1536x1024",
      "2048x2048",
      "2048x1152",
      "1152x2048",
      "3840x2160",
      "2160x3840",
    ];
  }
  if (key.includes("kling") && key.includes("video_edit")) {
    return ["720p", "1080p"];
  }
  return model.supportedResolutions?.length ? model.supportedResolutions : ["720p", "1080p", "4K"];
}

function inferImageSlotCount(model: BackendWorkflowModel) {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  if (model.requiresStartEndFrames) return 2;
  if (key.includes("openai_gpt_image_2_i2i")) return 5;
  if (key.includes("nano") && key.includes("banana")) return 3;
  if (key.includes("ref_transfer")) return 2;
  if (key.includes("exteriorgrid")) return 1;
  return model.requiresImage ? 1 : 0;
}

function durationConfigForModel(model: BackendWorkflowModel) {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  if (key.includes("kling_v3_flf2v")) {
    return { supportedDurations: range(3, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("seedance") && key.includes("flf2v")) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("veo3") && key.includes("flf2v")) {
    return { supportedDurations: [4, 6, 8], defaultDurationSeconds: 6 };
  }
  if (key.includes("kling_v2_6_video") || key.includes("kling_v2.6_video")) {
    return { supportedDurations: [5, 10], defaultDurationSeconds: 5 };
  }
  if (key.includes("kling_v3_video")) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("seedance") && (key.includes("i2v") || key.includes("r2v"))) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("veo3") && key.includes("i2v")) {
    return { supportedDurations: [4, 6, 8], defaultDurationSeconds: 4 };
  }
  return {
    supportedDurations: model.supportedDurations,
    defaultDurationSeconds: model.defaultDurationSeconds,
  };
}

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function mapJob(job: BackendJob): Job {
  const resolution = job.resolution?.label ?? (job.resolution ? `${job.resolution.width} x ${job.resolution.height}` : "Unknown");
  const outputResolution = normalizeResolution(job.outputResolution);
  const shouldProxyResults = job.source !== "existing_project_media";
  const resultUrls = shouldProxyResults
    ? job.resultUrls.map((_, index) => backendResultMediaUrl(job.id, index))
    : job.resultUrls.map(resolveMediaUrl);
  const thumbnailUrls = job.thumbnailUrls.map(resolveMediaUrl);
  const inputImages = job.inputImages.map(resolveMediaUrl);
  const inputVideo = job.inputVideo ? resolveMediaUrl(job.inputVideo) : undefined;
  const resultUrl = resultUrls[0] ?? thumbnailUrls[0];
  return {
    id: job.id,
    projectId: job.projectId,
    folderId: job.folderId ?? null,
    folderName: job.folderName,
    userId: job.userId,
    modelId: job.modelId,
    modelType: job.modelName,
    title: job.title,
    backendCategory: job.category,
    workflowPath: job.workflowPath,
    inputType: job.inputType,
    prompt: job.prompt ?? "",
    resolution,
    outputResolution,
    durationSeconds: job.durationSeconds,
    workflowOptions: job.workflowOptions,
    status: job.status,
    inputImages,
    inputVideo,
    resultUrls,
    resultUrl,
    thumbnailUrls,
    thumbnailUrl: thumbnailUrls[0] ?? resultUrl,
    outputType: job.outputType,
    fileName: job.fileName,
    generatedPrompt: job.generatedPrompt,
    textArtifacts: job.textArtifacts,
    creditsEstimated: job.creditsEstimated,
    creditsActual: job.creditsActual,
    creditsActualSource: job.creditsActualSource,
    creditBalanceBefore: job.creditBalanceBefore,
    creditBalanceAfter: job.creditBalanceAfter,
    source: job.source,
    missingMetadata: job.missingMetadata,
    archivedAt: job.archivedAt,
    archivedBy: job.archivedBy,
    videoLength: job.durationSeconds ? `${job.durationSeconds} seconds` : job.outputType === "video" ? "Backend video" : job.outputType === "sequence" ? "Image sequence" : undefined,
    creditsUsed: mappedCreditsUsed(job),
    creditUsage: job.creditUsage,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    generationTime: generationTimeForJob(job),
  };
}

function mappedCreditsUsed(job: BackendJob) {
  // Measured values (balance delta or counted usage) are trusted even at 0 so
  // genuinely free jobs show "Credits: 0" instead of falling back to the
  // estimate label. Legacy stored values without usage data keep requiring > 0
  // because 0 there historically meant "unknown".
  const actualCredits = nonNegativeNumber(job.creditsActual);
  if (actualCredits != null) return actualCredits;
  if (isCountedCreditUsage(job.creditUsage)) return nonNegativeNumber(job.creditsUsed) ?? nonNegativeNumber(job.creditUsage?.total_estimated_credits);
  if (!job.creditUsage) return positiveNumber(job.creditsUsed);
  return undefined;
}

function isCountedCreditUsage(creditUsage?: Job["creditUsage"]) {
  const source = (creditUsage?.source ?? "").trim().toLowerCase();
  return Boolean(creditUsage && source !== "local_kling_estimate" && !(source.startsWith("local_") && source.includes("estimate")));
}

function positiveNumber(value: unknown) {
  const number = nonNegativeNumber(value);
  return number != null && number > 0 ? number : undefined;
}

function nonNegativeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  return undefined;
}

function normalizeResolution(value?: MediaResolution) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return undefined;
  const width = Math.round(value.width);
  const height = Math.round(value.height);
  if (width <= 0 || height <= 0) return undefined;
  return {
    width,
    height,
    label: value.label,
  };
}

function mapProject(project: Project): Project {
  return {
    ...project,
    folders: Array.isArray(project.folders) ? project.folders : [],
    memberCount: project.members.length + project.groupMembers.length,
    visibility: project.visibility ?? "team",
  };
}

function mapUser(user: AuthUser): AuthUser {
  return {
    ...user,
    name: user.displayName ?? user.name,
    displayName: user.displayName ?? user.name,
    avatar: user.avatar ?? initialsFor(user.displayName ?? user.name),
    avatarColor: user.avatarColor ?? "#11b8a5",
    pinnedProjectIds: Array.isArray(user.pinnedProjectIds) ? user.pinnedProjectIds.filter((item): item is string => typeof item === "string") : [],
  };
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "US";
}

function generationTimeForJob(job: BackendJob) {
  if (job.source === "existing_project_media") return undefined;
  if (job.status === "queued") return "queued";
  if (job.status === "sending") return "sending";
  if (job.status === "running") return "running";

  const startedAt = parseDate(job.startedAt ?? job.createdAt);
  const completedAt = parseDate(job.completedAt);
  if (startedAt == null || completedAt == null || completedAt < startedAt) {
    return job.status === "completed" ? undefined : job.status;
  }

  return formatDuration(completedAt - startedAt);
}

function parseDate(value: string | undefined) {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds} sec`;
  if (!seconds) return `${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}

function resolveMediaUrl(url: string) {
  if (url.startsWith("/api/")) return withMediaAccessToken(`${API_BASE}${url}`);
  return url;
}

function withMediaAccessToken(url: string) {
  const token = getStoredAuthToken();
  if (!token || url.includes("access_token=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}
