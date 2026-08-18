import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { ImageDownloadFormat } from "../../components/DownloadImageChoiceModal";
import {
  archiveBackendJob,
  backendResultFileUrl,
  cancelBackendJob,
  moveBackendJobResult,
  permanentlyDeleteBackendJob,
  restoreBackendJob,
  retryBackendJob,
  updateBackendJobSaveNumber,
} from "../../services/backendApi";
import type { Job, Project } from "../../types";
import { normalizeRequiredSaveNumber, workflowOptionsWithSaveNumber } from "../generation/generationUtils";
import { readFavoriteJobIds, writeFavoriteJobIds } from "../preferences/appPreferences";
import type { ConfirmDialogState } from "../projects/useProjectActions";
import { matchesFolder, mergeJobs } from "../workspace/workspaceUtils";
import { clipboardCompatibleImageBlob, downloadFromUrl, fetchResultBlob, isImageResult } from "./resultMedia";

type ShowToast = (message: string, type?: "success" | "error" | "info") => void;

type JobActionsOptions = {
  backendAvailable: boolean;
  projects: Project[];
  jobs: Job[];
  setJobs: Dispatch<SetStateAction<Job[]>>;
  selectedFolderId: string;
  setBackendJobsTotal: Dispatch<SetStateAction<number>>;
  setBackendJobsOffset: Dispatch<SetStateAction<number>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState | null>>;
  showToast: ShowToast;
};

