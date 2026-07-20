import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { AccountPanel } from "./components/AccountPanel";
import { defaultArchVizGridOptions } from "./components/ArchVizGridControls";
import { AuthScreen } from "./components/AuthScreen";
import { ComfyPoolManager } from "./components/ComfyPoolManager";
import { CreditUsageDashboard } from "./components/CreditUsageDashboard";
import { DownloadImageChoiceModal, type ImageDownloadFormat } from "./components/DownloadImageChoiceModal";
import { JobFeed } from "./components/JobFeed";
import { Layout } from "./components/Layout";
import { LeftSettingsPanel } from "./components/LeftSettingsPanel";
import { PodStatusIndicator } from "./components/PodStatusIndicator";
import { RightProjectPanel } from "./components/RightProjectPanel";
import type { ThemeMode } from "./components/ThemeToggle";
import { initialJobs, initialProjects, modelTypes, teams, users } from "./data/mockData";
import {
  type AuthResult,
  type AuthUser,
  type BackendJobsPage,
  type BackendRuntime,
  type ComfyPoolAction,
  type ComfyPoolActionResult,
  type ComfyServer,
  type PodStatusResponse,
  backendResultFileUrl,
  archiveBackendJob,
  changeBackendPassword,
  clearStoredAuthToken,
  createBackendProjectFolder,
  createBackendJob,
  createBackendProject,
  createBackendUser,
  deleteBackendProjectFolder,
  fetchBackendCredits,
  fetchBackendJobs,
  fetchBackendModels,
  fetchBackendMonthlyUsage,
  fetchBackendProjects,
  fetchBackendRuntime,
  fetchBackendUsers,
  fetchComfyServers,
  fetchCurrentAccount,
  fetchPodStatus,
  getStoredAuthToken,
  logoutBackend,
  moveBackendJobResult,
  permanentlyDeleteBackendJob,
  resetBackendUserPassword,
  renameBackendProjectFolder,
  restoreBackendJob,
  runComfyPoolAction,
  updateBackendJobSaveNumber,
  setBackendUserActive,
  signInBackend,
  updateBackendPinnedProjects,
  updateBackendProfile,
  updateBackendProject,
  updateBackendUser,
  uploadBackendMedia,
} from "./services/backendApi";
import { isSeedanceWorkflowModel, klingPromptOverflowCharacters, KLING_PROMPT_CHARACTER_LIMIT } from "./services/promptRules";
import type { ArchVizGridOptions, Job, ModelType, Project, UploadedImage, UploadedVideo, WorkflowOptions } from "./types";
import { estimateModelCreditLabel, estimateModelCredits } from "./utils/creditEstimator";
import { getImageSize } from "./utils/imageCrop";
import { createClientId } from "./utils/id";

const JOB_PAGE_SIZE = 30;
const ALL_PROJECTS_ID = "all";
const GENERATION_SETTINGS_STORAGE_KEY = "momi_generation_settings_v1";
const FAVORITE_JOB_IDS_STORAGE_KEY = "momi_favorite_job_ids_v1";
const THEME_STORAGE_KEY = "momi_theme_v1";

type PersistedGenerationSettings = {
  selectedModelId?: string;
  selectedResolution?: string;
  selectedDurationSeconds?: number;
  selectedProjectId?: string;
  targetFolderId?: string;
  prompt?: string;
  saveNumber?: string;
  imageOutputCount?: 1 | 2;
  nanoBananaOutputCount?: 1 | 2;
  selectedNanoBananaAspectRatio?: string;
};

