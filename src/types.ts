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
  status: JobStatus;
  inputImages: string[];
  inputVideo?: string;
  resultUrl?: string;
  resultUrls?: string[];
  thumbnailUrl?: string;
  thumbnailUrls?: string[];
  outputType?: "image" | "video" | "sequence";
  fileName?: string;
  generatedPrompt?: string;
  textArtifacts?: JobTextArtifact[];
  source?: "backend_job" | "existing_project_media";
  missingMetadata?: string[];
  archivedAt?: string;
  archivedBy?: string;
  durationSeconds?: number;
  workflowOptions?: WorkflowOptions;
  videoLength?: string;
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
  save?: {
    cameraNumber?: string;
    shotNumber?: string;
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
