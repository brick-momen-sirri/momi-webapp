import type { Job, MediaResolution, User, WorkflowOptions } from "../../types";

export type AuthUser = User & {
  email: string;
  displayName?: string;
  role: "admin" | "user";
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type AuthResult = { ok: true; account: AuthUser; token?: string } | { ok: false; error: string };

export type BackendWorkflowModel = {
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

export type BackendJob = {
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
  outputBytes?: number;
  durationSeconds?: number;
  workflowOptions?: WorkflowOptions;
  status: Job["status"];
  cancelRequested?: boolean;
  runpodProgress?: Job["runpodProgress"];
  runpodTiming?: Job["runpodTiming"];
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

export type FetchBackendJobsParams = {
  limit?: number;
  offset?: number;
  projectId?: string;
  folderId?: string;
  userId?: string;
  q?: string;
  status?: Job["status"];
  outputType?: Job["outputType"];
  archived?: boolean;
  /**
   * Narrows to one workspace. Unset returns both, which is what the shared job
   * list loads today -- StillImagesWorkspace filters that window client-side via
   * jobSection. Pass this to page a single section server-side instead.
   */
  section?: "animation" | "still_images";
};

export type BackendMonthlyUsage = {
  month: string;
  startAt: string;
  endAt: string;
  users: Array<{ userId: string; creditsSpent: number; jobsCompleted: number }>;
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

export type BackendCreditDashboardDay = { date: string; credits: number; usd: number; jobs: number };

export type BackendCreditDashboardGranularity = "day" | "week" | "month";

export type BackendCreditDashboardBucket = {
  key: string;
  label: string;
  startAt: string;
  endAt: string;
  credits: number;
  usd: number;
  /** Optional during a rolling deploy against an older API worker. */
  podCredits?: number;
  podUsd?: number;
  comfyCredits?: number;
  comfyUsd?: number;
  jobs: number;
};

// perBucket is index-aligned with the dashboard's buckets array.
export type BackendCreditDashboardBreakdownRow = {
  id: string;
  label: string;
  credits: number;
  usd: number;
  jobs: number;
  percentage: number;
  perBucket: number[];
};

export type BackendCreditDashboardBreakdown = {
  project: BackendCreditDashboardBreakdownRow[];
  user: BackendCreditDashboardBreakdownRow[];
  model: BackendCreditDashboardBreakdownRow[];
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
  /** Optional during a rolling deploy against an older API worker. */
  podCredits?: number;
  podUsd?: number;
  comfyCredits?: number;
  comfyUsd?: number;
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

export type BackendCreditDashboardRange = { preset: string; label: string; startAt: string; endAt: string };

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
    // Completed renders that consumed real provider balance but are absent from
    // every figure above, because their pods report no usage. Optional so a web
    // build that lands ahead of the API does not read undefined as a real zero.
    uncostedRuns?: number;
    uncostedMonthRuns?: number;
  };
  granularity: BackendCreditDashboardGranularity;
  byProject: BackendCreditDashboardGroup[];
  byUser: BackendCreditDashboardGroup[];
  byModel: BackendCreditDashboardGroup[];
  byDay: BackendCreditDashboardDay[];
  buckets: BackendCreditDashboardBucket[];
  breakdown: BackendCreditDashboardBreakdown;
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
      jobs: { queued: number; running: number; completed?: number; failed?: number };
    };
  };
  updatedAt: string;
};

export type ComfyServerStatus = "offline" | "idle" | "busy" | "error";
export type ComfyServer = { url: string; port?: number; status: ComfyServerStatus; lastChecked?: string; errorMessage?: string };
export type ComfyPoolAction = "start" | "stop" | "restart" | "start-safe" | "start-all" | "stop-all" | "open-manager";
export type ComfyPoolActionResult = {
  ok: true;
  action: ComfyPoolAction;
  port?: number;
  message: string;
  output?: string;
  errorOutput?: string;
  startedAt: string;
};

export type BackendClipboardImage = { name: string; type: string; dataUrl: string; source: string };

export type BackendSnapshot = {
  credits: { creditsLeft: number | null; creditsUsed?: number; currency?: string; updatedAt?: string; source: string } | null;
  monthlyUsage: BackendMonthlyUsage;
  runtime: BackendRuntime;
  podStatus: PodStatusResponse | null;
};