function App() {
  const [initialSettings] = useState(readPersistedGenerationSettings);
  const [account, setAccount] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaceAccounts, setWorkspaceAccounts] = useState<AuthUser[]>([]);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [backendJobsTotal, setBackendJobsTotal] = useState(initialJobs.length);
  const [backendJobsOffset, setBackendJobsOffset] = useState(0);
  const [isLoadingMoreJobs, setIsLoadingMoreJobs] = useState(false);
  const [showArchivedJobs, setShowArchivedJobs] = useState(false);
  const [models, setModels] = useState(modelTypes);
  const [backendCreditsRemaining, setBackendCreditsRemaining] = useState<number | null>(null);
  const [monthlyUsageByUser, setMonthlyUsageByUser] = useState<Record<string, { creditsSpent: number; jobsCompleted: number }>>({});
  const [backendRuntime, setBackendRuntime] = useState<BackendRuntime | undefined>();
  const [comfyServers, setComfyServers] = useState<ComfyServer[]>([]);
  const [podStatus, setPodStatus] = useState<PodStatusResponse | undefined>();
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [loadedWorkspaceAccountId, setLoadedWorkspaceAccountId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(initialSettings.selectedModelId ?? "google_veo");
  const [selectedResolution, setSelectedResolution] = useState(initialSettings.selectedResolution ?? "1080p");
  const [selectedNanoBananaAspectRatio, setSelectedNanoBananaAspectRatio] = useState(normalizeNanoBananaAspectRatio(initialSettings.selectedNanoBananaAspectRatio));
  const [selectedDurationSeconds, setSelectedDurationSeconds] = useState(initialSettings.selectedDurationSeconds ?? 8);
  const [selectedProjectId, setSelectedProjectId] = useState(initialSettings.selectedProjectId ?? ALL_PROJECTS_ID);
  const [selectedFolderId, setSelectedFolderId] = useState<"all" | "root" | string>("all");
  const [targetFolderId, setTargetFolderId] = useState(initialSettings.targetFolderId ?? "");
  const [prompt, setPrompt] = useState(initialSettings.prompt ?? "");
  const [archVizGridOptions, setArchVizGridOptions] = useState<ArchVizGridOptions>(defaultArchVizGridOptions);
  const [saveNumber, setSaveNumber] = useState(normalizeSaveNumber(initialSettings.saveNumber));
  const [imageOutputCount, setImageOutputCount] = useState<1 | 2>(initialSettings.imageOutputCount ?? initialSettings.nanoBananaOutputCount ?? 1);
  const [enableImageToVideo16By9Cropping, setEnableImageToVideo16By9Cropping] = useState(true);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [video, setVideo] = useState<UploadedVideo | undefined>();
  const [favoriteJobIds, setFavoriteJobIds] = useState(readFavoriteJobIds);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(readPersistedTheme);
  const [downloadChoiceJob, setDownloadChoiceJob] = useState<Job | null>(null);

  useEffect(() => {
    let mounted = true;

    async function bootAuth() {
      try {
        const sessionAccount = await fetchCurrentAccount();
        if (!mounted) return;
        setAccount(sessionAccount);
        setWorkspaceAccounts([sessionAccount]);
      } catch {
        if (!mounted) return;
        clearStoredAuthToken();
        setAccount(null);
      } finally {
        if (mounted) setAuthLoading(false);
      }
    }

    void bootAuth();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    writePersistedTheme(theme);
  }, [theme]);

  const selectedModelBase = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0] ?? modelTypes[0],
    [models, selectedModelId],
  );
  const selectedModel = useMemo(
    () => ({
      ...selectedModelBase,
      cost: estimateModelCredits(selectedModelBase, selectedDurationSeconds, selectedResolution, imageOutputCount),
      costLabel: estimateModelCreditLabel(selectedModelBase, selectedDurationSeconds, selectedResolution, imageOutputCount),
    }),
    [imageOutputCount, selectedDurationSeconds, selectedModelBase, selectedResolution],
  );
  const workspaceUsers = useMemo(() => {
    if (!account) return workspaceAccounts.length ? workspaceAccounts : users;
    const byId = new Map([...workspaceAccounts, account].map((user) => [user.id, user]));
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [account, workspaceAccounts]);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const allowSeedance4K = account?.role === "admin";
  const creditsRemaining = backendCreditsRemaining ?? 0;
  const currentMonthUsage = account
    ? monthlyUsageByUser[account.id] ?? getMonthlyUsageForUser(jobs, account.id)
    : { creditsSpent: 0, jobsCompleted: 0 };
  const creditDashboardMonthUsage = account?.role === "admin"
    ? getWorkspaceMonthlyUsage(monthlyUsageByUser, jobs)
    : currentMonthUsage;
  const requiredImages = imageSlotCountForModel(selectedModel);
  const minimumRequiredImages = minimumImageCountForModel(selectedModel);
  const uploadedImages = images.slice(0, requiredImages).filter(Boolean);
  const selectedModelIsImageToVideo = isImageToVideoModel(selectedModel);
  const use16By9Cropping = !selectedModelIsImageToVideo || enableImageToVideo16By9Cropping;
  const disabledReason = getDisabledReason({
    isDemoAccount: Boolean(account && isDemoAccount(account)),
    insufficientCredits: creditsRemaining < selectedModel.cost,
    selectedProjectId,
    selectedProject,
    hasMissingImages: uploadedImages.length < minimumRequiredImages,
    hasMissingVideo: Boolean(selectedModel.requiresVideo && !video),
    hasCropIssues: Boolean(selectedModel.requiresLandscape && use16By9Cropping && uploadedImages.some((image) => image.cropRequired)),
    hasMissingPrompt: selectedModel.requiresPrompt !== false && !prompt.trim(),
    promptOverflowCharacters: klingPromptOverflowCharacters(selectedModel, prompt),
    requiredImages: minimumRequiredImages,
  });
  const hasMoreBackendJobs = backendAvailable && backendJobsOffset < backendJobsTotal;

  useEffect(() => {
    setSelectedFolderId("all");
    setTargetFolderId("");
  }, [selectedProjectId]);

  useEffect(() => {
    const folderIds = new Set((selectedProject?.folders ?? []).filter((folder) => !folder.archived).map((folder) => folder.folderId));
    if (targetFolderId && !folderIds.has(targetFolderId)) {
      setTargetFolderId("");
    }
    if (selectedFolderId !== "all" && selectedFolderId !== "root" && !folderIds.has(selectedFolderId)) {
      setSelectedFolderId("all");
    }
  }, [selectedFolderId, selectedProject, targetFolderId]);

  useEffect(() => {
    setSelectedDurationSeconds((current) => normalizeDurationSeconds(current, selectedModel));
    setSelectedResolution((current) => normalizeResolutionForModel(current, selectedModel, allowSeedance4K));
  }, [allowSeedance4K, selectedModel]);

  useEffect(() => {
    if (!supportsImageOutputCount(selectedModelBase)) {
      setImageOutputCount(1);
    }
  }, [selectedModelBase.id]);

  useEffect(() => {
    writePersistedGenerationSettings({
      selectedModelId,
      selectedResolution,
      selectedNanoBananaAspectRatio,
      selectedDurationSeconds,
      selectedProjectId,
      targetFolderId,
      prompt,
      saveNumber,
      imageOutputCount,
    });
  }, [imageOutputCount, prompt, saveNumber, selectedDurationSeconds, selectedModelId, selectedNanoBananaAspectRatio, selectedProjectId, selectedResolution, targetFolderId]);

  useEffect(() => {
    writeFavoriteJobIds(favoriteJobIds);
  }, [favoriteJobIds]);

  useEffect(() => {
    if (!account) {
      setLoadedWorkspaceAccountId(null);
      setPodStatus(undefined);
      return;
    }
    const accountId = account.id;
    let mounted = true;

    async function loadBackendData() {
      let shouldMarkWorkspaceLoaded = true;
      try {
        const [backendModels, backendProjects, backendJobsPage, credits, monthlyUsage, backendUsers, runtime] = await Promise.all([
          fetchBackendModels(),
          fetchBackendProjects(),
          fetchBackendJobs(jobPageParams(selectedProjectId, selectedFolderId, 0, showArchivedJobs)),
          fetchBackendCredits(),
          fetchBackendMonthlyUsage(),
          fetchBackendUsers(),
          fetchBackendRuntime(),
        ]);
        const servers = runtime.localComfyEnabled ? await fetchComfyServers() : [];
        if (!mounted) return;
        setBackendAvailable(true);
        setBackendRuntime(runtime);
        if (backendModels.length) {
          setModels(backendModels);
          setSelectedModelId((current) => (backendModels.some((model) => model.id === current) ? current : backendModels[0].id));
        }
        if (backendProjects.length) {
          setProjects(backendProjects);
          setSelectedProjectId((current) =>
            current === ALL_PROJECTS_ID || backendProjects.some((project) => project.id === current) ? current : ALL_PROJECTS_ID,
          );
        }
        applyBackendJobsPage(backendJobsPage, true);
        if (typeof credits.creditsLeft === "number") setBackendCreditsRemaining(Math.floor(credits.creditsLeft));
        setMonthlyUsageByUser(mapMonthlyUsageByUser(monthlyUsage.users));
        setComfyServers(servers);
        setWorkspaceAccounts(backendUsers);
        void fetchPodStatus().then(setPodStatus).catch(() => undefined);
      } catch (error) {
        if (!mounted) return;
        if (error instanceof Error && error.message.includes("Authentication required")) {
          shouldMarkWorkspaceLoaded = false;
          clearStoredAuthToken();
          setAccount(null);
          setLoadedWorkspaceAccountId(null);
          return;
        }
        setBackendAvailable(false);
      } finally {
        if (mounted && shouldMarkWorkspaceLoaded) {
          setLoadedWorkspaceAccountId(accountId);
        }
      }
    }

    void loadBackendData();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void fetchBackendJobs(jobPageParams(selectedProjectId, selectedFolderId, 0, showArchivedJobs)).then((page) => {
        setBackendAvailable(true);
        applyBackendJobsPage(page);
      }).catch(() => setBackendAvailable(false));
      void fetchBackendCredits().then((credits) => {
        if (typeof credits.creditsLeft === "number") setBackendCreditsRemaining(Math.floor(credits.creditsLeft));
      }).catch(() => undefined);
      void fetchBackendMonthlyUsage().then((usage) => setMonthlyUsageByUser(mapMonthlyUsageByUser(usage.users))).catch(() => undefined);
      void fetchBackendRuntime().then((runtime) => {
        setBackendRuntime(runtime);
        if (!runtime.localComfyEnabled) setComfyServers([]);
        if (runtime.localComfyEnabled) void fetchComfyServers().then(setComfyServers).catch(() => undefined);
      }).catch(() => undefined);
      void fetchPodStatus().then(setPodStatus).catch(() => undefined);
      void fetchBackendUsers().then(setWorkspaceAccounts).catch(() => undefined);
      void fetchBackendProjects().then((backendProjects) => {
        setProjects(backendProjects);
        setSelectedProjectId((current) =>
          current === ALL_PROJECTS_ID || backendProjects.some((project) => project.id === current) ? current : ALL_PROJECTS_ID,
        );
      }).catch(() => undefined);
    }, 12000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [account, selectedFolderId, selectedProjectId, showArchivedJobs]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function applyBackendJobsPage(page: BackendJobsPage, reset = false) {
    setJobs((current) => reset ? page.jobs : mergeJobs(page.jobs, current));
    setBackendJobsTotal(page.total);
    setBackendJobsOffset((current) => {
      const pageEnd = page.offset + page.jobs.length;
      return reset ? pageEnd : Math.max(current, pageEnd);
    });
  }

  async function refreshComfyServers() {
    if (!backendRuntime?.localComfyEnabled) {
      setComfyServers([]);
      return;
    }
    const servers = await fetchComfyServers();
    setComfyServers(servers);
  }

  async function handleComfyPoolAction(action: ComfyPoolAction, port?: number): Promise<ComfyPoolActionResult> {
    const result = await runComfyPoolAction(action, port);
    showToast(result.message);
    void refreshComfyServers().catch(() => undefined);
    return result;
  }

  async function handleSignIn(email: string, password: string): Promise<AuthResult> {
    const result = await signInBackend(email, password);
    if (result.ok) {
      setAccount(result.account);
      setWorkspaceAccounts((current) => mergeUsers([result.account], current));
      showToast("Signed in.");
    }
    return result;
  }

  async function handleLogout() {
    await logoutBackend();
    setAccount(null);
    setLoadedWorkspaceAccountId(null);
    showToast("Signed out.");
  }

  async function handleUpdateProfile(updates: Pick<AuthUser, "name" | "avatarColor"> & { profileImageUrl?: string }): Promise<AuthResult> {
    if (!account) return { ok: false, error: "Sign in first." };
    const result = await updateBackendProfile(updates);
    if (result.ok) {
      setAccount(result.account);
      setWorkspaceAccounts((current) => mergeUsers([result.account], current));
      showToast("Profile saved.");
    }
    return result;
  }

  async function handleToggleProjectPin(projectId: string) {
    if (!account) return;
    const currentPins = account.pinnedProjectIds ?? [];
    const nextPins = currentPins.includes(projectId)
      ? currentPins.filter((item) => item !== projectId)
      : [projectId, ...currentPins];
    const optimisticAccount = { ...account, pinnedProjectIds: nextPins };

    setAccount(optimisticAccount);
    setWorkspaceAccounts((current) => mergeUsers([optimisticAccount], current));

    const result = await updateBackendPinnedProjects(nextPins);
    if (result.ok) {
      setAccount(result.account);
      setWorkspaceAccounts((current) => mergeUsers([result.account], current));
      showToast(nextPins.includes(projectId) ? "Project pinned." : "Project unpinned.");
      return;
    }

    setAccount(account);
    setWorkspaceAccounts((current) => mergeUsers([account], current));
    showToast(result.error);
  }

  async function handleChangePassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<AuthResult> {
    if (!account) return { ok: false, error: "Sign in first." };
    const result = await changeBackendPassword(currentPassword, newPassword, confirmPassword);
    if (result.ok) {
      setAccount(null);
      showToast("Password changed. Sign in again.");
    }
    return result;
  }

  async function handleCreateUser(payload: {
    name: string;
    email: string;
    username?: string;
    password: string;
    role: "admin" | "user";
    active?: boolean;
  }) {
    const user = await createBackendUser(payload);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    showToast("User created.");
    return user;
  }

  async function handleUpdateUser(
    userId: string,
    payload: Partial<Pick<AuthUser, "name" | "email" | "role" | "active" | "avatarColor">>,
  ) {
    const user = await updateBackendUser(userId, payload);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    if (account?.id === user.id) setAccount(user);
    showToast("User saved.");
    return user;
  }

  async function handleResetUserPassword(userId: string, password: string, confirmPassword: string) {
    const user = await resetBackendUserPassword(userId, password, confirmPassword);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    showToast("Password reset.");
    return user;
  }

  async function handleToggleUserActive(userId: string, active: boolean) {
    const user = await setBackendUserActive(userId, active);
    setWorkspaceAccounts((current) => mergeUsers([user], current));
    showToast(active ? "User enabled." : "User disabled.");
    return user;
  }

  function handleModelChange(modelId: string) {
    const nextModel = models.find((model) => model.id === modelId);
    setSelectedModelId(modelId);
    if (nextModel) {
      setSelectedResolution((resolution) => normalizeResolutionForModel(resolution, nextModel, allowSeedance4K));
      setSelectedDurationSeconds(defaultDurationSecondsForModel(nextModel));
      if (supportsImageOutputCount(nextModel)) {
        setImageOutputCount(1);
      }
    }
    if (!nextModel?.requiresImage && !nextModel?.requiresTwoImages && !nextModel?.imageSlotCount) {
      setImages([]);
    } else {
      setImages((current) => current.slice(0, imageSlotCountForModel(nextModel)));
    }
    if (!nextModel?.requiresVideo) setVideo(undefined);
  }

  function handleResolutionChange(resolution: string) {
    setSelectedResolution(normalizeResolutionForModel(resolution, selectedModel, allowSeedance4K));
  }

  async function handleGenerate() {
    if (!account) {
      showToast("Sign in before generating.");
      return;
    }
    if (disabledReason) {
      showToast(disabledReason);
      return;
    }
    if (selectedProjectId === ALL_PROJECTS_ID || !selectedProject) {
      showToast("Please select a specific project before generating.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (backendAvailable || selectedModel.backendCategory || selectedModel.workflowPath) {
        const inputImages = await Promise.all(
          images
            .slice(0, requiredImages)
            .filter(Boolean)
            .map((image) => uploadJobMediaUrl(jobImageUrl(image, use16By9Cropping), {
              projectId: selectedProjectId,
              kind: "image",
              name: image.name,
            })),
        );
        const inputVideo = selectedModel.requiresVideo && video
          ? await uploadJobMediaUrl(video.url, {
            projectId: selectedProjectId,
            kind: "video",
            name: video.name,
          })
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
          workflowOptions: workflowOptionsForJob(selectedModel, archVizGridOptions, saveNumber, imageOutputCount, selectedNanoBananaAspectRatio),
        });
        setJobs((current) => mergeJobs([backendJob], current));
        setProjects((current) => incrementProjectJobCount(current, selectedProjectId));
        setBackendJobsTotal((current) => current + 1);
        setBackendJobsOffset((current) => current + 1);
        showToast(backendRuntime?.generationBackend === "local_comfy" ? "Job sent to the local ComfyUI backend." : "Job sent to RunPod serverless.");
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
      showToast(error instanceof Error ? `Backend unavailable: ${error.message}` : "Backend unavailable. Could not send job.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCreateProject(project: Project) {
    try {
      const created = backendAvailable ? await createBackendProject(project) : project;
      setProjects((current) => [created, ...current]);
      setSelectedProjectId(created.id);
      showToast("Project created.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create project.");
    }
  }

  async function handleUpdateProject(project: Project) {
    try {
      const updated = backendAvailable ? await updateBackendProject(project) : project;
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      showToast("Project saved.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update project.");
    }
  }

  async function handleCreateProjectFolder(projectId: string, name: string, parentId?: string | null) {
    try {
      if (backendAvailable) {
        const result = await createBackendProjectFolder(projectId, name, parentId);
        if (result.project) {
          setProjects((current) => current.map((item) => (item.id === result.project?.id ? result.project : item)));
        }
        setSelectedFolderId(result.folder.folderId);
        setTargetFolderId(result.folder.folderId);
        showToast("Folder created.");
        return;
      }

      const now = new Date().toISOString();
      const folderId = createClientId("fld_").slice(0, 12);
      const folder = {
        folderId,
        parentId: parentId ?? null,
        name: name.trim(),
        slug: slugify(name),
        diskName: `${folderId}_${slugify(name)}`,
        createdAt: now,
        updatedAt: now,
        createdBy: account?.id,
        updatedBy: account?.id,
        archived: false,
      };
      setProjects((current) => current.map((project) => (
        project.id === projectId ? { ...project, folders: [...(project.folders ?? []), folder] } : project
      )));
      setSelectedFolderId(folderId);
      setTargetFolderId(folderId);
      showToast("Folder created.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create folder.");
    }
  }

  async function handleRenameProjectFolder(projectId: string, folderId: string, name: string) {
    try {
      if (backendAvailable) {
        const result = await renameBackendProjectFolder(projectId, folderId, name);
        if (result.project) {
          setProjects((current) => current.map((item) => (item.id === result.project?.id ? result.project : item)));
        }
        showToast("Folder renamed.");
        return;
      }

      setProjects((current) => current.map((project) => (
        project.id === projectId
          ? {
              ...project,
              folders: (project.folders ?? []).map((folder) => (
                folder.folderId === folderId
                  ? { ...folder, name: name.trim(), slug: slugify(name), diskName: `${folder.folderId}_${slugify(name)}`, updatedAt: new Date().toISOString() }
                  : folder
              )),
            }
          : project
      )));
      showToast("Folder renamed.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not rename folder.");
    }
  }

  async function handleDeleteProjectFolder(projectId: string, folderId: string) {
    const project = projects.find((item) => item.id === projectId);
    const folder = project?.folders?.find((item) => item.folderId === folderId);
    if (!folder) return;
    if (!window.confirm(`Delete empty folder "${folder.name}"? Folders with media cannot be deleted.`)) {
      return;
    }

    try {
      if (backendAvailable) {
        const result = await deleteBackendProjectFolder(projectId, folderId);
        if (result.project) {
          setProjects((current) => current.map((item) => (item.id === result.project?.id ? result.project : item)));
        }
      } else {
        setProjects((current) => current.map((item) => (
          item.id === projectId
            ? { ...item, folders: (item.folders ?? []).map((entry) => entry.folderId === folderId ? { ...entry, archived: true } : entry) }
            : item
        )));
      }
      if (selectedFolderId === folderId) {
        setSelectedFolderId("all");
        setTargetFolderId("");
      }
      showToast("Folder deleted.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not delete folder.");
    }
  }

  function handleSelectFolder(folderId: "all" | "root" | string) {
    setSelectedFolderId(folderId);
    setTargetFolderId(folderId === "all" || folderId === "root" ? "" : folderId);
  }

  async function handleLoadMoreJobs() {
    if (!backendAvailable || isLoadingMoreJobs) return;
    setIsLoadingMoreJobs(true);
    try {
      const page = await fetchBackendJobs(jobPageParams(selectedProjectId, selectedFolderId, backendJobsOffset, showArchivedJobs));
      applyBackendJobsPage(page);
      showToast(page.jobs.length ? `Loaded ${page.jobs.length} more jobs.` : "No more jobs to load.");
    } catch {
      setBackendAvailable(false);
      showToast("Could not load more jobs from the backend.");
    } finally {
      setIsLoadingMoreJobs(false);
    }
  }

  async function handleDownloadJobResult(job: Job, resultIndex?: number, imageFormat?: ImageDownloadFormat) {
    if (isImageResult(job) && imageFormat == null) {
      setDownloadChoiceJob(job);
      return;
    }

    try {
      const blob = await fetchResultBlob(job, resultIndex ?? 0);
      const download = imageFormat ? await convertImageBlobForDownload(blob, imageFormat) : blob;
      downloadBlob(download, downloadNameForJob(job, download, resultIndex));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not download result.");
    }
  }

  async function handleCopyJobImage(job: Job) {
    try {
      const blob = await fetchResultBlob(job);
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        showToast("Clipboard image copy is not available in this browser.");
        return;
      }
      const imageBlob = await clipboardCompatibleImageBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ [imageBlob.type]: imageBlob })]);
      showToast("Copied image.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not copy image.");
    }
  }

  async function handleReuseJobSettings(job: Job) {
    if (!canReuseJobSettings(job, models)) {
      showToast("This result does not have reusable settings saved.");
      return;
    }

    showToast("Loading saved settings...");

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

  function handleToggleFavorite(job: Job) {
    setFavoriteJobIds((current) => {
      const next = new Set(current);
      if (next.has(job.id)) next.delete(job.id);
      else next.add(job.id);
      return next;
    });
  }

  function handleToggleArchivedView() {
    setShowArchivedJobs((current) => !current);
    setJobs([]);
    setBackendJobsOffset(0);
    setBackendJobsTotal(0);
  }

  async function handleMoveJobResult(job: Job, destinationFolderId: string | null) {
    const project = projects.find((item) => item.id === job.projectId);
    if (!project) {
      showToast("Project not found.");
      return false;
    }
    const destinationFolder = destinationFolderId
      ? project.folders?.find((folder) => folder.folderId === destinationFolderId && !folder.archived)
      : undefined;
    if (destinationFolderId && !destinationFolder) {
      showToast("Destination folder not found.");
      return false;
    }

    const optimisticJob: Job = {
      ...job,
      folderId: destinationFolderId,
      folderName: destinationFolder?.name ?? "Root",
    };
    const leavesSelectedFolder = selectedFolderId !== "all" && matchesFolder(job, selectedFolderId);
    setJobs((current) => current.map((item) => item.id === job.id ? optimisticJob : item));
    if (backendAvailable && leavesSelectedFolder) {
      setBackendJobsTotal((current) => Math.max(0, current - 1));
      setBackendJobsOffset((current) => Math.max(0, current - 1));
    }

    try {
      const updated = backendAvailable
        ? await moveBackendJobResult(job.projectId, job.id, destinationFolderId)
        : optimisticJob;
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      showToast(`Moved to ${destinationFolder?.name ?? "project root"}.`);
      return true;
    } catch (error) {
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
      if (backendAvailable && leavesSelectedFolder) {
        setBackendJobsTotal((current) => current + 1);
        setBackendJobsOffset((current) => current + 1);
      }
      showToast(error instanceof Error ? error.message : "Could not move result.");
      return false;
    }
  }

  async function handleArchiveJob(job: Job) {
    const previousJobs = jobs;
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setBackendJobsTotal((current) => Math.max(0, current - 1));
    try {
      if (backendAvailable) {
        await archiveBackendJob(job.id);
      }
      showToast("Moved to archive.");
    } catch (error) {
      setJobs(previousJobs);
      setBackendJobsTotal((current) => current + 1);
      showToast(error instanceof Error ? error.message : "Could not archive result.");
    }
  }

  async function handleRestoreArchivedJob(job: Job) {
    const previousJobs = jobs;
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setBackendJobsTotal((current) => Math.max(0, current - 1));
    try {
      if (backendAvailable) {
        await restoreBackendJob(job.id);
      }
      showToast("Restored to main results.");
    } catch (error) {
      setJobs(previousJobs);
      setBackendJobsTotal((current) => current + 1);
      showToast(error instanceof Error ? error.message : "Could not restore result.");
    }
  }

  async function handlePermanentlyDeleteJob(job: Job) {
    if (!window.confirm("Delete this archived item permanently from the app archive? The media files on disk are left untouched.")) {
      return;
    }
    const previousJobs = jobs;
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setBackendJobsTotal((current) => Math.max(0, current - 1));
    try {
      if (backendAvailable) {
        await permanentlyDeleteBackendJob(job.id);
      }
      showToast("Archived item permanently deleted.");
    } catch (error) {
      setJobs(previousJobs);
      setBackendJobsTotal((current) => current + 1);
      showToast(error instanceof Error ? error.message : "Could not delete archived item.");
    }
  }

  async function handleUpdateJobSaveNumber(job: Job, value: string) {
    try {
      const nextSaveNumber = normalizeRequiredSaveNumber(value);
      if (!nextSaveNumber) {
        showToast("Shot/camera number is required.");
        return;
      }
      const fallbackWorkflowOptions = workflowOptionsWithSaveNumber(job.workflowOptions, nextSaveNumber);
      const updated = backendAvailable
        ? await updateBackendJobSaveNumber(job.projectId, job.id, nextSaveNumber)
        : { ...job, workflowOptions: fallbackWorkflowOptions };
      setJobs((current) => current.map((item) => (
        item.id === job.id
          ? { ...item, workflowOptions: updated.workflowOptions ?? workflowOptionsWithSaveNumber(item.workflowOptions, nextSaveNumber) }
          : item
      )));
      showToast("Shot/camera updated.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update shot/camera.");
    }
  }

  function handleThemeToggle() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  if (authLoading) {
    return <WorkspaceLoadingScreen title="Opening workspace" message="Checking your session..." />;
  }

  if (!account) {
    return <AuthScreen onSignIn={handleSignIn} theme={theme} onThemeToggle={handleThemeToggle} />;
  }

  if (loadedWorkspaceAccountId !== account.id) {
    return <WorkspaceLoadingScreen title="Loading your workspace" message="Fetching projects, jobs, models, and credit usage..." accountName={account.name} />;
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
            show16By9CropToggle={selectedModelIsImageToVideo}
            images={images}
            video={video}
            creditsRemaining={creditsRemaining}
            disabledReason={disabledReason}
            isSubmitting={isSubmitting}
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
          />
        }
        main={
          <JobFeed
            jobs={jobs}
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
              teams={teams}
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
              onCreateProjectFolder={handleCreateProjectFolder}
              onRenameProjectFolder={handleRenameProjectFolder}
              onDeleteProjectFolder={handleDeleteProjectFolder}
            />
          </div>
        }
      />
      {downloadChoiceJob ? (
        <DownloadImageChoiceModal
          job={downloadChoiceJob}
          onChoose={(index, format) => {
            const job = downloadChoiceJob;
            setDownloadChoiceJob(null);
            void handleDownloadJobResult(job, index, format);
          }}
          onClose={() => setDownloadChoiceJob(null)}
        />
      ) : null}
      {toast ? <Toast message={toast} onDismiss={() => setToast("")} /> : null}
    </>
  );
}

