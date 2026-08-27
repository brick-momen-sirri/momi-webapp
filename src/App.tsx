import { useEffect, useMemo, useState } from "react";
import { AccountPanel } from "./components/AccountPanel";
import { ToastStack, WorkspaceLoadingScreen } from "./components/AppFeedback";
import { AuthScreen } from "./components/AuthScreen";
import { ComfyPoolManager } from "./components/ComfyPoolManager";
import { ConfirmModal } from "./components/ConfirmModal";
import { CreditUsageDashboard } from "./components/CreditUsageDashboard";
import { DownloadImageChoiceModal } from "./components/DownloadImageChoiceModal";
import { JobFeed } from "./components/JobFeed";
import { Layout } from "./components/Layout";
import { LeftSettingsPanel } from "./components/LeftSettingsPanel";
import { MainSectionNavigation, type MainSection } from "./components/MainSectionNavigation";
import { PodStatusIndicator } from "./components/PodStatusIndicator";
import { RightProjectPanel } from "./components/RightProjectPanel";
import { StillImagesSettingsPanel } from "./components/StillImagesSettingsPanel";
import { StillImagesWorkspace } from "./components/StillImagesWorkspace";
import type { Job } from "./types";
import { useResetWhenChanged } from "./utils/useResetWhenChanged";
import {
  imageSlotCountForModel,
  isNanoBananaModel,
  normalizeDurationSeconds,
  normalizeNanoBananaAspectRatio,
  normalizeResolutionForModel,
  normalizeSaveNumber,
  normalizeSeedanceRatio,
  supportsImageOutputCount,
  supportsSeedanceRatio,
} from "./features/generation/generationUtils";
import { useGenerationForm } from "./features/generation/useGenerationForm";
import { useAuthentication } from "./features/auth/useAuthentication";
import {
  canReuseJobSettings,
  findReusableModel,
  hasInputImageMetadata,
  hasInputVideoMetadata,
  hasKnownResolution,
  hasPromptMetadata,
  normalizeReusableArchVizGridOptions,
  rehydrateJobInputImages,
  rehydrateJobInputVideo,
  reusableImageOutputCount,
  reusableNanoBananaAspectRatio,
  reusableSaveNumber,
  reusableSeedanceRatio,
} from "./features/jobs/jobReuse";
import { useJobActions } from "./features/jobs/useJobActions";
import { useJobSubmission } from "./features/jobs/useJobSubmission";
import { readPersistedGenerationSettings } from "./features/preferences/appPreferences";
import { useTheme } from "./features/preferences/useTheme";
import { useNotifications } from "./features/notifications/useNotifications";
import { useProjectActions, type ConfirmDialogState } from "./features/projects/useProjectActions";
import { useWorkspaceData } from "./features/workspace/useWorkspaceData";
import { ALL_PROJECTS_ID, getMonthlyUsageForUser, getWorkspaceMonthlyUsage } from "./features/workspace/workspaceUtils";
import { chainableResultImage } from "./features/still-images/chainResult";
import { finalizeImageEdit } from "./features/still-images/finalizeImageEdit";
import { editDocumentIdOfJob, restoreEditDocument } from "./features/still-images/editDocument";
import { fetchBackendEditDocumentJobs } from "./services/backendApi";
import { layersWithJobs } from "./features/still-images/imageEditLayers";
import type { MaskDrawing } from "./features/still-images/maskDrawing";
import { isStillImageJob } from "./features/still-images/jobSection";
import { reusableStillImageJob } from "./features/still-images/reuseStillImageJob";
import { STILL_IMAGE_CATEGORIES, type StillImageCategoryId } from "./features/still-images/stillImageCategories";
import { useStillImagesForm } from "./features/still-images/useStillImagesForm";
import { useStillImagesSubmission } from "./features/still-images/useStillImagesSubmission";
import { mergeJobs } from "./features/workspace/workspaceUtils";