export function useJobActions(options: JobActionsOptions) {
  const {
    backendAvailable,
    projects,
    jobs,
    setJobs,
    selectedFolderId,
    setBackendJobsTotal,
    setBackendJobsOffset,
    setConfirmDialog,
    showToast,
  } = options;
  const [favoriteJobIds, setFavoriteJobIds] = useState(readFavoriteJobIds);
  const [downloadChoiceJob, setDownloadChoiceJob] = useState<Job | null>(null);

  useEffect(() => {
    writeFavoriteJobIds(favoriteJobIds);
  }, [favoriteJobIds]);

  /**
   * Downloads stream from the backend straight to disk. Nothing is buffered in
   * the tab, so a 100+ MB still costs the page no memory at all, and with no
   * `format` the user gets the generator's original bytes untouched.
   */
  function handleDownloadJobResult(job: Job, resultIndex?: number, imageFormat?: ImageDownloadFormat) {
    if (isImageResult(job) && imageFormat == null) {
      setDownloadChoiceJob(job);
      return;
    }
    downloadFromUrl(backendResultFileUrl(job.id, resultIndex ?? 0, imageFormat));
  }

  function handleDownloadChoice(index: number, format: ImageDownloadFormat) {
    if (!downloadChoiceJob) return;
    const job = downloadChoiceJob;
    setDownloadChoiceJob(null);
    handleDownloadJobResult(job, index, format);
  }

  async function handleCopyJobImage(job: Job) {
    try {
      const blob = await fetchResultBlob(job);
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        showToast("Clipboard image copy is not available in this browser.", "error");
        return;
      }
      const imageBlob = await clipboardCompatibleImageBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ [imageBlob.type]: imageBlob })]);
      showToast("Copied image.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not copy image.", "error");
    }
  }

  function handleToggleFavorite(job: Job) {
    setFavoriteJobIds((current) => {
      const next = new Set(current);
      if (next.has(job.id)) next.delete(job.id);
      else next.add(job.id);
      return next;
    });
  }

  async function handleMoveJobResult(job: Job, destinationFolderId: string | null) {
    const project = projects.find((item) => item.id === job.projectId);
    if (!project) {
      showToast("Project not found.", "error");
      return false;
    }
    const destinationFolder = destinationFolderId
      ? project.folders?.find((folder) => folder.folderId === destinationFolderId && !folder.archived)
      : undefined;
    if (destinationFolderId && !destinationFolder) {
      showToast("Destination folder not found.", "error");
      return false;
    }

    const optimisticJob: Job = { ...job, folderId: destinationFolderId, folderName: destinationFolder?.name ?? "Root" };
    const leavesSelectedFolder = selectedFolderId !== "all" && matchesFolder(job, selectedFolderId);
    setJobs((current) => current.map((item) => (item.id === job.id ? optimisticJob : item)));
    if (backendAvailable && leavesSelectedFolder) {
      setBackendJobsTotal((current) => Math.max(0, current - 1));
      setBackendJobsOffset((current) => Math.max(0, current - 1));
    }

    try {
      const updated = backendAvailable ? await moveBackendJobResult(job.projectId, job.id, destinationFolderId) : optimisticJob;
      setJobs((current) => current.map((item) => (item.id === job.id ? updated : item)));
      showToast(`Moved to ${destinationFolder?.name ?? "project root"}.`);
      return true;
    } catch (error) {
      setJobs((current) => current.map((item) => (item.id === job.id ? job : item)));
      if (backendAvailable && leavesSelectedFolder) {
        setBackendJobsTotal((current) => current + 1);
        setBackendJobsOffset((current) => current + 1);
      }
      showToast(error instanceof Error ? error.message : "Could not move result.", "error");
      return false;
    }
  }

  async function handleRetryJob(job: Job) {
    if (!backendAvailable) {
      showToast("Retry is only available while the backend is connected.", "error");
      return;
    }
    try {
      const newJob = await retryBackendJob(job.id);
      setJobs((current) => mergeJobs([newJob], current));
      setBackendJobsTotal((current) => current + 1);
      setBackendJobsOffset((current) => current + 1);
      showToast("Job requeued with the same settings.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not retry job.", "error");
    }
  }

  /**
   * Ask the dispatcher to stop a job that is still working.
   *
   * Worth having on both surfaces, but it is Still Images that needs it most: a
   * preset runs one to eight minutes on a pod the studio pays for by the second,
   * so a wrong slot or a typo in the prompt was previously paid for in full.
   *
   * The flag is what the UI shows, not the status. Cancellation is a request the
   * dispatcher settles on its next poll -- which is also where the remote RunPod
   * job is stopped -- so the job comes back still `running` and only reaches
   * `canceled` once that has actually happened.
   */
  async function handleCancelJob(job: Job) {
    if (!backendAvailable) {
      showToast("Cancel is only available while the backend is connected.", "error");
      return;
    }
    setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, cancelRequested: true } : item)));
    try {
      const updated = await cancelBackendJob(job.id);
      setJobs((current) => current.map((item) => (item.id === job.id ? updated : item)));
      showToast(
        updated.status === "canceled" ? "Job canceled." : "Cancel requested. Stopping the job on its pod.",
      );
    } catch (error) {
      // Put the flag back: leaving it set would show "Canceling" forever on a job
      // that is still running and still billing.
      setJobs((current) =>
        current.map((item) => (item.id === job.id ? { ...item, cancelRequested: job.cancelRequested } : item)),
      );
      showToast(error instanceof Error ? error.message : "Could not cancel job.", "error");
    }
  }

  async function setArchivedState(job: Job, restore: boolean) {
    const previousJobs = jobs;
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setBackendJobsTotal((current) => Math.max(0, current - 1));
    try {
      if (backendAvailable) {
        if (restore) await restoreBackendJob(job.id);
        else await archiveBackendJob(job.id);
      }
      showToast(restore ? "Restored to main results." : "Moved to archive.");
    } catch (error) {
      setJobs(previousJobs);
      setBackendJobsTotal((current) => current + 1);
      showToast(
        error instanceof Error ? error.message : restore ? "Could not restore result." : "Could not archive result.",
        "error",
      );
    }
  }

  function handlePermanentlyDeleteJob(job: Job) {
    setConfirmDialog({
      title: "Delete archived item",
      message: "Delete this archived item permanently from the app archive? The media files on disk are left untouched.",
      confirmLabel: "Delete permanently",
      tone: "danger",
      onConfirm: () => void performPermanentlyDeleteJob(job),
    });
  }

  async function performPermanentlyDeleteJob(job: Job) {
    const previousJobs = jobs;
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setBackendJobsTotal((current) => Math.max(0, current - 1));
    try {
      if (backendAvailable) await permanentlyDeleteBackendJob(job.id);
      showToast("Archived item permanently deleted.");
    } catch (error) {
      setJobs(previousJobs);
      setBackendJobsTotal((current) => current + 1);
      showToast(error instanceof Error ? error.message : "Could not delete archived item.", "error");
    }
  }

  async function handleUpdateJobSaveNumber(job: Job, value: string) {
    try {
      const nextSaveNumber = normalizeRequiredSaveNumber(value);
      if (!nextSaveNumber) {
        showToast("Shot/camera number is required.", "error");
        return;
      }
      const fallbackWorkflowOptions = workflowOptionsWithSaveNumber(job.workflowOptions, nextSaveNumber);
      const updated = backendAvailable
        ? await updateBackendJobSaveNumber(job.projectId, job.id, nextSaveNumber)
        : { ...job, workflowOptions: fallbackWorkflowOptions };
      setJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? {
                ...item,
                workflowOptions: updated.workflowOptions ?? workflowOptionsWithSaveNumber(item.workflowOptions, nextSaveNumber),
              }
            : item,
        ),
      );
      showToast("Shot/camera updated.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update shot/camera.", "error");
    }
  }

  return {
    favoriteJobIds,
    downloadChoiceJob,
    closeDownloadChoice: () => setDownloadChoiceJob(null),
    handleDownloadChoice,
    handleDownloadJobResult,
    handleCopyJobImage,
    handleToggleFavorite,
    handleMoveJobResult,
    handleRetryJob,
    handleCancelJob,
    handleArchiveJob: (job: Job) => setArchivedState(job, false),
    handleRestoreArchivedJob: (job: Job) => setArchivedState(job, true),
    handlePermanentlyDeleteJob,
    handleUpdateJobSaveNumber,
  };
}
