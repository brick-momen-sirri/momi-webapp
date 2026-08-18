export type User = {
  id: string;
  username?: string;
  name: string;
  displayName?: string;
  email?: string;
  role?: "admin" | "user";
  active?: boolean;
  avatar?: string;
  avatarColor?: string;
  profileImageUrl?: string;
  pinnedProjectIds?: string[];
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
};

export type Team = {
  id: string;
  name: string;
  users: User[];
};

export type ProjectRole = "owner" | "editor" | "viewer";

export type ProjectMember = {
  userId: string;
  role: ProjectRole;
  addedAt: string;
  addedBy: string;
};

export type ProjectGroupMember = {
  groupId: string;
  role: Exclude<ProjectRole, "owner">;
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
  folderPath?: string;
  ownerId: string;
  members: ProjectMember[];
  groupMembers: ProjectGroupMember[];
  folders?: ProjectFolder[];
  jobCount: number;
  creditsUsed?: number;
  monthCreditsUsed?: number;
  memberCount: number;
  unreadCount?: number;
  createdAt: string;
  visibility: "private" | "team" | "public";
};

export type JobStatus = "queued" | "sending" | "running" | "completed" | "failed" | "canceled";

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

export type MediaResolution = {
  width: number;
  height: number;
  label?: string;
};

/**
 * What a running job is doing right now. Mirrors RunpodJobProgress on the
 * backend; every field is observed rather than estimated, and there is
 * deliberately no percentage -- the pods report nothing from inside the worker,
 * so any completion figure would be invented.
 */
export type RunpodJobProgress = {
  phase: "preparing" | "submitting" | "queued" | "running" | "saving";
  runpodStatus?: string;
  workerId?: string;
  delayMs?: number;
  /** What the worker last reported doing, e.g. "Sampling tiles". */
  detail?: string;
  stepDone?: number;
  stepTotal?: number;
  /** Which item the steps belong to, for nodes that work through a batch. */
  item?: number;
  /** Steps already finished, oldest first. A record, not a forecast. */
  completedSteps?: string[];
  phaseStartedAt: string;
};

export type Job = {
  id: string;
  projectId: string;
  folderId?: string | null;
  folderName?: string;
  userId: string;
  modelId?: string;
  modelType: string;
  title?: string;
  backendCategory?: string;
  workflowPath?: string;
  inputType: "single_image" | "multi_image" | "start_end_frames" | "text_only" | "video";
  prompt: string;
  resolution: string;
  outputResolution?: MediaResolution;
  /** Size of the result on disk, in bytes. Absent on jobs that predate recording it. */
  outputBytes?: number;
  status: JobStatus;
  /**
   * A cancellation has been asked for but the dispatcher has not settled it yet.
   *
   * Set the moment the API accepts the request, while the job is usually still
   * `running`: the dispatcher observes the flag on its next poll, which is where
   * the remote RunPod job is actually stopped. So "Canceling" comes from this and
   * "Canceled" from the status.
   */
  cancelRequested?: boolean;
  inputImages: string[];
  inputVideo?: string;
  resultUrl?: string;
  resultUrls?: string[];
  /**
   * The same results as saved project media, for submitting as an input.
   *
   * resultUrls above are rewritten to /api/jobs/:id/result-media so the browser
   * fetches them through the backend with a media token. That form is for display
   * only -- the job pipeline cannot resolve it to a file, so submitting one is
   * rejected as a remote URL. These are the durable /api/media?path= values the
   * backend stored, which is what a chained input has to carry.
   */
  resultSourceUrls?: string[];
  thumbnailUrl?: string;
  thumbnailUrls?: string[];
  outputType?: "image" | "video" | "sequence";
  fileName?: string;
  generatedPrompt?: string;
  textArtifacts?: JobTextArtifact[];
  source?: "backend_job" | "existing_project_media";
  missingMetadata?: string[];
  hasUnsavedRemoteMedia?: boolean;
  archivedAt?: string;
  archivedBy?: string;
  durationSeconds?: number;
  workflowOptions?: WorkflowOptions;
  videoLength?: string;
  runpodProgress?: RunpodJobProgress;
  /**
   * What RunPod reported about the run, kept after it finished.
   *
   * `executionMs` is the billed part -- worker time -- and is what the backend
   * prices a Still Images preset from. `delayMs` is queue wait, which nobody pays
   * for; the two together are how a slow pod is told from a long queue.
   */
  runpodTiming?: {
    executionMs?: number;
    delayMs?: number;
    workerId?: string;
    /** The GPU the worker turned out to have, which is what set the rate. */
    gpuTypeId?: string;
    gpuCostPerHr?: number;
    /** USD per second the run was priced at, present only once it was costed. */
    usdPerSecond?: number;
  };
  creditsEstimated?: number;
  creditsUsed?: number;
  creditsActual?: number;
  creditsActualSource?: string;
  creditBalanceBefore?: CreditBalanceSnapshot;
  creditBalanceAfter?: CreditBalanceSnapshot;
  creditUsage?: CreditUsageSummary;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  generationTime?: string;
};

