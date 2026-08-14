import type { StillImageOptions } from "./stillImageCategories.js";

export type ComfyServerStatus = "offline" | "idle" | "busy" | "error";

export type JobStatus = "queued" | "sending" | "running" | "completed" | "failed" | "canceled";

export type ModelCategory =
  | "image_generation"
  | "image_editing"
  | "image_upscaling"
  | "image_to_video"
  | "first_last_frame_to_video"
  | "video_editing"
  | "video_upscaling"
  | "utility";

export type WorkflowRequiredInput =
  "prompt" | "single_image" | "start_frame" | "end_frame" | "video" | "mask" | "resolution" | "seed";

export type WorkflowModel = {
  id: string;
  name: string;
  category: ModelCategory;
  workflowPath: string;
  description?: string;
  requiredInputs: WorkflowRequiredInput[];
  supportedResolutions?: string[];
  defaultResolution?: string;
  supportedDurations?: number[];
  defaultDurationSeconds?: number;
  requiresPrompt: boolean;
  requiresImage: boolean;
  requiresStartEndFrames: boolean;
  imageSlotCount?: number;
  outputType: "image" | "video" | "sequence";
  estimatedCredits?: number;
  estimatedTime?: string;
};

export type WorkflowInputMapping = {
  promptNodeIds?: string[];
  imageInputNodeIds?: string[];
  startFrameNodeIds?: string[];
  endFrameNodeIds?: string[];
  videoInputNodeIds?: string[];
  widthNodeIds?: string[];
  heightNodeIds?: string[];
  durationNodeIds?: string[];
  seedNodeIds?: string[];
  outputPathNodeIds?: string[];
  projectNameNodeIds?: string[];
};

export type UserRole = "admin" | "user";