function WorkspaceLoadingScreen({
  title,
  message,
  accountName,
}: {
  title: string;
  message: string;
  accountName?: string;
}) {
  return (
    <div className="grain flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-5 text-center shadow-2xl">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
        <p className="mt-4 text-sm font-bold text-ink">{title}</p>
        {accountName ? <p className="mt-1 truncate text-xs font-semibold text-stone-500">{accountName}</p> : null}
        <p className="mx-auto mt-3 max-w-xs text-xs leading-5 text-stone-500">{message}</p>
      </div>
    </div>
  );
}

type DisabledReasonInput = {
  isDemoAccount: boolean;
  insufficientCredits: boolean;
  selectedProjectId: string;
  selectedProject?: Project;
  hasMissingImages: boolean;
  hasMissingVideo: boolean;
  hasCropIssues: boolean;
  hasMissingPrompt: boolean;
  promptOverflowCharacters: number;
  requiredImages: number;
};

function getDisabledReason({
  isDemoAccount,
  insufficientCredits,
  selectedProjectId,
  selectedProject,
  hasMissingImages,
  hasMissingVideo,
  hasCropIssues,
  hasMissingPrompt,
  promptOverflowCharacters,
  requiredImages,
}: DisabledReasonInput) {
  if (isDemoAccount) return "Demo accounts are view-only and cannot generate tasks.";
  if (insufficientCredits) return "Insufficient credits.";
  if (selectedProjectId === ALL_PROJECTS_ID || !selectedProject) return "Please select a specific project before generating.";
  if (hasMissingPrompt) return "Add a prompt before generating.";
  if (promptOverflowCharacters > 0) {
    return `Kling prompts are limited to ${KLING_PROMPT_CHARACTER_LIMIT.toLocaleString()} characters. Shorten this prompt by ${promptOverflowCharacters.toLocaleString()} characters before generating.`;
  }
  if (hasMissingImages) {
    if (requiredImages === 2) return "Upload both required images.";
    if (requiredImages > 2) return `Upload all ${requiredImages} input images.`;
    return "Upload an input image.";
  }
  if (hasMissingVideo) return "Upload an input video.";
  if (hasCropIssues) return "Save the 16:9 crop before generating.";
  return undefined;
}