export type ArchVizGridOptions = {
  slotCount: "1" | "2" | "4" | "6" | "8" | "9";
  useSmartDefaults: boolean;
  cameraSlots: string[];
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
  // Output aspect ratio for the Seedance 2.x video nodes. "adaptive" lets the model
  // keep the reference frame's own aspect instead of forcing a grid ratio.
  seedance?: {
    ratio?: string;
  };
  save?: {
    cameraNumber?: string;
    shotNumber?: string;
  };
  // Present only on jobs submitted from the Still Images workspace. Its presence is
  // what the backend reads to route the job to that preset's own pod, so it must
  // never be set on an Animation job.
  stillImage?: {
    categoryId: string;
    /**
     * The master seed the preset's samplers were derived from. Submitting it
     * again with the same settings and inputs reproduces the render; omitting it
     * asks the server to mint one. Absent on jobs submitted before seeds were
     * persisted.
     */
    seed?: number;
    settings: Record<string, string | number | boolean>;
  };
};

export type ModelType = {
  id: string;
  label: string;
  description: string;
  category: "image" | "video" | "upscale";
  cost: number;
  costLabel?: string;
  estimatedTime: string;
  requiresTwoImages?: boolean;
  requiresLandscape?: boolean;
  supportsAudio?: boolean;
  requiresPrompt?: boolean;
  requiresImage?: boolean;
  requiresVideo?: boolean;
  imageSlotCount?: number;
  backendCategory?: string;
  workflowPath?: string;
  supportedResolutions?: string[];
  supportedDurations?: number[];
  defaultDurationSeconds?: number;
};

export type UploadedImage = {
  id: string;
  name: string;
  url: string;
  /**
   * What an upload slot should display, when that is not the same thing as what
   * should be submitted.
   *
   * Set when `url` names saved media that is too large to put in a 200px slot --
   * a still image result chained into the next preset is a 4K-10K PNG, and
   * showing the original there would decode a hundred megabytes to fill a
   * thumbnail. Locally chosen files have no need for it: their `url` is already
   * a local object URL.
   */
  previewUrl?: string;
  croppedUrl?: string;
  cropRequired?: boolean;
  cropSettings?: {
    scale: number;
    offsetX: number;
    offsetY: number;
    aspectRatio: number;
    outputWidth?: number;
    outputHeight?: number;
  };
  cropWidth?: number;
  cropHeight?: number;
  width?: number;
  height?: number;
};

export type UploadedVideo = {
  id: string;
  name: string;
  url: string;
  size?: number;
  durationSeconds?: number;
};

export type FeedFilter = "all" | "mine" | "completed" | "failed" | "video" | "image" | "favorites";
