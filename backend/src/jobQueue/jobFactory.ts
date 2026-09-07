import crypto from "node:crypto";

import { estimateWorkflowCredits } from "../creditEstimator.js";
import { folderDisplayName } from "../projectMetadataService.js";
import type { CreateJobRequest, Job, Project, ProjectFolder, Resolution, WorkflowModel } from "../types.js";
import { inferInputType, normalizeDurationSeconds } from "./mediaExternalization.js";

export type JobFactoryDependencies = {
  getWorkflowModel: (id: string) => WorkflowModel | undefined;
  getProject: (id: string) => Project | undefined;
  externalizeInputMedia: (project: Project, jobId: string, request: CreateJobRequest) => Promise<CreateJobRequest>;
  loadProjectFolders: (project: Project) => Promise<ProjectFolder[]>;
  createJobId?: () => string;
  now?: () => string;
  /**
   * Measures an input image so the estimate can scale with it.
   *
   * Still image presets carry no `resolution`: the field is client-supplied and
   * only video work sends one. The tiled upscaler is priced by output area
   * though, so without this its quote is a constant that has been wrong by up to
   * forty times. Injected rather than imported so the estimate stays testable
   * without a filesystem, and optional so a caller that cannot measure still
   * gets a job -- it just gets the flat quote.
   */
  detectSourceResolution?: (reference: string) => Promise<Resolution | undefined>;
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
  // Only for the estimate, and deliberately not written to the job. `resolution`
  // means the output size everywhere else it is read -- the credit dashboard
  // groups spend by it -- and a source size stored in that field would be a
  // different quantity wearing the same name.
  const estimateResolution = await sourceResolutionForEstimate(model, preparedRequest, deps);
  if (targetFolderId && !projectFolders.some((folder) => folder.folderId === targetFolderId && !folder.archived)) {
    throw new Error("Target folder not found.");
  }

  return {
    id: jobId,
    clientRequestId: preparedRequest.clientRequestId,
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
      preparedRequest.resolution ?? estimateResolution,
      preparedRequest.workflowOptions,
    ),
    source: "backend_job",
    createdAt: deps.now?.() ?? new Date().toISOString(),
  };
}

/**
 * The source size an estimate needs, when the model's price depends on it.
 *
 * Narrow on purpose: measuring every submission would put a file read in front of
 * every job for the benefit of the one preset whose quote uses it. A failed
 * measurement is not an error either -- the estimate falls back to the model's
 * flat number, which is what every other still image preset uses anyway.
 */
async function sourceResolutionForEstimate(
  model: WorkflowModel,
  request: CreateJobRequest,
  deps: JobFactoryDependencies,
): Promise<Resolution | undefined> {
  if (!deps.detectSourceResolution) return undefined;
  if (!model.id.includes("flux-klein-upscaler")) return undefined;

  const source = request.inputImages?.[0];
  if (!source) return undefined;

  try {
    return await deps.detectSourceResolution(source);
  } catch {
    return undefined;
  }
}