function canReuseJobSettings(job: Job, models: ModelType[]) {
  return Boolean(
    findReusableModel(job, models)
      || hasPromptMetadata(job)
      || hasKnownResolution(job)
      || (typeof job.durationSeconds === "number" && Number.isFinite(job.durationSeconds) && job.durationSeconds > 0)
      || hasReusableWorkflowOptions(job.workflowOptions)
      || (hasInputImageMetadata(job) && job.inputImages.length > 0)
      || hasInputVideoMetadata(job),
  );
}

function findReusableModel(job: Job, models: ModelType[]) {
  const modelId = normalizeModelText(job.modelId);
  if (modelId && modelId !== "existing project media") {
    const exactMatch = models.find((model) => normalizeModelText(model.id) === modelId);
    if (exactMatch) return exactMatch;
  }

  const jobWorkflowPath = job.workflowPath;
  if (jobWorkflowPath) {
    const workflowMatch = models.find((model) => Boolean(model.workflowPath && sameWorkflowPath(model.workflowPath, jobWorkflowPath)));
    if (workflowMatch) return workflowMatch;
  }

  const jobModelName = normalizeModelText(job.modelType);
  if (!jobModelName || jobModelName === "unknown model" || jobModelName === "missing model data") {
    return undefined;
  }

  return models.find((model) => {
    const label = normalizeModelText(model.label);
    const id = normalizeModelText(model.id);
    return label === jobModelName
      || id === jobModelName
      || (label.length > 4 && jobModelName.includes(label))
      || (jobModelName.length > 4 && label.includes(jobModelName));
  });
}

