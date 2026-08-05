import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { ApiError, createBackendJob, type AuthUser, type BackendRuntime } from "../../services/backendApi";
import type { ArchVizGridOptions, Job, ModelType, Project, UploadedImage, UploadedVideo } from "../../types";
import { createClientId } from "../../utils/id";
import {
  createLocalJob,
  isArchVizGridModel,
  jobImageUrl,
  LocalMediaReadError,
  parseResolution,
  uploadJobMediaUrl,
  workflowOptionsForJob,
} from "../generation/generationUtils";
import { ALL_PROJECTS_ID, incrementProjectJobCount, mergeJobs } from "../workspace/workspaceUtils";

type ShowToast = (message: string, type?: "success" | "error" | "info") => void;

type JobSubmissionOptions = {
  account: AuthUser | null;
  backendAvailable: boolean;
  setBackendAvailable: Dispatch<SetStateAction<boolean>>;
  backendRuntime?: BackendRuntime;
  selectedProjectId: string;
  selectedProject?: Project;
  targetFolderId: string;
  selectedModel: ModelType;
  disabledReason?: string;
  prompt: string;
  selectedResolution: string;
  selectedDurationSeconds: number;
  images: UploadedImage[];
  video?: UploadedVideo;
  requiredImages: number;
  use16By9Cropping: boolean;
  archVizGridOptions: ArchVizGridOptions;
  saveNumber: string;
  imageOutputCount: 1 | 2;
  selectedNanoBananaAspectRatio: string;
  setJobs: Dispatch<SetStateAction<Job[]>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setBackendJobsTotal: Dispatch<SetStateAction<number>>;
  setBackendJobsOffset: Dispatch<SetStateAction<number>>;
  showToast: ShowToast;
};

