import { useState, type Dispatch, type SetStateAction } from "react";

import { createBackendJob, type AuthUser, type BackendRuntime } from "../../services/backendApi";
import type { ArchVizGridOptions, Job, ModelType, Project, UploadedImage, UploadedVideo } from "../../types";
import {
  createLocalJob,
  isArchVizGridModel,
  jobImageUrl,
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

  async function handleGenerate() {
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

    setIsSubmitting(true);
    try {
      if (backendAvailable || selectedModel.backendCategory || selectedModel.workflowPath) {
        const inputImages = await Promise.all(
          images
            .slice(0, requiredImages)
            .filter((image): image is UploadedImage => Boolean(image))
            .map((image) =>
              uploadJobMediaUrl(jobImageUrl(image, use16By9Cropping), {
                projectId: selectedProjectId,
                kind: "image",
                name: image.name,
              }),
            ),
        );
        const inputVideo =
          selectedModel.requiresVideo && video
            ? await uploadJobMediaUrl(video.url, { projectId: selectedProjectId, kind: "video", name: video.name })
            : undefined;
        const backendJob = await createBackendJob({
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
          workflowOptions: workflowOptionsForJob(
            selectedModel,
            archVizGridOptions,
            saveNumber,
            imageOutputCount,
            selectedNanoBananaAspectRatio,
          ),
        });
        setJobs((current) => mergeJobs([backendJob], current));
        setProjects((current) => incrementProjectJobCount(current, selectedProjectId));
        setBackendJobsTotal((current) => current + 1);
        setBackendJobsOffset((current) => current + 1);
        showToast(
          backendRuntime?.generationBackend === "local_comfy"
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
      setBackendAvailable(false);
      showToast(
        error instanceof Error ? `Backend unavailable: ${error.message}` : "Backend unavailable. Could not send job.",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return { isSubmitting, handleGenerate };
}
