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
   * Comes from the worker's own progress reporting, mapped from the ComfyUI node
   * id it names. Absent for workers that emit nothing, and for every phase
   * outside the render itself.
   */
  detail?: string;
  /** Where the current step has got to, when the worker counts it. */
  stepDone?: number;
  stepTotal?: number;
  /**
   * Which item those steps belong to. Enhancement works one tile at a time and
   * restarts its step counter for each, so without this the numbers read as
   * going backwards.
   */
  item?: number;
  /**
   * The steps already finished, oldest first.
   *
   * A trail rather than a plan: it lists what the worker has actually done, not
   * what it is expected to do next. The graph branches on the enhancement, body
   * and face toggles, so the remaining steps are genuinely not known in advance
   * -- and a checklist that guessed them would mislead exactly when a run takes
   * an unusual path. Bounded, because it is carried on every job payload.
   */
  completedSteps?: string[];
  phaseStartedAt: string;
};

/**
 * RunPod's own account of a finished run.
 *
 * Written from the last poll that reported each figure, terminal poll included --
 * `executionTime` is only final once the job leaves IN_PROGRESS.
 */
export type RunpodJobTiming = {
  /** Worker time on the job. The billable part, and what pod pricing multiplies. */
  executionMs?: number;
  /** How long RunPod held the job before a worker took it. Queue wait, not spend. */
  delayMs?: number;
  /** Which worker ran it, for tracing a slow or broken pod. */
  workerId?: string;
  /**
   * The GPU that worker turned out to have, resolved from its id while the run was
   * still in flight (runpodWorkerGpu). What podRuntimeCost prices against: an
   * endpoint accepts several GPU classes and the worker picks, so the same preset
   * costs 2.2x more on one than another.
   *
   * Absent when the lookup could not answer -- a worker already torn down, or no
   * RunPod API key -- which leaves the run uncosted rather than priced from a guess.
   */
  gpuTypeId?: string;
  /**
   * That worker's own hourly rate, as it reported it.
   *
   * Recorded for reference and deliberately not billed against: it reads low. A PRO
   * 6000 MIG worker reported 0.59/h where billing charged 0.656-0.675/h for the same
   * GPU. The rate table in podRuntimeCost, derived from invoices, is authoritative.
   */
  gpuCostPerHr?: number;
  /**
   * The rate this run was actually priced at, in USD per second.
   *
   * Written only when a cost was recorded. Seconds, GPU and rate together make the
   * figure on the card checkable, and re-derivable after RunPod reprices a GPU.
   */
  usdPerSecond?: number;
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
  /**
   * What RunPod reported about the run itself, kept after it finished.
   *
   * runpodProgress carries the same numbers while a job is in flight, but it is
   * deleted on completion -- a finished card must not claim a worker is still busy
   * on it. These are the durable copies: `executionMs` is what podRuntimeCost
   * prices for the Still Images presets, and `delayMs` and `workerId` are what an
   * operator needs to tell "the pod was slow" from "the queue was long".
   */
  runpodTiming?: RunpodJobTiming;
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