function sameWorkflowPath(left: string, right: string) {
  const normalizedLeft = normalizeWorkflowPath(left);
  const normalizedRight = normalizeWorkflowPath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight || workflowFileName(normalizedLeft) === workflowFileName(normalizedRight);
}

function normalizeWorkflowPath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase().trim();
}

function workflowFileName(value: string) {
  return value.split("/").filter(Boolean).pop() ?? value;
}

function normalizeModelText(value: unknown) {
  return typeof value === "string"
    ? value
        .replace(/^api\s+/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/[^a-z0-9.]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    : "";
}

function hasPromptMetadata(job: Job) {
  if (jobMissingMetadata(job, "prompt")) return false;
  if (job.source === "existing_project_media") {
    const prompt = job.prompt.trim().toLowerCase();
    return Boolean(prompt && prompt !== "missing prompt data");
  }
  return typeof job.prompt === "string";
}

function hasKnownResolution(job: Job) {
  const resolution = job.resolution.trim().toLowerCase();
  return Boolean(resolution && resolution !== "unknown");
}

function hasInputImageMetadata(job: Job) {
  if (job.source !== "existing_project_media") return true;
  return job.inputImages.length > 0 && !jobMissingMetadata(job, "original input image");
}

function hasInputVideoMetadata(job: Job) {
  return Boolean(job.inputVideo && !jobMissingMetadata(job, "original input video"));
}

function hasReusableWorkflowOptions(options: WorkflowOptions | undefined) {
  return Boolean(options?.archVizGrid || options?.save || options?.nanoBanana || options?.gptImage);
}

function jobMissingMetadata(job: Job, field: string) {
  const normalizedField = normalizeMetadataField(field);
  return Boolean(
    job.missingMetadata?.some((item) => {
      const normalizedItem = normalizeMetadataField(item);
      return normalizedItem === normalizedField || normalizedItem.includes(normalizedField) || normalizedField.includes(normalizedItem);
    }),
  );
}

function normalizeMetadataField(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeReusableArchVizGridOptions(value: unknown): ArchVizGridOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<ArchVizGridOptions>;
  const defaults = defaultArchVizGridOptions();
  const slotCount = isArchVizSlotCount(input.slotCount) ? input.slotCount : defaults.slotCount;
  const sourceSlots = Array.isArray(input.cameraSlots) ? input.cameraSlots : [];

  return {
    slotCount,
    useSmartDefaults: typeof input.useSmartDefaults === "boolean" ? input.useSmartDefaults : defaults.useSmartDefaults,
    cameraSlots: Array.from({ length: 9 }, (_, index) => {
      const value = sourceSlots[index];
      return typeof value === "string" && value.trim() ? value : defaults.cameraSlots[index] ?? "Professional regular archviz view";
    }),
  };
}

function isArchVizSlotCount(value: unknown): value is ArchVizGridOptions["slotCount"] {
  return value === "1" || value === "2" || value === "4" || value === "6" || value === "8" || value === "9";
}

function reusableSaveNumber(job: Job) {
  const save = job.workflowOptions?.save;
  if (!save) return undefined;
  const value = isVideoLikeJob(job) ? save.shotNumber ?? save.cameraNumber : save.cameraNumber ?? save.shotNumber;
  return value == null || String(value).trim() === "" ? undefined : value;
}

function reusableImageOutputCount(options: WorkflowOptions | undefined): 1 | 2 | undefined {
  const value = options?.gptImage?.outputCount ?? options?.nanoBanana?.outputCount;
  return value === 1 || value === 2 ? value : undefined;
}

function reusableNanoBananaAspectRatio(options: WorkflowOptions | undefined) {
  return typeof options?.nanoBanana?.aspectRatio === "string"
    ? normalizeNanoBananaAspectRatio(options.nanoBanana.aspectRatio)
    : undefined;
}

async function rehydrateJobInputImages(job: Job, slotCount: number) {
  const limit = slotCount > 0 ? slotCount : job.inputImages.length;
  const hydrated = await Promise.all(
    job.inputImages.slice(0, limit).map((url, index) => rehydrateUploadedImage(url, index).catch(() => undefined)),
  );
  const nextImages: UploadedImage[] = [];
  hydrated.forEach((image, index) => {
    if (image) nextImages[index] = image;
  });
  return nextImages;
}

async function rehydrateUploadedImage(url: string, index: number): Promise<UploadedImage> {
  const media = await rehydrateMediaUrl(url, "image");
  const size = await getImageSize(media.url).catch(() => undefined);
  return {
    id: createClientId("img_"),
    name: mediaNameFromUrl(url, `input-image-${index + 1}`, media.type, "image"),
    url: media.url,
    cropRequired: false,
    width: size?.width,
    height: size?.height,
  };
}

async function rehydrateJobInputVideo(url: string): Promise<UploadedVideo | undefined> {
  try {
    const media = await rehydrateMediaUrl(url, "video");
    return {
      id: createClientId("vid_"),
      name: mediaNameFromUrl(url, "input-video", media.type, "video"),
      url: media.url,
    };
  } catch {
    return undefined;
  }
}

async function rehydrateMediaUrl(url: string, expectedType: "image" | "video") {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return { url, type: mediaTypeFromDataUrl(url) };
  }

  const response = await fetch(url, mediaFetchInit(url));
  if (!response.ok) {
    throw new Error(`Could not read saved ${expectedType} (${response.status}).`);
  }

  const blob = await response.blob();
  if (blob.type && !blob.type.startsWith(`${expectedType}/`)) {
    throw new Error(`Saved input is not a ${expectedType}.`);
  }

  return {
    url: URL.createObjectURL(blob),
    type: blob.type,
  };
}