export function useJobSubmission(options: JobSubmissionOptions) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionPhase, setSubmissionPhase] = useState<SubmissionPhase>("idle");
  const [recoverableFingerprint, setRecoverableFingerprint] = useState<string | undefined>(undefined);
  const pendingSubmissionRef = useRef<PendingSubmission | undefined>(undefined);
  const submissionAbortRef = useRef<AbortController | undefined>(undefined);

  const currentFingerprint = fingerprintForCurrentOptions(options);
  const hasRecoverableSubmission = Boolean(currentFingerprint) && recoverableFingerprint === currentFingerprint;

  async function handleGenerate() {
    if (isSubmitting) return;
    const {
      account,
      backendAvailable,
      setBackendAvailable,
      backendRuntime,
      selectedProjectId,
      selectedProject,
      targetFolderId,
      selectedModel,
      disabledReason,
      prompt,
      selectedResolution,
      selectedDurationSeconds,
      images,
      video,
      requiredImages,
      use16By9Cropping,
      archVizGridOptions,
      saveNumber,
      imageOutputCount,
      selectedNanoBananaAspectRatio,
      setJobs,
      setProjects,
      setBackendJobsTotal,
      setBackendJobsOffset,
      showToast,
    } = options;
    if (!account) {
      showToast("Sign in before generating.", "error");
      return;
    }
    if (disabledReason) {
      showToast(disabledReason, "error");
      return;
    }
    if (selectedProjectId === ALL_PROJECTS_ID || !selectedProject) {
      showToast("Please select a specific project before generating.", "error");
      return;
    }

    const abortController = new AbortController();
    submissionAbortRef.current = abortController;
    setIsSubmitting(true);
    setSubmissionPhase("preparing");
    try {
      if (backendAvailable || selectedModel.backendCategory || selectedModel.workflowPath) {
        const workflowOptions = workflowOptionsForJob(
          selectedModel,
          archVizGridOptions,
          saveNumber,
          imageOutputCount,
          selectedNanoBananaAspectRatio,
        );
        const fingerprint = submissionFingerprint({
          accountId: account.id,
          selectedProjectId,
          targetFolderId,
          selectedModel,
          prompt,
          selectedResolution,
          selectedDurationSeconds,
          images,
          video,
          requiredImages,
          use16By9Cropping,
          workflowOptions,
        });
        const existingPending =
          pendingSubmissionRef.current?.fingerprint === fingerprint ? pendingSubmissionRef.current : undefined;
        const pending = existingPending ?? { fingerprint, clientRequestId: createClientId("req_") };
        setRecoverableFingerprint(undefined);
        pendingSubmissionRef.current = pending;

        setSubmissionPhase("uploading");
        const inputImages =
          pending.inputImages ??
          (await submissionStage(
            "media_upload",
            Promise.all(
              images
                .slice(0, requiredImages)
                .filter((image): image is UploadedImage => Boolean(image))
                .map((image) =>
                  uploadJobMediaUrl(jobImageUrl(image, use16By9Cropping), {
                    projectId: selectedProjectId,
                    kind: "image",
                    name: image.name,
                    signal: abortController.signal,
                  }),
                ),
            ),
          ));
        pending.inputImages = inputImages;
        const inputVideo =
          selectedModel.requiresVideo && video
            ? (pending.inputVideo ??
              (await submissionStage(
                "media_upload",
                uploadJobMediaUrl(video.url, {
                  projectId: selectedProjectId,
                  kind: "video",
                  name: video.name,
                  signal: abortController.signal,
                }),
              )))
            : undefined;
        pending.inputVideo = inputVideo;
        setSubmissionPhase(existingPending ? "recovering" : "creating");
        const creation = await submissionStage(
          "job_creation",
          createBackendJob(
            {
              clientRequestId: pending.clientRequestId,
              projectId: selectedProjectId,
              targetFolderId: targetFolderId || null,
              modelId: selectedModel.id,
              prompt: isArchVizGridModel(selectedModel) ? "" : prompt.trim(),
              resolution: parseResolution(selectedResolution),
              durationSeconds: selectedDurationSeconds,
              inputImages,
              startFrame: selectedModel.requiresTwoImages ? inputImages[0] : undefined,
              endFrame: selectedModel.requiresTwoImages ? inputImages[1] : undefined,
              inputVideo,
              workflowOptions,
            },
            { signal: abortController.signal },
          ),
        );
        pendingSubmissionRef.current = undefined;
        setRecoverableFingerprint(undefined);
        const backendJob = creation.job;
        setBackendAvailable(true);
        setJobs((current) => mergeJobs([backendJob], current));
        if (!creation.replayed) {
          setProjects((current) => incrementProjectJobCount(current, selectedProjectId));
          setBackendJobsTotal((current) => current + 1);
          setBackendJobsOffset((current) => current + 1);
        }
        showToast(
          creation.replayed
            ? "Existing queued job recovered. No duplicate was created."
            : backendRuntime?.generationBackend === "local_comfy"
              ? "Job sent to the local ComfyUI backend."
              : "Job sent to RunPod serverless.",
        );
        return;
      }

      const localJob = createLocalJob({
        account,
        selectedModel,
        selectedProjectId,
        prompt,
        selectedResolution,
        selectedDurationSeconds,
        images,
        video,
        archVizGridOptions,
        saveNumber,
        imageOutputCount,
        selectedNanoBananaAspectRatio,
        use16By9Cropping,
        requiredImages,
      });
      setJobs((current) => [localJob, ...current]);
      setProjects((current) => incrementProjectJobCount(current, selectedProjectId));
      showToast("Local preview job created.");
    } catch (error) {
      const retainPending = shouldRetainPendingSubmission(error);
      if (!retainPending) pendingSubmissionRef.current = undefined;
      setRecoverableFingerprint(retainPending ? pendingSubmissionRef.current?.fingerprint : undefined);
      if (isBackendConnectionFailure(error)) setBackendAvailable(false);
      showToast(submissionErrorMessage(error), isSubmissionCanceled(error) ? "info" : "error");
    } finally {
      submissionAbortRef.current = undefined;
      setIsSubmitting(false);
      setSubmissionPhase("idle");
    }
  }

  function cancelSubmission() {
    submissionAbortRef.current?.abort(new DOMException("Canceled by user", "AbortError"));
  }

  return { isSubmitting, submissionPhase, hasRecoverableSubmission, handleGenerate, cancelSubmission };
}

type SubmissionStage = "media_upload" | "job_creation";
export type SubmissionPhase = "idle" | "preparing" | "uploading" | "creating" | "recovering";

type PendingSubmission = {
  fingerprint: string;
  clientRequestId: string;
  inputImages?: string[];
  inputVideo?: string;
};

class SubmissionStageError extends Error {
  constructor(
    readonly stage: SubmissionStage,
    readonly source: unknown,
  ) {
    super(source instanceof Error ? source.message : "Submission failed.", { cause: source });
    this.name = "SubmissionStageError";
  }
}