function App() {
  const [initialSettings] = useState(readPersistedGenerationSettings);
  const [mainSection, setMainSection] = useState<MainSection>("animation");
  const stillImagesForm = useStillImagesForm();
  const { toasts, showToast, dismissToast } = useNotifications();
  const { theme, toggleTheme: handleThemeToggle } = useTheme();
  const {
    account,
    setAccount,
    authLoading,
    workspaceAccounts,
    setWorkspaceAccounts,
    workspaceUsers,
    handleSignIn,
    handleLogout,
    handleUpdateProfile,
    handleToggleProjectPin,
    handleChangePassword,
    handleCreateUser,
    handleUpdateUser,
    handleResetUserPassword,
    handleToggleUserActive,
  } = useAuthentication(showToast);
  const [selectedProjectId, setSelectedProjectId] = useState(initialSettings.selectedProjectId ?? ALL_PROJECTS_ID);
  const [selectedFolderId, setSelectedFolderId] = useState<"all" | "root" | string>("all");
  const [targetFolderId, setTargetFolderId] = useState(initialSettings.targetFolderId ?? "");
  const {
    projects,
    setProjects,
    jobs,
    setJobs,
    backendJobsTotal,
    setBackendJobsTotal,
    backendJobsOffset,
    setBackendJobsOffset,
    isLoadingMoreJobs,
    showArchivedJobs,
    models,
    backendCreditsRemaining,
    monthlyUsageByUser,
    backendRuntime,
    comfyServers,
    podStatus,
    backendAvailable,
    setBackendAvailable,
    loadedWorkspaceAccountId,
    refreshComfyServers,
    handleComfyPoolAction,
    handleLoadMoreJobs,
    handleToggleArchivedView,
  } = useWorkspaceData({
    account,
    setAccount,
    setWorkspaceAccounts,
    selectedProjectId,
    setSelectedProjectId,
    selectedFolderId,
    showToast,
  });
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const creditsRemaining = backendCreditsRemaining ?? 0;
  const {
    setSelectedModelId,
    selectedResolution,
    setSelectedResolution,
    selectedNanoBananaAspectRatio,
    setSelectedNanoBananaAspectRatio,
    selectedSeedanceRatio,
    setSelectedSeedanceRatio,
    selectedDurationSeconds,
    setSelectedDurationSeconds,
    prompt,
    setPrompt,
    archVizGridOptions,
    setArchVizGridOptions,
    saveNumber,
    setSaveNumber,
    imageOutputCount,
    setImageOutputCount,
    enableImageToVideo16By9Cropping,
    setEnableImageToVideo16By9Cropping,
    images,
    setImages,
    video,
    setVideo,
    selectedModel,
    selectedModelSupportsCropToggle,
    requiredImages,
    use16By9Cropping,
    disabledReason,
    viewOnlyProject,
    allowSeedance4K,
    handleModelChange,
    handleResolutionChange,
  } = useGenerationForm({
    initialSettings,
    models,
    account,
    selectedProjectId,
    selectedProject,
    targetFolderId,
    creditsRemaining,
  });
  useEffect(() => {
    if (!models.length) return;
    setSelectedModelId((current) => (models.some((model) => model.id === current) ? current : models[0].id));
  }, [models, setSelectedModelId]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const {
    handleCreateProject,
    handleUpdateProject,
    handleAddProjectMember,
    handleRemoveProjectMember,
    handleCreateProjectFolder,
    handleRenameProjectFolder,
    handleDeleteProjectFolder,
    handleSelectFolder,
  } = useProjectActions({
    account,
    backendAvailable,
    projects,
    setProjects,
    setSelectedProjectId,
    selectedFolderId,
    setSelectedFolderId,
    setTargetFolderId,
    setConfirmDialog,
    showToast,
  });
  const {
    favoriteJobIds,
    downloadChoiceJob,
    closeDownloadChoice,
    handleDownloadChoice,
    handleDownloadJobResult,
    handleCopyJobImage,
    handleToggleFavorite,
    handleMoveJobResult,
    handleRetryJob,
    handleCancelJob,
    handleArchiveJob,
    handleRestoreArchivedJob,
    handlePermanentlyDeleteJob,
    handleUpdateJobSaveNumber,
  } = useJobActions({
    backendAvailable,
    projects,
    jobs,
    setJobs,
    selectedFolderId,
    setBackendJobsTotal,
    setBackendJobsOffset,
    setConfirmDialog,
    showToast,
  });
  const { isSubmitting, submissionPhase, hasRecoverableSubmission, handleGenerate, cancelSubmission } = useJobSubmission({
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
    selectedSeedanceRatio,
    setJobs,
    setProjects,
    setBackendJobsTotal,
    setBackendJobsOffset,
    showToast,
  });
  const selectedStillImageState = useMemo(
    () =>
      stillImagesForm.selectedCategoryId === "image-editing"
        ? { ...stillImagesForm.selectedState, editLayers: layersWithJobs(stillImagesForm.selectedState, jobs) }
        : stillImagesForm.selectedState,
    [jobs, stillImagesForm.selectedCategoryId, stillImagesForm.selectedState],
  );
  const stillImagesSubmission = useStillImagesSubmission({
    onJobCreated: (job) => {
      setJobs((current) => mergeJobs([job], current));
      setBackendJobsTotal((current) => current + 1);
      setBackendJobsOffset((current) => current + 1);
      showToast("Still image job queued.", "success");
    },
    onJobUpdated: (job) => setJobs((current) => mergeJobs([job], current)),
    onEditJobCompleted: (job) => {
      // A generated edit becomes a document layer only after its crop has been
      // saved and mapped back to the original coordinates. Until then the current
      // mask/prompt/reference draft stays intact and retryable.
      stillImagesForm.commitEditLayer(job);
      showToast("Edit complete and added as a layer.", "success");
    },
    onError: (message) => showToast(message, "error"),
  });
  const [finishingStillImageEdit, setFinishingStillImageEdit] = useState(false);
  const [stillImageEditorOpenRequest, setStillImageEditorOpenRequest] = useState(0);
  const [reopeningEditDocument, setReopeningEditDocument] = useState<string | undefined>(undefined);
  const handleStillImagesGenerate = () => {
    if (!selectedProjectId) return;
    void stillImagesSubmission.submit({
      projectId: selectedProjectId,
      categoryId: stillImagesForm.selectedCategoryId,
      categoryState: selectedStillImageState,
      targetFolderId: stillImagesForm.targetFolderId,
      saveNumber: stillImagesForm.saveNumber,
    });
  };
  const handleFinishStillImageEdit = async (drawing: MaskDrawing) => {
    if (stillImagesSubmission.submitting) {
      showToast("Wait for the edit request to finish sending before completing the composite.", "error");
      return false;
    }
    if (!selectedProjectId || selectedProjectId === ALL_PROJECTS_ID) {
      showToast("Select a project before finishing the composite.", "error");
      return false;
    }
    setFinishingStillImageEdit(true);
    try {
      const job = await finalizeImageEdit({
        projectId: selectedProjectId,
        targetFolderId: stillImagesForm.targetFolderId,
        saveNumber: stillImagesForm.saveNumber,
        state: selectedStillImageState,
        currentDrawing: drawing,
      });
      setJobs((current) => mergeJobs([job], current));
      setBackendJobsTotal((current) => current + 1);
      setBackendJobsOffset((current) => current + 1);
      showToast("Edited composite added to Results.", "success");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not finish the edited composite.", "error");
      return false;
    } finally {
      setFinishingStillImageEdit(false);
    }
  };
  // The two workspaces list different jobs from the same loaded set. Without this
  // split, still image jobs would also appear in the Animation feed -- they share
  // the job store, and only workflowOptions.stillImage tells them apart.
  const animationJobs = useMemo(() => jobs.filter((job) => !isStillImageJob(job)), [jobs]);
  const stillImageJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          isStillImageJob(job) &&
          !job.workflowOptions?.stillImage?.edit &&
          (!selectedProjectId || selectedProjectId === ALL_PROJECTS_ID || job.projectId === selectedProjectId),
      ),
    [jobs, selectedProjectId],
  );
  const currentMonthUsage = account
    ? (monthlyUsageByUser[account.id] ?? getMonthlyUsageForUser(jobs, account.id))
    : { creditsSpent: 0, jobsCompleted: 0 };
  const creditDashboardMonthUsage =
    account?.role === "admin" ? getWorkspaceMonthlyUsage(monthlyUsageByUser, jobs) : currentMonthUsage;
  const hasMoreBackendJobs = backendAvailable && backendJobsOffset < backendJobsTotal;

  // Switching project invalidates both folder selections. Done during render
  // rather than in an effect so the panels never paint one frame with the previous
  // project's folder still selected.
  useResetWhenChanged(selectedProjectId, () => {
    setSelectedFolderId("all");
    setTargetFolderId("");
    stillImagesForm.setTargetFolderId("");
  });

  // Folders arrive from the backend and can be archived or deleted underneath a
  // selection. The key reproduces the old dependency list exactly -- the live
  // folder set plus both selections -- so the prune fires in the same situations,
  // just during render instead of after a painted frame.
  const activeFolderIdSignature = (selectedProject?.folders ?? [])
    .filter((folder) => !folder.archived)
    .map((folder) => folder.folderId)
    .join(",");
  useResetWhenChanged(
    `${activeFolderIdSignature}|${selectedFolderId}|${targetFolderId}|${stillImagesForm.targetFolderId}`,
    () => {
      const folderIds = new Set(activeFolderIdSignature ? activeFolderIdSignature.split(",") : []);
      if (targetFolderId && !folderIds.has(targetFolderId)) {
        setTargetFolderId("");
      }
      if (selectedFolderId !== "all" && selectedFolderId !== "root" && !folderIds.has(selectedFolderId)) {
        setSelectedFolderId("all");
      }
      if (stillImagesForm.targetFolderId && !folderIds.has(stillImagesForm.targetFolderId)) {
        stillImagesForm.setTargetFolderId("");
      }
    },
  );

  /**
   * Put a still image result's preset back into the Still Images form.
   *
   * Separate from the Animation path below, which restores a model, resolution
   * and duration -- a preset has none of those, and run against a still image job
   * it rewrote the Animation panel and restored none of the sliders the render
   * actually used.
   */
  async function handleReuseStillImageSettings(job: Job) {
    const reusable = reusableStillImageJob(job);
    if (!reusable) {
      showToast("This result does not have reusable settings saved.", "info");
      return;
    }

    showToast("Loading saved settings...", "info");

    // Slots come from the restored settings, not from the job's image count: Qwen
    // Edit's mode decides how many the form will draw, and a mismatch would leave
    // an image in a slot the panel no longer shows.
    const images = await rehydrateJobInputImages(job, reusable.slotCount);
    stillImagesForm.loadCategoryState(reusable.categoryId, { ...reusable.state, images });

    const savedNumber = reusableSaveNumber(job);
    if (savedNumber !== undefined) stillImagesForm.setSaveNumber(normalizeSaveNumber(savedNumber));

    showToast(
      reusable.state.seed
        ? `Loaded settings and seed ${reusable.state.seed}. Generating again reproduces this result.`
        : "Loaded settings from previous result. This result predates seeds, so the render will differ.",
    );
  }

  /**
   * Chain a still image result into the next preset.
   *
   * Nothing is fetched or re-uploaded: the result is already saved project media
   * and the submission path forwards a saved-media URL untouched, so the next
   * job runs against the same file on disk. Walking this chain by hand meant
   * downloading a 100 MB PNG and uploading it back.
   */
  /**
   * Offered for anything that records the document it came from.
   *
   * No longer gated on the layer jobs being loaded: they are fetched by id when
   * the button is pressed, so a composite finished months ago reopens exactly
   * like one finished a minute ago.
   */
  function canContinueEditingComposite(job: Job) {
    return Boolean(editDocumentIdOfJob(job));
  }

  async function handleContinueEditingComposite(job: Job) {
    const documentId = editDocumentIdOfJob(job);
    if (!documentId) return;

    setReopeningEditDocument(documentId);
    try {
      // What is already loaded is used first: for a composite finished in this
      // session that is every layer, and it saves a round trip. The fetch is for
      // everything older than the page the browser happens to be holding.
      const restored =
        restoreEditDocument(jobs, documentId) ?? restoreEditDocument(await fetchBackendEditDocumentJobs(documentId), documentId);
      if (!restored) {
        showToast("This composite has no editable layers left to reopen.", "info");
        return;
      }
      stillImagesForm.openEditDocument(restored);
      setStillImageEditorOpenRequest((request) => request + 1);
      const count = restored.layers.length;
      showToast(
        `Reopened ${count} layer${count === 1 ? "" : "s"}${restored.inferredOrder ? " — check the stacking order" : ""}.`,
        "success",
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load this composite's layers.", "error");
    } finally {
      setReopeningEditDocument(undefined);
    }
  }

  function handleUseStillResultAsInput(job: Job, categoryId: StillImageCategoryId) {
    const image = chainableResultImage(job);
    if (!image) {
      showToast("This result is not ready to use as an input yet.", "info");
      return;
    }

    stillImagesForm.useResultAsInput(categoryId, image);
    const preset = STILL_IMAGE_CATEGORIES.find((entry) => entry.id === categoryId);
    showToast(`Loaded into ${preset?.label ?? "the preset"} as the first input.`);
  }

  async function handleReuseJobSettings(job: Job) {
    if (isStillImageJob(job)) {
      await handleReuseStillImageSettings(job);
      return;
    }

    if (!canReuseJobSettings(job, models)) {
      showToast("This result does not have reusable settings saved.", "info");
      return;
    }

    showToast("Loading saved settings...", "info");

    const restored = new Set<string>();
    const reusableModel = findReusableModel(job, models);
    const targetModel = reusableModel ?? selectedModel;

    if (reusableModel) {
      setSelectedModelId(reusableModel.id);
      restored.add("model");
    }

    if (hasPromptMetadata(job)) {
      setPrompt(job.prompt);
      restored.add("prompt");
    }

    if (hasKnownResolution(job)) {
      setSelectedResolution(normalizeResolutionForModel(job.resolution, targetModel, allowSeedance4K));
      restored.add("resolution");
    }

    if (typeof job.durationSeconds === "number" && Number.isFinite(job.durationSeconds) && job.durationSeconds > 0) {
      setSelectedDurationSeconds(normalizeDurationSeconds(job.durationSeconds, targetModel));
      restored.add("duration");
    }

    const archVizGrid = normalizeReusableArchVizGridOptions(job.workflowOptions?.archVizGrid);
    if (archVizGrid) {
      setArchVizGridOptions(archVizGrid);
      restored.add("camera settings");
    }

    const savedNumber = reusableSaveNumber(job);
    if (savedNumber !== undefined) {
      setSaveNumber(normalizeSaveNumber(savedNumber));
      restored.add("camera number");
    }

    const outputCount = reusableImageOutputCount(job.workflowOptions);
    if (outputCount && supportsImageOutputCount(targetModel)) {
      setImageOutputCount(outputCount);
      restored.add("output count");
    }

    const nanoBananaAspectRatio = reusableNanoBananaAspectRatio(job.workflowOptions);
    if (nanoBananaAspectRatio && isNanoBananaModel(targetModel)) {
      setSelectedNanoBananaAspectRatio(nanoBananaAspectRatio);
      restored.add("aspect ratio");
    }

    const seedanceRatio = reusableSeedanceRatio(job.workflowOptions);
    if (seedanceRatio && supportsSeedanceRatio(targetModel)) {
      setSelectedSeedanceRatio(seedanceRatio);
      restored.add("aspect ratio");
    }

    if (hasInputImageMetadata(job)) {
      const slotCount = reusableModel ? imageSlotCountForModel(reusableModel) : job.inputImages.length;
      const nextImages = await rehydrateJobInputImages(job, slotCount);
      setImages(nextImages);
      restored.add(nextImages.some(Boolean) ? "input images" : "image inputs");
    }

    if (hasInputVideoMetadata(job)) {
      const nextVideo = job.inputVideo ? await rehydrateJobInputVideo(job.inputVideo) : undefined;
      setVideo(nextVideo);
      restored.add(nextVideo ? "input video" : "video input");
    } else if (reusableModel && !reusableModel.requiresVideo) {
      setVideo(undefined);
    }

    showToast(restored.size ? "Loaded settings from previous result." : "No reusable settings were found on this result.");
  }

  if (authLoading) {
    return <WorkspaceLoadingScreen title="Opening workspace" message="Checking your session..." />;
  }

  if (!account) {
    return <AuthScreen onSignIn={handleSignIn} theme={theme} onThemeToggle={handleThemeToggle} />;
  }

  if (loadedWorkspaceAccountId !== account.id) {
    return (
      <WorkspaceLoadingScreen
        title="Loading your workspace"
        message="Fetching projects, jobs, models, and credit usage..."
        accountName={account.name}
      />
    );
  }

  return (
    <>
      {backendRuntime?.localComfyEnabled ? (
        <ComfyPoolManager
          servers={comfyServers}
          canManage={account.role === "admin"}
          onRefresh={refreshComfyServers}
          onAction={handleComfyPoolAction}
        />
      ) : null}
      <Layout
        left={
          <div className="space-y-3">
            <MainSectionNavigation value={mainSection} onChange={setMainSection} />
            {mainSection === "animation" ? (
              <LeftSettingsPanel
                models={models}
                selectedModel={selectedModel}
                selectedProject={selectedProject}
                targetFolderId={targetFolderId}
                selectedResolution={selectedResolution}
                allowSeedance4K={allowSeedance4K}
                selectedNanoBananaAspectRatio={selectedNanoBananaAspectRatio}
                selectedSeedanceRatio={selectedSeedanceRatio}
                selectedDurationSeconds={selectedDurationSeconds}
                prompt={prompt}
                archVizGridOptions={archVizGridOptions}
                saveNumber={saveNumber}
                imageOutputCount={imageOutputCount}
                enable16By9Cropping={enableImageToVideo16By9Cropping}
                show16By9CropToggle={selectedModelSupportsCropToggle}
                images={images}
                video={video}
                creditsRemaining={creditsRemaining}
                disabledReason={disabledReason}
                viewOnly={viewOnlyProject}
                isSubmitting={isSubmitting}
                submissionPhase={submissionPhase}
                hasRecoverableSubmission={hasRecoverableSubmission}
                onModelChange={handleModelChange}
                onResolutionChange={handleResolutionChange}
                onNanoBananaAspectRatioChange={(value) => setSelectedNanoBananaAspectRatio(normalizeNanoBananaAspectRatio(value))}
                onSeedanceRatioChange={(value) => setSelectedSeedanceRatio(normalizeSeedanceRatio(value))}
                onDurationChange={(seconds) => setSelectedDurationSeconds(normalizeDurationSeconds(seconds, selectedModel))}
                onPromptChange={setPrompt}
                onArchVizGridOptionsChange={setArchVizGridOptions}
                onTargetFolderChange={setTargetFolderId}
                onSaveNumberChange={(value) => setSaveNumber(value.replace(/\D/g, "").slice(0, 4))}
                onImageOutputCountChange={setImageOutputCount}
                onEnable16By9CroppingChange={setEnableImageToVideo16By9Cropping}
                onImagesChange={setImages}
                onVideoChange={setVideo}
                onGenerate={handleGenerate}
                onCancelSubmission={cancelSubmission}
              />
            ) : (
              <StillImagesSettingsPanel
                selectedCategoryId={stillImagesForm.selectedCategoryId}
                category={stillImagesForm.selectedCategory}
                state={selectedStillImageState}
                selectedProject={selectedProject}
                targetFolderId={stillImagesForm.targetFolderId}
                saveNumber={stillImagesForm.saveNumber}
                onCategoryChange={stillImagesForm.setSelectedCategoryId}
                onImagesChange={stillImagesForm.setImages}
                onMaskChange={stillImagesForm.setMask}
                onPromptChange={stillImagesForm.setPrompt}
                onSeedChange={stillImagesForm.setSeed}
                onSettingChange={stillImagesForm.setSetting}
                onTargetFolderChange={stillImagesForm.setTargetFolderId}
                onSaveNumberChange={stillImagesForm.setSaveNumber}
                onGenerate={handleStillImagesGenerate}
                onNewEditLayer={stillImagesForm.startNewEditLayer}
                onSelectEditLayer={stillImagesForm.selectEditLayer}
                onEditTargetChange={stillImagesForm.setEditTarget}
                onToggleEditLayer={stillImagesForm.toggleEditLayer}
                onDeleteEditLayer={stillImagesForm.deleteEditLayer}
                onDuplicateEditLayer={stillImagesForm.duplicateEditLayer}
                onMoveEditLayer={stillImagesForm.moveEditLayer}
                onMoveEditLayerBy={stillImagesForm.moveEditLayerBy}
                onRenameEditLayer={stillImagesForm.renameEditLayer}
                onEditLayerOpacityChange={stillImagesForm.setEditLayerOpacity}
                onEditLayerMaskFeatherChange={stillImagesForm.setEditLayerMaskFeather}
                onEditLayerMaskEnabledChange={stillImagesForm.setEditLayerMaskEnabled}
                onEditLayerMaskLinkedChange={stillImagesForm.setEditLayerMaskLinked}
                onResetEditLayerOffset={stillImagesForm.resetEditLayerOffset}
                onEditModeChange={stillImagesForm.setEditMode}
                onEditEnhanceSettingChange={stillImagesForm.setEditEnhanceSetting}
                onEditReferencesChange={stillImagesForm.setEditReferences}
                onFinishEditing={handleFinishStillImageEdit}
                finishingEdit={finishingStillImageEdit}
                openEditorRequest={stillImageEditorOpenRequest}
                submitting={stillImagesSubmission.submitting}
                submitError={stillImagesSubmission.error}
              />
            )}
          </div>
        }
        main={
          mainSection === "animation" ? (
            <JobFeed
              jobs={animationJobs}
              projects={projects}
              users={workspaceUsers}
              currentUserId={account.id}
              currentUserRole={account.role}
              selectedProjectId={selectedProjectId}
              selectedFolderId={selectedFolderId}
              archiveView={showArchivedJobs}
              favoriteJobIds={favoriteJobIds}
              onDownload={handleDownloadJobResult}
              onCopyImage={handleCopyJobImage}
              onReuseSettings={handleReuseJobSettings}
              onRetry={handleRetryJob}
              onCancel={handleCancelJob}
              canReuseSettings={(job) => canReuseJobSettings(job, models)}
              onToggleFavorite={handleToggleFavorite}
              onMove={handleMoveJobResult}
              onArchive={handleArchiveJob}
              onRestore={handleRestoreArchivedJob}
              onDeletePermanently={handlePermanentlyDeleteJob}
              onUpdateJobSaveNumber={handleUpdateJobSaveNumber}
              onToggleArchiveView={handleToggleArchivedView}
              totalJobs={backendAvailable ? backendJobsTotal : jobs.length}
              hasMoreJobs={hasMoreBackendJobs}
              isLoadingMoreJobs={isLoadingMoreJobs}
              onLoadMoreJobs={handleLoadMoreJobs}
            />
          ) : (
            <StillImagesWorkspace
              category={stillImagesForm.selectedCategory}
              state={selectedStillImageState}
              selectedProject={selectedProject}
              targetFolderId={stillImagesForm.targetFolderId}
              saveNumber={stillImagesForm.saveNumber}
              userName={account.name}
              jobs={stillImageJobs}
              users={workspaceUsers}
              currentUserId={account.id}
              projects={projects}
              archiveView={showArchivedJobs}
              onToggleArchiveView={handleToggleArchivedView}
              favoriteJobIds={favoriteJobIds}
              // Judged by the preset reader, not the Animation one: these jobs
              // carry no model, resolution or duration, which is most of what
              // canReuseJobSettings looks for.
              canReuseSettings={(job) => Boolean(reusableStillImageJob(job))}
              onUseAsInput={handleUseStillResultAsInput}
              onContinueEditing={(job) => void handleContinueEditingComposite(job)}
              canContinueEditing={canContinueEditingComposite}
              reopeningEditDocument={reopeningEditDocument}
              onDownload={handleDownloadJobResult}
              onCopyImage={handleCopyJobImage}
              onReuseSettings={handleReuseJobSettings}
              onRetry={handleRetryJob}
              onCancel={handleCancelJob}
              onToggleFavorite={handleToggleFavorite}
              onMove={handleMoveJobResult}
              onArchive={handleArchiveJob}
              onRestore={handleRestoreArchivedJob}
              onDeletePermanently={handlePermanentlyDeleteJob}
            />
          )
        }
        right={
          <div className="space-y-3">
            <PodStatusIndicator status={podStatus} />
            <CreditUsageDashboard
              creditsRemaining={creditsRemaining}
              monthlyCreditsSpent={creditDashboardMonthUsage.creditsSpent}
              monthlyCreditsLabel={account.role === "admin" ? "workspace this month" : "spent this month"}
            />
            <AccountPanel
              account={account}
              users={workspaceAccounts}
              jobs={jobs}
              creditsRemaining={creditsRemaining}
              monthlyCreditsSpent={currentMonthUsage.creditsSpent}
              monthlyJobsCompleted={currentMonthUsage.jobsCompleted}
              onUpdateProfile={handleUpdateProfile}
              onChangePassword={handleChangePassword}
              onCreateUser={handleCreateUser}
              onUpdateUser={handleUpdateUser}
              onResetUserPassword={handleResetUserPassword}
              onToggleUserActive={handleToggleUserActive}
              onLogout={handleLogout}
              theme={theme}
              onThemeToggle={handleThemeToggle}
            />
            <RightProjectPanel
              projects={projects}
              users={workspaceUsers}
              ownerId={account.id}
              currentUserRole={account.role}
              selectedProjectId={selectedProjectId}
              selectedFolderId={selectedFolderId}
              pinnedProjectIds={account.pinnedProjectIds ?? []}
              onSelectProject={setSelectedProjectId}
              onSelectFolder={handleSelectFolder}
              onToggleProjectPin={handleToggleProjectPin}
              onCreateProject={handleCreateProject}
              onUpdateProject={handleUpdateProject}
              onAddProjectMember={handleAddProjectMember}
              onRemoveProjectMember={handleRemoveProjectMember}
              onCreateProjectFolder={handleCreateProjectFolder}
              onRenameProjectFolder={handleRenameProjectFolder}
              onDeleteProjectFolder={handleDeleteProjectFolder}
            />
          </div>
        }
      />
      {downloadChoiceJob ? (
        <DownloadImageChoiceModal job={downloadChoiceJob} onChoose={handleDownloadChoice} onClose={closeDownloadChoice} />
      ) : null}
      {confirmDialog ? (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          tone={confirmDialog.tone}
          onConfirm={() => {
            const action = confirmDialog.onConfirm;
            setConfirmDialog(null);
            action();
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default App;