function mediaFetchInit(url: string): RequestInit {
  const token = getStoredAuthToken();
  if (!token || !isBackendApiUrl(url)) {
    return { credentials: "include" };
  }
  return {
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  };
}

function isBackendApiUrl(url: string) {
  try {
    return new URL(url, window.location.href).pathname.startsWith("/api/");
  } catch {
    return url.startsWith("/api/");
  }
}

function mediaTypeFromDataUrl(url: string) {
  return url.match(/^data:([^;,]+)/i)?.[1];
}

function mediaNameFromUrl(url: string, fallbackBase: string, type: string | undefined, expectedType: "image" | "video") {
  const fallback = `${fallbackBase}.${extensionForMediaType(type, expectedType)}`;
  if (url.startsWith("data:") || url.startsWith("blob:")) return fallback;

  try {
    const parsed = new URL(url, window.location.href);
    const pathLike = parsed.searchParams.get("path") ?? parsed.searchParams.get("filename") ?? parsed.pathname;
    const name = decodeURIComponent(pathLike.split(/[\\/]/).filter(Boolean).pop() ?? "");
    return sanitizeMediaName(name || fallback, fallback);
  } catch {
    return fallback;
  }
}

function sanitizeMediaName(name: string, fallback: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, " ").trim() || fallback;
}

function extensionForMediaType(type: string | undefined, expectedType: "image" | "video") {
  if (!type) return expectedType === "image" ? "png" : "mp4";
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("quicktime")) return "mov";
  return type.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || (expectedType === "image" ? "png" : "mp4");
}

function isVideoLikeJob(job: Pick<Job, "inputType" | "modelType" | "outputType" | "videoLength">) {
  const modelName = job.modelType.toLowerCase();
  return (
    job.outputType === "video" ||
    job.outputType === "sequence" ||
    Boolean(job.videoLength) ||
    job.inputType === "video" ||
    modelName.includes("video")
  );
}

function getMonthlyUsageForUser(jobs: Job[], userId?: string) {
  if (!userId) return { creditsSpent: 0, jobsCompleted: 0 };
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return jobs.reduce(
    (stats, job) => {
      if (job.userId !== userId || job.status !== "completed") return stats;
      const timestamp = new Date(job.completedAt ?? job.createdAt).getTime();
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) return stats;
      return {
        creditsSpent: roundCredits(stats.creditsSpent + (job.creditsUsed ?? 0)),
        jobsCompleted: stats.jobsCompleted + 1,
      };
    },
    { creditsSpent: 0, jobsCompleted: 0 },
  );
}

function getWorkspaceMonthlyUsage(
  monthlyUsageByUser: Record<string, { creditsSpent: number; jobsCompleted: number }>,
  jobs: Job[],
) {
  const usageRows = Object.values(monthlyUsageByUser);
  if (usageRows.length) {
    return usageRows.reduce(
      (stats, usage) => ({
        creditsSpent: roundCredits(stats.creditsSpent + usage.creditsSpent),
        jobsCompleted: stats.jobsCompleted + usage.jobsCompleted,
      }),
      { creditsSpent: 0, jobsCompleted: 0 },
    );
  }

  return getMonthlyUsageForJobs(jobs);
}

function getMonthlyUsageForJobs(jobs: Job[]) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return jobs.reduce(
    (stats, job) => {
      if (job.status !== "completed") return stats;
      const timestamp = new Date(job.completedAt ?? job.createdAt).getTime();
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) return stats;
      return {
        creditsSpent: roundCredits(stats.creditsSpent + (job.creditsUsed ?? 0)),
        jobsCompleted: stats.jobsCompleted + 1,
      };
    },
    { creditsSpent: 0, jobsCompleted: 0 },
  );
}

function mapMonthlyUsageByUser(usageUsers: Array<{ userId: string; creditsSpent: number; jobsCompleted: number }>) {
  return usageUsers.reduce<Record<string, { creditsSpent: number; jobsCompleted: number }>>((map, user) => {
    map[user.userId] = {
      creditsSpent: roundCredits(user.creditsSpent),
      jobsCompleted: user.jobsCompleted,
    };
    return map;
  }, {});
}