export type User = {
  id: string;
  username?: string;
  name: string;
  displayName: string;
  email: string;
  role: UserRole;
  active: boolean;
  avatar?: string;
  avatarColor?: string;
  profileImageUrl?: string;
  pinnedProjectIds?: string[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type StoredUser = User & {
  passwordHash: string;
};

export type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
};

export type ProjectMember = {
  userId: string;
  role: "owner" | "editor" | "viewer";
  addedAt: string;
  addedBy: string;
};

export type ProjectVisibility = "private" | "team" | "public";

export type ProjectGroupMember = {
  groupId: string;
  role: "editor" | "viewer";
  addedAt: string;
  addedBy: string;
};

export type ProjectFolder = {
  folderId: string;
  parentId: string | null;
  name: string;
  slug: string;
  diskName: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  archived: boolean;
};

export type ProjectMetadata = {
  version: 1;
  projectId: string;
  code: string;
  client: string;
  name: string;
  displayName: string;
  diskName: string;
  createdAt: string;
  updatedAt: string;
  renamedFrom: string[];
};

export type Project = {
  id: string;
  name: string;
  shortName: string;
  code?: string;
  client?: string;
  displayName?: string;
  diskName?: string;
  folderName?: string;
  isDefault?: boolean;
  description?: string;
  folderPath: string;
  ownerId: string;
  visibility?: ProjectVisibility;
  members: ProjectMember[];
  groupMembers: ProjectGroupMember[];
  folders?: ProjectFolder[];
  jobCount: number;
  creditsUsed?: number;
  monthCreditsUsed?: number;
  createdAt: string;
  updatedAt: string;
};

export type Resolution = {
  width: number;
  height: number;
  label?: string;
};

export type CreditUsageRow = {
  node_id?: string;
  node_title?: string;
  class_type?: string;
  total_estimated_credits?: number;
  total_estimated_usd?: number;
  source?: string;
  status?: string;
  [key: string]: unknown;
};

export type CreditUsageSummary = {
  total_estimated_credits: number;
  total_estimated_usd?: number;
  source: string;
  rows?: CreditUsageRow[];
};

export type CreditBalanceSnapshot = {
  creditsLeft: number;
  source: string;
  capturedAt: string;
};

export type JobTextArtifact = {
  text: string;
  filename?: string;
  type?: string;
  source: string;
  url?: string;
};

export type ArchVizGridOptions = {
  slotCount?: "1" | "2" | "4" | "6" | "8" | "9";
  useSmartDefaults?: boolean;
  cameraSlots?: string[];
};

export type WorkflowOptions = {
  archVizGrid?: ArchVizGridOptions;
  nanoBanana?: {
    aspectRatio?: string;
    outputCount?: 1 | 2;
  };
  gptImage?: {
    outputCount?: 1 | 2;
  };
  save?: {
    cameraNumber?: string;
    shotNumber?: string;
  };
  // Present exactly on jobs submitted from the Still Images workspace. Its
  // presence is what jobSection() reads to tell the two workspaces apart, so it
  // must never be set on an Animation job.
  stillImage?: StillImageOptions;
};

export type CreateJobRequest = {
  clientRequestId?: string;
  projectId: string;
  targetFolderId?: string | null;
  modelId: string;
  prompt?: string;
  resolution?: Resolution;
  durationSeconds?: number;
  inputImages?: string[];
  startFrame?: string;
  endFrame?: string;
  inputVideo?: string;
  workflowOptions?: WorkflowOptions;
  userId: string;
};

/**
 * What a running job is actually doing, for the waiting UI.
 *
 * Every field here is observed, never estimated. RunPod's serverless API reports
 * a job's status plus how long it queued and how long it has executed, and our
 * own pipeline knows what it is doing either side of that. What is deliberately
 * absent is anything from *inside* the worker -- loading models, sampling steps,
 * uploading the result. These pods are not generator handlers (their /stream is
 * empty), so ComfyUI's progress never leaves the container. Showing a stage the
 * worker never reported would be a guess dressed as a fact, so there is no
 * percentage here at all: the UI shows the phase and how long it has been in it.
 *
 * `phaseStartedAt` exists so the client can tick the elapsed time itself. The
 * alternative -- writing a counter on every poll -- would put a database write
 * per job per few seconds behind a purely cosmetic number.
 */
export type RunpodJobProgress = {
  phase: "preparing" | "submitting" | "queued" | "running" | "saving";
  /** RunPod's own status string (IN_QUEUE, IN_PROGRESS, ...) when there is one. */
  runpodStatus?: string;
  /** Which worker picked the job up. Only known once one has. */
  workerId?: string;
  /** How long RunPod held the job before a worker took it. */
  delayMs?: number;
  /**
   * What the worker last reported it was doing, e.g. "Sampling tiles".
   *
   * Comes from the worker's own progress stream, mapped from the ComfyUI node id
   * it names. Absent for workers that emit nothing, and for every phase outside
   * the render itself.
   */
  detail?: string;
  phaseStartedAt: string;
};

export type Job = {
  id: string;
  clientRequestId?: string;
  clientRequestHash?: string;
  comfyPromptId?: string;
  comfyServerUrl?: string;
  runpodJobId?: string;
  // The endpoint this job was submitted to, recorded because still image presets
  // each run on their own pod. Polling, resuming and cancelling must address the
  // endpoint that acknowledged the work, not whatever the config now resolves to.
  runpodEndpointId?: string;
  runpodStatus?: string;
  runpodSubmissionState?: "preparing" | "submitting" | "submitted";
  runpodProgress?: RunpodJobProgress;
  projectId: string;
  folderId?: string | null;
  folderName?: string;
  userId: string;
  modelId: string;
  modelName: string;
  title?: string;
  category: ModelCategory;
  inputType: "text_only" | "single_image" | "multi_image" | "start_end_frames" | "video";
  prompt?: string;
  resolution?: Resolution;
  outputResolution?: Resolution;
  durationSeconds?: number;
  workflowOptions?: WorkflowOptions;
  generatedPrompt?: string;
  textArtifacts?: JobTextArtifact[];
  status: JobStatus;
  cancelRequested?: boolean;
  inputImages: string[];
  inputVideo?: string;
  resultUrls: string[];
  /**
   * Which remote object each result came from, aligned with resultUrls.
   *
   * Identity only: the signature is stripped, so these are NOT fetchable. That is
   * deliberate. RunPod hands back a presigned S3 URL valid for 7 days, jobs are
   * serialized to the browser wholesale, and a presigned URL is a bearer
   * credential -- storing the signed form would hand every user a link that
   * bypasses the project permission checks and can be forwarded to anyone.
   *
   * Kept so a result can still be traced back to, or re-signed from, its origin
   * bucket. The durable way to read a result is resultUrls.
   */
  resultRemoteRefs?: string[];
  thumbnailUrls: string[];
  outputType: "image" | "video" | "sequence";
  projectFolderPath: string;
  workflowPath: string;
  workflowSnapshotPath?: string;
  creditsEstimated?: number;
  creditsUsed?: number;
  creditsActual?: number;
  creditsActualSource?: string;
  creditBalanceBefore?: CreditBalanceSnapshot;
  creditBalanceAfter?: CreditBalanceSnapshot;
  creditUsage?: CreditUsageSummary;
  errorMessage?: string;
  fileName?: string;
  source?: "backend_job" | "existing_project_media";
  missingMetadata?: string[];
  archivedAt?: string;
  archivedBy?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};