async function submissionStage<T>(stage: SubmissionStage, operation: Promise<T>) {
  try {
    return await operation;
  } catch (error) {
    throw new SubmissionStageError(stage, error);
  }
}

function isBackendConnectionFailure(error: unknown) {
  const source = error instanceof SubmissionStageError ? error.source : error;
  return source instanceof ApiError && (source.code === "network" || source.code === "timeout");
}

function shouldRetainPendingSubmission(error: unknown) {
  if (!(error instanceof SubmissionStageError) || error.stage !== "job_creation") return false;
  return (
    error.source instanceof ApiError &&
    (error.source.code === "network" || error.source.code === "timeout" || error.source.code === "canceled")
  );
}

function isSubmissionCanceled(error: unknown) {
  return error instanceof SubmissionStageError && error.source instanceof ApiError && error.source.code === "canceled";
}

function fingerprintForCurrentOptions(options: JobSubmissionOptions) {
  if (!options.account || !options.selectedProject || options.selectedProjectId === ALL_PROJECTS_ID) return undefined;
  return submissionFingerprint({
    accountId: options.account.id,
    selectedProjectId: options.selectedProjectId,
    targetFolderId: options.targetFolderId,
    selectedModel: options.selectedModel,
    prompt: options.prompt,
    selectedResolution: options.selectedResolution,
    selectedDurationSeconds: options.selectedDurationSeconds,
    images: options.images,
    video: options.video,
    requiredImages: options.requiredImages,
    use16By9Cropping: options.use16By9Cropping,
    workflowOptions: workflowOptionsForJob(
      options.selectedModel,
      options.archVizGridOptions,
      options.saveNumber,
      options.imageOutputCount,
      options.selectedNanoBananaAspectRatio,
    ),
  });
}

function submissionFingerprint(input: {
  accountId: string;
  selectedProjectId: string;
  targetFolderId: string;
  selectedModel: ModelType;
  prompt: string;
  selectedResolution: string;
  selectedDurationSeconds: number;
  images: UploadedImage[];
  video?: UploadedVideo;
  requiredImages: number;
  use16By9Cropping: boolean;
  workflowOptions: ReturnType<typeof workflowOptionsForJob>;
}) {
  return JSON.stringify({
    accountId: input.accountId,
    projectId: input.selectedProjectId,
    targetFolderId: input.targetFolderId || null,
    modelId: input.selectedModel.id,
    prompt: isArchVizGridModel(input.selectedModel) ? "" : input.prompt.trim(),
    resolution: parseResolution(input.selectedResolution),
    durationSeconds: input.selectedDurationSeconds,
    images: input.images
      .slice(0, input.requiredImages)
      .filter(Boolean)
      .map((image) => ({
        id: image.id,
        name: image.name,
        url: jobImageUrl(image, input.use16By9Cropping),
      })),
    video: input.video ? { id: input.video.id, name: input.video.name, url: input.video.url } : undefined,
    workflowOptions: input.workflowOptions,
  });
}

function submissionErrorMessage(error: unknown) {
  if (!(error instanceof SubmissionStageError)) {
    return error instanceof Error ? `Could not create the preview job: ${error.message}` : "Could not create the preview job.";
  }

  const source = error.source;
  if (source instanceof LocalMediaReadError) return source.message;
  if (!(source instanceof ApiError)) {
    return error.stage === "media_upload" ? "Could not prepare the selected media for upload." : "Could not create the job.";
  }
  if (source.code === "http") return withRequestReference(source.message, source.requestId);
  if (source.code === "invalid_response") {
    return withRequestReference(
      error.stage === "media_upload"
        ? "The server returned an invalid response after the media upload."
        : "The server returned an invalid response while creating the job.",
      source.requestId,
    );
  }
  if (source.code === "canceled") {
    return error.stage === "media_upload"
      ? "Media upload canceled. No job was created."
      : "Submission check canceled. Select Retry safely to recover the existing job or create it once.";
  }
  if (error.stage === "media_upload") {
    return source.code === "timeout"
      ? "The media upload timed out. Check your connection and try again."
      : "Could not reach the server while uploading media. Check your connection and try again.";
  }
  return source.code === "timeout"
    ? "Job creation timed out. Select Retry safely; the same request key prevents a duplicate job."
    : "The connection was lost while creating the job. Select Retry safely; the same request key prevents a duplicate job.";
}

function withRequestReference(message: string, requestId: string | undefined) {
  return requestId ? `${message} Reference: ${requestId}.` : message;
}