function mergeUsers(incoming: AuthUser[], existing: AuthUser[]) {
  const map = new Map<string, AuthUser>();
  for (const user of existing) map.set(user.id, user);
  for (const user of incoming) map.set(user.id, user);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeJobs(incoming: Job[], existing: Job[]) {
  const map = new Map<string, Job>();
  for (const job of incoming) map.set(job.id, job);
  for (const job of existing) {
    if (!map.has(job.id)) map.set(job.id, job);
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function incrementProjectJobCount(projects: Project[], projectId: string) {
  return projects.map((project) =>
    project.id === projectId
      ? { ...project, jobCount: project.jobCount + 1, unreadCount: (project.unreadCount ?? 0) + 1 }
      : project,
  );
}

function matchesFolder(job: Job, folderId: "all" | "root" | string) {
  if (folderId === "all") return true;
  if (folderId === "root") return !job.folderId;
  return job.folderId === folderId;
}

function jobPageParams(projectId: string, folderId: "all" | "root" | string, offset: number, archived = false) {
  return {
    limit: JOB_PAGE_SIZE,
    offset,
    projectId: projectId === ALL_PROJECTS_ID ? undefined : projectId,
    folderId: projectId === ALL_PROJECTS_ID || folderId === "all" ? undefined : folderId,
    archived,
  };
}

function parseResolution(value: string) {
  const normalized = normalizeResolutionLabel(value);
  if (normalized === "auto") return { width: 1024, height: 1024, label: normalized };
  if (normalized === "1K") return { width: 1024, height: 1024, label: normalized };
  if (normalized === "2K") return { width: 2048, height: 2048, label: normalized };
  if (normalized === "720p") return { width: 1280, height: 720, label: normalized };
  if (normalized === "1080p") return { width: 1920, height: 1080, label: normalized };
  if (normalized === "4K") return { width: 3840, height: 2160, label: normalized };
  const match = normalized.match(/^(\d+)\s*x\s*(\d+)$/i) ?? value.match(/(\d+)\s*x\s*(\d+)/i);
  return {
    width: match ? Number(match[1]) : 1920,
    height: match ? Number(match[2]) : 1080,
    label: normalized,
  };
}

function normalizeDurationSeconds(value: number | undefined, model: Pick<ModelType, "category" | "supportedDurations" | "defaultDurationSeconds">) {
  const options = model.category === "video" ? model.supportedDurations ?? [] : [];
  if (!options.length) return model.defaultDurationSeconds ?? 8;
  const fallback = model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds) ? model.defaultDurationSeconds : options[0];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (options.includes(value)) return value;
  return options.reduce((closest, option) => (Math.abs(option - value) < Math.abs(closest - value) ? option : closest), fallback);
}

function defaultDurationSecondsForModel(model: Pick<ModelType, "category" | "supportedDurations" | "defaultDurationSeconds">) {
  const options = model.category === "video" ? model.supportedDurations ?? [] : [];
  if (!options.length) return model.defaultDurationSeconds ?? 8;
  return model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds) ? model.defaultDurationSeconds : options[0];
}

const gptImageResolutionValues = [
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840",
];

const nanoBananaAspectRatioValues = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function normalizeNanoBananaAspectRatio(value: unknown) {
  return typeof value === "string" && nanoBananaAspectRatioValues.includes(value) ? value : "auto";
}

function normalizeExactResolutionValue(value: string) {
  const lower = value.toLowerCase().replace(/\s+/g, "");
  return gptImageResolutionValues.find((resolution) => resolution.toLowerCase() === lower);
}

function normalizeResolutionLabel(value: string) {
  const exact = normalizeExactResolutionValue(value);
  if (exact) return exact;
  return normalizeResolutionAlias(value);
}

function normalizeResolutionAlias(value: string) {
  const lower = value.toLowerCase().replace(/\s+/g, "");
  if (lower === "1k" || lower === "1024x1024") return "1K";
  if (lower === "2k" || lower === "2048x2048") return "2K";
  if (lower === "720p" || lower === "1280x720") return "720p";
  if (lower === "1080p" || lower === "1920x1080" || lower === "16:9landscape") return "1080p";
  if (lower === "4k" || lower === "3840x2160") return "4K";
  return "1080p";
}

function normalizeResolutionForModel(value: string, model: ModelType, allowSeedance4K: boolean) {
  const supported = model.supportedResolutions?.length ? model.supportedResolutions : ["720p", "1080p", "4K"];
  if (isSeedanceWorkflowModel(model) && !allowSeedance4K && normalizeResolutionAlias(value) === "4K") {
    return supported.find((resolution) => resolution.toLowerCase() === "1080p") ?? supported[0] ?? "1080p";
  }
  const exact = normalizeExactResolutionValue(value);
  if (exact && supported.some((resolution) => resolution.toLowerCase() === exact.toLowerCase())) return exact;
  const alias = normalizeResolutionAlias(value);
  if (supported.some((resolution) => resolution.toLowerCase() === alias.toLowerCase())) return alias;
  const normalized = normalizeResolutionLabel(value);
  if (supported.some((resolution) => resolution.toLowerCase() === normalized.toLowerCase())) return normalized;
  if (supported.some((resolution) => resolution.toLowerCase() === "auto")) return "auto";
  if (supported.some((resolution) => resolution.toLowerCase() === "1080p")) return "1080p";
  return supported[0] ?? "1080p";
}

function imageSlotCountForModel(model: Pick<ModelType, "requiresImage" | "requiresTwoImages" | "imageSlotCount"> | undefined) {
  if (!model) return 0;
  if (model.requiresTwoImages) return 2;
  if (typeof model.imageSlotCount === "number") return Math.max(0, model.imageSlotCount);
  return model.requiresImage ? 1 : 0;
}

function minimumImageCountForModel(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath" | "requiresImage" | "requiresTwoImages" | "imageSlotCount">) {
  if (supportsTextOnlyImageWorkflow(model)) return 0;
  if (model.requiresTwoImages) return 2;
  if (model.requiresImage || (model.imageSlotCount ?? 0) > 0) return 1;
  return 0;
}

function supportsTextOnlyImageWorkflow(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return (key.includes("nano") && key.includes("banana"))
    || (((key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid")));
}

function isArchVizGridModel(model: Pick<ModelType, "id" | "label" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("exteriorgrid") || key.includes("exterior grid");
}

function isImageToVideoModel(model: Pick<ModelType, "id" | "label" | "category" | "backendCategory" | "workflowPath">) {
  if (model.backendCategory) return model.backendCategory === "image_to_video";
  if (model.category !== "video") return false;
  const key = `${model.id} ${model.label ?? ""} ${model.workflowPath ?? ""}`.toLowerCase().replaceAll("\\", "/");
  return key.includes("/i2v/")
    || key.includes("image_to_video")
    || key.includes("image-to-video")
    || key.includes("image to video")
    || model.id === "video_generation"
    || model.id === "google_veo";
}

function workflowOptionsForJob(
  model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">,
  archVizGrid: ArchVizGridOptions,
  saveNumber: string,
  imageOutputCount: 1 | 2,
  nanoBananaAspectRatio: string,
): WorkflowOptions {
  const normalizedSaveNumber = normalizeSaveNumber(saveNumber);
  return {
    ...(isArchVizGridModel(model) ? { archVizGrid } : {}),
    ...(isNanoBananaModel(model) ? { nanoBanana: { aspectRatio: normalizeNanoBananaAspectRatio(nanoBananaAspectRatio), outputCount: imageOutputCount } } : {}),
    ...(isGptImageModel(model) ? { gptImage: { outputCount: imageOutputCount } } : {}),
    save: {
      cameraNumber: normalizedSaveNumber,
      shotNumber: normalizedSaveNumber,
    },
  };
}

function isNanoBananaModel(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("nano") && key.includes("banana");
}

function isGptImageModel(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  const key = `${model.id} ${model.label ?? ""} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return (key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid");
}

function supportsImageOutputCount(model: Pick<ModelType, "id" | "label" | "backendCategory" | "workflowPath">) {
  return isNanoBananaModel(model) || isGptImageModel(model);
}

function isDemoAccount(user: Pick<AuthUser, "email" | "username">) {
  const email = user.email.toLowerCase();
  const username = (user.username ?? "").toLowerCase();
  return email === "demo@brickvisual.com"
    || email === "momi.demo@brickvisual.com"
    || username === "demo"
    || username === "momi-demo";
}

function createLocalJob({
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
}: {
  account: AuthUser;
  selectedModel: ModelType;
  selectedProjectId: string;
  prompt: string;
  selectedResolution: string;
  selectedDurationSeconds: number;
  images: UploadedImage[];
  video?: UploadedVideo;
  archVizGridOptions: ArchVizGridOptions;
  saveNumber: string;
  imageOutputCount: 1 | 2;
  selectedNanoBananaAspectRatio: string;
  use16By9Cropping: boolean;
  requiredImages: number;
}): Job {
  const inputImages = images.slice(0, requiredImages).filter(Boolean).map((image) => jobImageUrl(image, use16By9Cropping));
  const resultUrl = inputImages[0] ?? "https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1180&q=90";
  return {
    id: createClientId("job_").slice(0, 28),
    projectId: selectedProjectId,
    userId: account.id,
    modelId: selectedModel.id,
    modelType: selectedModel.label,
    backendCategory: selectedModel.backendCategory,
    workflowPath: selectedModel.workflowPath,
    inputType: selectedModel.requiresVideo
      ? "video"
      : !selectedModel.requiresImage && !selectedModel.requiresTwoImages
        ? "text_only"
        : selectedModel.requiresTwoImages
          ? "start_end_frames"
          : requiredImages > 1
            ? "multi_image"
            : "single_image",
    prompt: prompt.trim(),
    resolution: selectedResolution,
    durationSeconds: selectedModel.category === "video" ? selectedDurationSeconds : undefined,
    workflowOptions: workflowOptionsForJob(selectedModel, archVizGridOptions, saveNumber, imageOutputCount, selectedNanoBananaAspectRatio),
    status: "queued",
    inputImages,
    inputVideo: video?.url,
    resultUrl,
    resultUrls: [resultUrl],
    thumbnailUrl: resultUrl,
    thumbnailUrls: [resultUrl],
    outputType: selectedModel.category === "video" ? "video" : "image",
    videoLength: selectedModel.category === "video" ? `${selectedDurationSeconds} seconds` : undefined,
    creditsUsed: selectedModel.cost,
    createdAt: new Date().toISOString(),
  };
}

function jobImageUrl(image: UploadedImage, use16By9Cropping: boolean) {
  return use16By9Cropping ? image.croppedUrl ?? image.url : image.url;
}

function normalizeSaveNumber(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return (digits || "0000").padStart(4, "0");
}

function normalizeRequiredSaveNumber(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return digits ? digits.padStart(4, "0") : "";
}

function workflowOptionsWithSaveNumber(options: WorkflowOptions | undefined, saveNumber: string): WorkflowOptions {
  return {
    ...(options ?? {}),
    save: {
      ...(options?.save ?? {}),
      cameraNumber: saveNumber,
      shotNumber: saveNumber,
    },
  };
}

async function uploadJobMediaUrl(
  url: string,
  options: { projectId: string; kind: "image" | "video"; name?: string },
) {
  if (!url.startsWith("blob:") && !url.startsWith("data:")) return url;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not read ${options.kind} before upload.`);
  }

  const blob = await response.blob();
  return uploadBackendMedia(blob, options);
}

function readPersistedGenerationSettings(): PersistedGenerationSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GENERATION_SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedGenerationSettings>;
    return {
      selectedModelId: typeof parsed.selectedModelId === "string" ? parsed.selectedModelId : undefined,
      selectedResolution: typeof parsed.selectedResolution === "string" ? parsed.selectedResolution : undefined,
      selectedDurationSeconds:
        typeof parsed.selectedDurationSeconds === "number" && Number.isFinite(parsed.selectedDurationSeconds)
          ? parsed.selectedDurationSeconds
          : undefined,
      selectedProjectId: typeof parsed.selectedProjectId === "string" ? parsed.selectedProjectId : undefined,
      targetFolderId: typeof parsed.targetFolderId === "string" ? parsed.targetFolderId : undefined,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
      saveNumber: typeof parsed.saveNumber === "string" ? normalizeSaveNumber(parsed.saveNumber) : undefined,
      imageOutputCount: parsed.imageOutputCount === 2 || parsed.nanoBananaOutputCount === 2 ? 2 : 1,
      nanoBananaOutputCount: parsed.nanoBananaOutputCount === 2 ? 2 : undefined,
      selectedNanoBananaAspectRatio: normalizeNanoBananaAspectRatio(parsed.selectedNanoBananaAspectRatio),
    };
  } catch {
    return {};
  }
}

