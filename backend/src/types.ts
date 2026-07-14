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
  | "prompt"
  | "single_image"
  | "start_frame"
  | "end_frame"
  | "video"
  | "mask"
  | "resolution"
  | "seed";

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

export type ArchVizGridOptions = {
  slotCount?: "1" | "2" | "4" | "6" | "8" | "9";
  useSmartDefaults?: boolean;
  cameraSlots?: string[];
};

export type WorkflowOptions = {
  archVizGrid?: ArchVizGridOptions;
  nanoBanana?: {
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

export type CreateJobRequest = {
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

export type Job = {
  id: string;
  comfyPromptId?: string;
  comfyServerUrl?: string;
  runpodJobId?: string;
  runpodStatus?: string;
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
  status: JobStatus;
  inputImages: string[];
  inputVideo?: string;
  resultUrls: string[];
  thumbnailUrls: string[];
  outputType: "image" | "video" | "sequence";
  projectFolderPath: string;
  workflowPath: string;
  workflowSnapshotPath?: string;
  creditsEstimated?: number;
  creditsUsed?: number;
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
