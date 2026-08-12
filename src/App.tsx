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
  supportsImageOutputCount,
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
} from "./features/jobs/jobReuse";
import { useJobActions } from "./features/jobs/useJobActions";
import { useJobSubmission } from "./features/jobs/useJobSubmission";
import { readPersistedGenerationSettings } from "./features/preferences/appPreferences";
import { useTheme } from "./features/preferences/useTheme";
import { useNotifications } from "./features/notifications/useNotifications";
import { useProjectActions, type ConfirmDialogState } from "./features/projects/useProjectActions";
import { useWorkspaceData } from "./features/workspace/useWorkspaceData";
import { ALL_PROJECTS_ID, getMonthlyUsageForUser, getWorkspaceMonthlyUsage } from "./features/workspace/workspaceUtils";
import { isStillImageJob } from "./features/still-images/jobSection";
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
    setJobs,
    setProjects,
    setBackendJobsTotal,
    setBackendJobsOffset,
    showToast,
  });
  const stillImagesSubmission = useStillImagesSubmission({
    onJobCreated: (job) => {
      setJobs((current) => mergeJobs([job], current));
      setBackendJobsTotal((current) => current + 1);
      setBackendJobsOffset((current) => current + 1);
      showToast("Still image job queued.", "success");
    },
    onError: (message) => showToast(message, "error"),
  });
  const handleStillImagesGenerate = () => {
    if (!selectedProjectId) return;
    void stillImagesSubmission.submit({
      projectId: selectedProjectId,
      categoryId: stillImagesForm.selectedCategoryId,
      categoryState: stillImagesForm.selectedState,
      targetFolderId: stillImagesForm.targetFolderId,
      saveNumber: stillImagesForm.saveNumber,
    });
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

  async function handleReuseJobSettings(job: Job) {
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
                state={stillImagesForm.selectedState}
                selectedProject={selectedProject}
                targetFolderId={stillImagesForm.targetFolderId}
                saveNumber={stillImagesForm.saveNumber}
                onCategoryChange={stillImagesForm.setSelectedCategoryId}
                onImagesChange={stillImagesForm.setImages}
                onPromptChange={stillImagesForm.setPrompt}
                onSettingChange={stillImagesForm.setSetting}
                onTargetFolderChange={stillImagesForm.setTargetFolderId}
                onSaveNumberChange={stillImagesForm.setSaveNumber}
                onGenerate={handleStillImagesGenerate}
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
              state={stillImagesForm.selectedState}
              selectedProject={selectedProject}
              targetFolderId={stillImagesForm.targetFolderId}
              saveNumber={stillImagesForm.saveNumber}
              userName={account.name}
              jobs={stillImageJobs}
              users={workspaceUsers}
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
