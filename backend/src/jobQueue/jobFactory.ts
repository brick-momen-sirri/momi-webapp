import crypto from "node:crypto";

import { estimateWorkflowCredits } from "../creditEstimator.js";
import { folderDisplayName } from "../projectMetadataService.js";
import type { CreateJobRequest, Job, Project, ProjectFolder, WorkflowModel } from "../types.js";
import { inferInputType, normalizeDurationSeconds } from "./mediaExternalization.js";

export type JobFactoryDependencies = {
  getWorkflowModel: (id: string) => WorkflowModel | undefined;
  getProject: (id: string) => Project | undefined;
  externalizeInputMedia: (project: Project, jobId: string, request: CreateJobRequest) => Promise<CreateJobRequest>;
  loadProjectFolders: (project: Project) => Promise<ProjectFolder[]>;
  createJobId?: () => string;
  now?: () => string;
};

export async function buildQueuedJob(request: CreateJobRequest, deps: JobFactoryDependencies): Promise<Job> {
  const model = deps.getWorkflowModel(request.modelId);
  if (!model) throw new Error(`Unknown workflow model: ${request.modelId}`);
  const project = deps.getProject(request.projectId);
  if (!project) throw new Error(`Unknown project: ${request.projectId}`);

  const jobId = deps.createJobId?.() ?? `job_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const preparedRequest = await deps.externalizeInputMedia(project, jobId, request);
  const durationSeconds = normalizeDurationSeconds(request.durationSeconds, model);
  const targetFolderId =
    typeof request.targetFolderId === "string" && request.targetFolderId.trim() ? request.targetFolderId.trim() : null;
  const projectFolders = await deps.loadProjectFolders(project);
  if (targetFolderId && !projectFolders.some((folder) => folder.folderId === targetFolderId && !folder.archived)) {
    throw new Error("Target folder not found.");
  }

  return {
    id: jobId,
    projectId: project.id,
    folderId: targetFolderId,
    folderName: folderDisplayName(targetFolderId, projectFolders),
    userId: preparedRequest.userId,
    modelId: model.id,
    modelName: model.name,
    title: model.name,
    category: model.category,
    inputType: inferInputType(preparedRequest),
    prompt: preparedRequest.prompt,
    resolution: preparedRequest.resolution,
    durationSeconds,
    workflowOptions: preparedRequest.workflowOptions,
    status: "queued",
    inputImages:
      preparedRequest.inputImages ?? ([preparedRequest.startFrame, preparedRequest.endFrame].filter(Boolean) as string[]),
    inputVideo: preparedRequest.inputVideo,
    resultUrls: [],
    thumbnailUrls: [],
    outputType: model.outputType,
    projectFolderPath: project.folderPath,
    workflowPath: model.workflowPath,
    creditsEstimated: estimateWorkflowCredits(
      model,
      durationSeconds,
      preparedRequest.resolution,
      preparedRequest.workflowOptions,
    ),
    source: "backend_job",
    createdAt: deps.now?.() ?? new Date().toISOString(),
  };
}