function writePersistedGenerationSettings(settings: PersistedGenerationSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GENERATION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

function readPersistedTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "dark" || raw === "light" ? raw : "light";
  } catch {
    return "light";
  }
}

function writePersistedTheme(theme: ThemeMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

function readFavoriteJobIds() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(FAVORITE_JOB_IDS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function writeFavoriteJobIds(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVORITE_JOB_IDS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}

function getPrimaryResultUrl(job: Job) {
  return job.resultUrls?.[0] ?? job.resultUrl ?? job.thumbnailUrls?.[0] ?? job.thumbnailUrl;
}

function isImageResult(job: Job) {
  return job.outputType === "image" || (!job.outputType && !job.videoLength);
}

function hasTwoImageDownloadChoices(job: Job) {
  const resultCount = job.resultUrls?.length ?? 0;
  return job.status === "completed" && isImageResult(job) && resultCount === 2;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "folder";
}

async function fetchResultBlob(job: Job, resultIndex = 0) {
  const fallbackUrl = job.resultUrls?.[resultIndex] ?? (resultIndex === 0 ? getPrimaryResultUrl(job) : undefined);
  const urls = [backendResultFileUrl(job.id, resultIndex), fallbackUrl].filter((url): url is string => Boolean(url));
  let lastError: unknown;
  for (const url of urls) {
    try {
      const token = getStoredAuthToken();
      const response = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error(`Could not read result file (${response.status}).`);
      return await response.blob();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not read result file.");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadNameForJob(job: Job, blob: Blob, resultIndex = 0) {
  const extension = extensionFromBlob(blob);
  const baseName = `${job.modelType || "result"}-${job.id}`.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  const imageSuffix = hasTwoImageDownloadChoices(job) ? `_image-${resultIndex + 1}` : "";
  return `${baseName}${imageSuffix}${extension}`;
}

function extensionFromBlob(blob: Blob) {
  if (blob.type.includes("jpeg")) return ".jpg";
  if (blob.type.includes("png")) return ".png";
  if (blob.type.includes("webp")) return ".webp";
  if (blob.type.includes("gif")) return ".gif";
  if (blob.type.includes("mp4")) return ".mp4";
  if (blob.type.includes("quicktime")) return ".mov";
  if (blob.type.includes("webm")) return ".webm";
  return ".bin";
}

async function convertImageBlobForDownload(blob: Blob, format: ImageDownloadFormat) {
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  if (format === "png" && blob.type === mimeType) return blob;

  return convertImageBlob(blob, mimeType, format === "jpg" ? 1 : undefined, format === "jpg");
}

async function clipboardCompatibleImageBlob(blob: Blob) {
  const clipboardTypeSupported = typeof ClipboardItem.supports === "function" ? ClipboardItem.supports(blob.type) : blob.type === "image/png";
  if (clipboardTypeSupported) return blob;
  return convertImageBlobToPng(blob);
}

function convertImageBlobToPng(blob: Blob) {
  return convertImageBlob(blob, "image/png", undefined, false, "Could not prepare image for clipboard.");
}

function convertImageBlob(
  blob: Blob,
  mimeType: "image/png" | "image/jpeg",
  quality?: number,
  fillWhite = false,
  errorMessage = "Could not prepare image download.",
) {
  return new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error(errorMessage));
        return;
      }
      if (fillWhite) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob((convertedBlob) => {
        URL.revokeObjectURL(url);
        if (!convertedBlob) {
          reject(new Error(errorMessage));
          return;
        }
        resolve(convertedBlob);
      }, mimeType, quality);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(errorMessage));
    };
    image.src = url;
  });
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="fixed bottom-4 left-1/2 z-[1100] flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-white px-4 py-3 text-sm font-semibold text-ink shadow-2xl">
      <CheckCircle2 className="h-5 w-5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100"
        title="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default App;
